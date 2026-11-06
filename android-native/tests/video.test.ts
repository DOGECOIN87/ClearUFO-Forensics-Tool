// The video demuxers: the AVI file that the app writes is read back with the demuxer of the app,
// and the MP4 demuxer is checked with a file that is built here.
import { describe, expect, it } from "vitest";

import { AviWriter } from "@/lib/codecs/avi";
import { MemoryByteSource } from "@/lib/codecs/byteSource";
import { MemorySink } from "@/lib/codecs/sink";
import { openAvi, parseAvi } from "@/lib/engine/sources/avi";
import { Mp4Source, parseMp4 } from "@/lib/engine/sources/mp4";

/** A frame as the AVI writer stores it: bottom-up rows of BGR, padded to four bytes. */
function dibFrame(w: number, h: number, seed: number): Uint8Array {
  const stride = (w * 3 + 3) & ~3;
  const out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    // a DIB stores the rows from the bottom to the top
    const row = h - 1 - y;
    for (let x = 0; x < w; x++) {
      out[row * stride + x * 3] = (x * 8 + seed) & 255; // blue
      out[row * stride + x * 3 + 1] = (y * 16 + seed) & 255; // green
      out[row * stride + x * 3 + 2] = (x + y + seed) & 255; // red
    }
  }
  return out;
}

async function writeAvi(w: number, h: number, frames: number, fps: number): Promise<Uint8Array> {
  const sink = new MemorySink();
  const writer = new AviWriter(sink, { width: w, height: h, fps, codec: "raw24" });
  await writer.begin();
  for (let i = 0; i < frames; i++) await writer.add(dibFrame(w, h, i));
  await writer.finish();
  return sink.close() as Promise<Uint8Array>;
}

describe("the AVI demuxer", () => {
  it("reads the file the app writes", async () => {
    const bytes = await writeAvi(16, 12, 3, 25);
    const parse = await parseAvi(new MemoryByteSource(bytes));
    expect(parse.width).toBe(16);
    expect(parse.height).toBe(12);
    expect(parse.fps).toBeCloseTo(25, 3);
    expect(parse.compression).toBe("BI_RGB");
    expect(parse.bitCount).toBe(24);
    expect(parse.frames.length).toBe(3);
    expect(parse.frames[0].size).toBe(AviWriter.rawFrameBytes(16, 12));
  });

  it("decodes the frames of an uncompressed AVI", async () => {
    const bytes = await writeAvi(8, 6, 2, 10);
    const opened = await openAvi("s1", new MemoryByteSource(bytes), "test.avi");
    expect(opened.kind).toBe("frames");
    if (opened.kind !== "frames") return;
    const provider = opened.provider;
    expect(provider.info.frameCount).toBe(2);
    expect(provider.info.width).toBe(8);
    expect(provider.info.height).toBe(6);
    expect(provider.info.fps).toBeCloseTo(10, 3);
    const frame = await provider.getFrame(0);
    expect(frame.w).toBe(8);
    expect(frame.h).toBe(6);
    // the first frame has the seed 0: the red channel is x + y
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 8; x++) {
        const o = (y * 8 + x) * 4;
        expect(frame.d[o]).toBe((x + y) & 255);
        expect(frame.d[o + 1]).toBe((y * 16) & 255);
        expect(frame.d[o + 2]).toBe((x * 8) & 255);
      }
    }
    // the metadata of the frames
    expect(provider.meta(1)).toMatchObject({ type: "I", key: true, pts: 0.1 });
  });

  it("refuses a file that is not an AVI", async () => {
    await expect(parseAvi(new MemoryByteSource(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])))).rejects.toThrow(/AVI/);
  });
});

// ---------------------------------------------------------------- a small MP4, built here
const box = (type: string, ...payload: Uint8Array[]): Uint8Array => {
  const body = payload.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(8 + body);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length);
  out.set(new TextEncoder().encode(type), 4);
  let o = 8;
  for (const p of payload) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const u32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v);
  return b;
};

const u16 = (v: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v);
  return b;
};

const full = (type: string, version: number, ...payload: Uint8Array[]) =>
  box(type, new Uint8Array([version, 0, 0, 0]), ...payload);

function buildMp4(frames: number, fps: number): Uint8Array {
  const timescale = 1000;
  const step = timescale / fps;
  const sizes = [1000, 800, 900, 700];
  // stsd: one avc1 entry with the size of the picture
  // a visual sample entry: 6 bytes reserved, the data reference index, 16 bytes of predefined
  // values, then the width and the height
  const avc1 = box("avc1", new Uint8Array(24), u16(320), u16(240), new Uint8Array(50));
  const stsd = full("stsd", 0, u32(1), avc1);
  // stts: every sample lasts "step" ticks
  const stts = full("stts", 0, u32(1), u32(frames), u32(step));
  // stss: the samples 1 and 3 are key frames
  const stss = full("stss", 0, u32(2), u32(1), u32(3));
  // stsc: every chunk holds two samples
  const stsc = full("stsc", 0, u32(1), u32(1), u32(2), u32(1));
  // stsz: the size of every sample
  const stsz = full("stsz", 0, u32(0), u32(frames), ...sizes.slice(0, frames).map(u32));
  // stco: the offset of every chunk (filled in below)
  const chunks = Math.ceil(frames / 2);
  const stco = full("stco", 0, u32(chunks), ...new Array(chunks).fill(0).map(() => u32(0)));
  const stbl = box("stbl", stsd, stts, stss, stsc, stsz, stco);
  const vmhd = full("vmhd", 0, u32(0), u32(0), u32(0), u32(0));
  const dref = full("dref", 0, u32(1), box("url ", new Uint8Array([1, 0, 0, 0])));
  const dinf = box("dinf", dref);
  const minf = box("minf", vmhd, dinf, stbl);
  const hdlr = full("hdlr", 0, u32(0), new TextEncoder().encode("vide"), u32(0), u32(0), u32(0), new TextEncoder().encode("v"));
  const mdhd = full("mdhd", 0, u32(0), u32(0), u32(timescale), u32(Math.round(step * frames)), u32(0));
  const mdia = box("mdia", mdhd, hdlr, minf);
  const tkhd = full("tkhd", 0, u32(0), u32(0), u32(1), u32(0), u32(Math.round(step * frames)), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), new Uint8Array(36), u32(320 << 16), u32(240 << 16));
  const trak = box("trak", tkhd, mdia);
  const mvhd = full("mvhd", 0, u32(0), u32(0), u32(timescale), u32(Math.round(step * frames)), u32(0x10000), u32(0x10000), u32(0), u32(0), new Uint8Array(80));
  const moov = box("moov", mvhd, trak);
  const ftyp = box("ftyp", new TextEncoder().encode("isom"), u32(512), new TextEncoder().encode("isomiso2avc1mp41"));
  const mdat = box("mdat", new Uint8Array(sizes.reduce((a, b) => a + b, 0)));
  const head = new Uint8Array(ftyp.length + moov.length);
  head.set(ftyp, 0);
  head.set(moov, ftyp.length);
  const dataAt = head.length + 8;
  const withOffset = new Uint8Array(head.length + mdat.length);
  withOffset.set(head, 0);
  withOffset.set(mdat, head.length);
  // the offsets of the chunks: the first sample of every chunk
  const stcoStart = head.length - stco.length;
  const dv = new DataView(withOffset.buffer);
  let at = dataAt;
  for (let c = 0; c < chunks; c++) {
    dv.setUint32(stcoStart + 16 + c * 4, at);
    at += sizes.slice(c * 2, c * 2 + 2).reduce((a, b) => a + b, 0);
  }
  return withOffset;
}

describe("the MP4 demuxer", () => {
  it("reads the frame table of the file", async () => {
    const bytes = buildMp4(4, 25);
    const parse = await parseMp4(new MemoryByteSource(bytes));
    expect(parse.brand).toBe("isom");
    expect(parse.codec).toBe("avc1");
    expect(parse.width).toBe(320);
    expect(parse.height).toBe(240);
    expect(parse.samples.length).toBe(4);
    expect(parse.samples[0].pts).toBeCloseTo(0, 5);
    expect(parse.samples[1].pts).toBeCloseTo(0.04, 5);
    expect(parse.samples[0].key).toBe(true);
    expect(parse.samples[1].key).toBe(false);
    // the samples are stored one after the other in the file
    expect(parse.samples[1].offset - parse.samples[0].offset).toBe(parse.samples[0].size);
    expect(parse.samples[2].offset - parse.samples[1].offset).toBe(parse.samples[1].size);
  });

  it("reports the codec instead of returning a wrong image", async () => {
    const bytes = buildMp4(2, 25);
    const source = new Mp4Source("s2", new MemoryByteSource(bytes), await parseMp4(new MemoryByteSource(bytes)));
    expect(source.info.frameCount).toBe(2);
    expect(source.info.codec).toBe("avc1");
    await expect(source.getFrame(0)).rejects.toThrow(/cannot be decoded/);
  });
});
