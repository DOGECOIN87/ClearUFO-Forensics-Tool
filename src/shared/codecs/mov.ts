// Uncompressed QuickTime (MOV): writer and reader.
// Writer: 16-bit RGB video ('b48r', 48 bits per pixel, big-endian, rows packed) plus optional audio as
// uncompressed 32-bit float PCM ('lpcm', SoundDescription v2). One video frame per chunk, the audio of that
// frame's time span in the chunk after it. The media data atom uses a 64-bit size and sample offsets are
// 64-bit ('co64'), so files can be any size; the movie atom goes at the end.
// Reader: the sample table of the video track (and the audio format) of uncompressed QuickTime files, for
// loading 'b48r', 'b64a', 'raw ' (24-bit RGB) and '2vuy' files without any decoder.
import type { ByteSink } from "./sink";

const enc = new TextEncoder();
const u8 = (...a: number[]) => new Uint8Array(a);
function be(n: number, bytes: number): Uint8Array {
  const o = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i--) { o[i] = n % 256; n = Math.floor(n / 256); }
  return o;
}
const u16 = (n: number) => be(n, 2), u32 = (n: number) => be(n >>> 0, 4), u64 = (n: number) => be(n, 8);
const f64 = (n: number) => { const o = new Uint8Array(8); new DataView(o.buffer).setFloat64(0, n); return o; };
const fourcc = (s: string) => enc.encode(s);
function cat(parts: Uint8Array[]): Uint8Array {
  let n = 0; for (const p of parts) n += p.length;
  const o = new Uint8Array(n); let k = 0;
  for (const p of parts) { o.set(p, k); k += p.length; }
  return o;
}
function atom(type: string, ...body: Uint8Array[]): Uint8Array { const b = cat(body); return cat([u32(8 + b.length), fourcc(type), b]); }
const full = (type: string, version: number, flags: number, ...body: Uint8Array[]) => atom(type, u8(version), be(flags, 3), ...body);
const pascal = (s: string, size: number) => { const o = new Uint8Array(size), b = enc.encode(s).subarray(0, size - 1); o[0] = b.length; o.set(b, 1); return o; };
const MATRIX = cat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);

/** Media time scale and per-frame duration that represent a frame rate exactly (25, 30000/1001, …). */
export function frameTiming(fps: number): { timescale: number; delta: number } {
  for (const den of [1, 1001]) {
    const num = fps * den;
    if (Math.abs(num - Math.round(num)) < 1e-6 * Math.max(1, num) && Math.round(num) > 0) return { timescale: Math.round(num), delta: den };
  }
  return { timescale: 1_000_000, delta: Math.max(1, Math.round(1_000_000 / fps)) };
}

export interface MovOptions { width: number; height: number; fps: number; audio?: { sampleRate: number; channels: number } | null }

export class MovWriter {
  private mdatAt = 0;
  private video: number[] = [];
  private audioChunks: { off: number; frames: number }[] = [];
  private audioFrames = 0;
  private finished = false;
  readonly frameBytes: number;

  constructor(private sink: ByteSink, private o: MovOptions) { this.frameBytes = o.width * o.height * 6; }

  /** Bytes of one 16-bit frame and of a whole file (without audio). */
  static frameBytes(w: number, h: number) { return w * h * 6; }
  static fileSize(w: number, h: number, frames: number): number {
    // ftyp + mdat header + samples + movie atom (fixed part + 8 bytes per co64 entry)
    return 20 + 16 + frames * w * h * 6 + MovWriter.moovBytes(frames, 0, 0);
  }
  private static moovBytes(frames: number, audioChunks: number, stscRuns: number): number {
    const videoTrak = 8 + 92 + 8 + 32 + 45 + 8 + 20 + 45 + 36 + 8 + (16 + 86) + 24 + 28 + 20 + (16 + 8 * frames);
    const audioTrak = audioChunks ? 8 + 92 + 8 + 32 + 45 + 8 + 16 + 45 + 36 + 8 + (16 + 72) + 24 + (16 + 12 * stscRuns) + 20 + (16 + 8 * audioChunks) : 0;
    return 8 + 108 + videoTrak + audioTrak;
  }

  async begin() {
    await this.sink.write(atom("ftyp", fourcc("qt  "), u32(0x20050300), fourcc("qt  ")));
    this.mdatAt = await this.sink.reserve(16);
  }

  /** One frame of 16-bit RGB samples, big-endian, rows top to bottom (w × h × 6 bytes). */
  async addVideo(rgb48be: Uint8Array) {
    if (rgb48be.length !== this.frameBytes) throw new Error(`A frame must be ${this.frameBytes} bytes, got ${rgb48be.length}`);
    this.video.push(this.sink.pos);
    await this.sink.write(rgb48be);
  }

  /** Interleaved 32-bit float samples (any number of frames, may be 0). */
  async addAudio(pcm: Float32Array) {
    const a = this.o.audio;
    if (!a) throw new Error("This file has no audio track");
    const frames = pcm.length / a.channels;
    if (!frames) return;
    const b = new Uint8Array(pcm.length * 4), dv = new DataView(b.buffer);
    for (let i = 0; i < pcm.length; i++) dv.setFloat32(i * 4, pcm[i], true);
    this.audioChunks.push({ off: this.sink.pos, frames });
    this.audioFrames += frames;
    await this.sink.write(b);
  }

  get audioFrameCount() { return this.audioFrames; }

  async finish() {
    if (this.finished) return;
    this.finished = true;
    const mdatSize = this.sink.pos - this.mdatAt;
    await this.sink.patch(this.mdatAt, cat([u32(1), fourcc("mdat"), u64(mdatSize)]));
    await this.sink.write(this.moov());
  }

  private moov(): Uint8Array {
    const { width: w, height: h, fps } = this.o;
    const n = this.video.length, MT = 1000;
    const vt = frameTiming(fps);
    const vDur = n * vt.delta;
    const a = this.o.audio && this.audioChunks.length ? this.o.audio : null;
    const movieDur = Math.round(Math.max(vDur / vt.timescale, a ? this.audioFrames / a.sampleRate : 0) * MT);
    const tkhd = (id: number, dur: number, audio: boolean) => full("tkhd", 0, 0xf, u32(0), u32(0), u32(id), u32(0), u32(dur), u32(0), u32(0), u16(0), u16(0), u16(audio ? 0x100 : 0), u16(0), MATRIX, u32(audio ? 0 : w * 65536), u32(audio ? 0 : h * 65536));
    const mdhd = (ts: number, dur: number) => full("mdhd", 0, 0, u32(0), u32(0), u32(ts), u32(dur), u16(0x55c4), u16(0));
    const hdlr = (ctype: string, sub: string, name: string) => full("hdlr", 0, 0, fourcc(ctype), fourcc(sub), u32(0), u32(0), u32(0), pascal(name, 13));
    const dinf = atom("dinf", full("dref", 0, 0, u32(1), full("alis", 0, 1)));
    const co64 = (offs: number[]) => full("co64", 0, 0, u32(offs.length), ...offs.map(u64));

    // ---- video track: 'b48r' 48-bit RGB
    const vsd = atom("b48r", new Uint8Array(6), u16(1), u16(0), u16(0), u32(0), u32(0), u32(1024), u16(w), u16(h), u32(0x480000), u32(0x480000), u32(0), u16(1), pascal("16-bit RGB", 32), u16(48), u16(0xffff));
    const vstbl = atom("stbl", full("stsd", 0, 0, u32(1), vsd), full("stts", 0, 0, u32(1), u32(n), u32(vt.delta)), full("stsc", 0, 0, u32(1), u32(1), u32(1), u32(1)), full("stsz", 0, 0, u32(this.frameBytes), u32(n)), co64(this.video));
    const vminf = atom("minf", full("vmhd", 0, 1, u16(0x40), u16(0x8000), u16(0x8000), u16(0x8000)), hdlr("dhlr", "alis", "Data"), dinf, vstbl);
    const vtrak = atom("trak", tkhd(1, Math.round((vDur / vt.timescale) * MT), false), atom("mdia", mdhd(vt.timescale, vDur), hdlr("mhlr", "vide", "Video"), vminf));

    let atrak: Uint8Array = new Uint8Array(0);
    if (a) {
      const ch = a.channels, bpf = 4 * ch;
      const asd = atom("lpcm", new Uint8Array(6), u16(1), u16(2), u16(0), u32(0), u16(3), u16(16), u16(0xfffe), u16(0), u32(0x10000), u32(72), f64(a.sampleRate), u32(ch), u32(0x7f000000), u32(32), u32(1 | 8), u32(bpf), u32(1));
      const runs: [number, number][] = []; // [first chunk (1-based), samples per chunk]
      this.audioChunks.forEach((c, i) => { if (!runs.length || runs[runs.length - 1][1] !== c.frames) runs.push([i + 1, c.frames]); });
      const astbl = atom("stbl", full("stsd", 0, 0, u32(1), asd), full("stts", 0, 0, u32(1), u32(this.audioFrames), u32(1)),
        full("stsc", 0, 0, u32(runs.length), ...runs.flatMap(([f, s]) => [u32(f), u32(s), u32(1)])), full("stsz", 0, 0, u32(bpf), u32(this.audioFrames)), co64(this.audioChunks.map((c) => c.off)));
      const aminf = atom("minf", full("smhd", 0, 0, u16(0), u16(0)), hdlr("dhlr", "alis", "Data"), dinf, astbl);
      atrak = atom("trak", tkhd(2, Math.round((this.audioFrames / a.sampleRate) * MT), true), atom("mdia", mdhd(a.sampleRate, this.audioFrames), hdlr("mhlr", "soun", "Sound"), aminf));
    }
    const mvhd = full("mvhd", 0, 0, u32(0), u32(0), u32(MT), u32(movieDur), u32(0x10000), u16(0x100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(a ? 3 : 2));
    return atom("moov", mvhd, vtrak, atrak);
  }
}

/** 16-bit RGB samples (native order) → big-endian bytes for 'b48r'. */
export function rgb48be(s: Uint16Array): Uint8Array {
  const o = new Uint8Array(s.length * 2);
  for (let i = 0, k = 0; i < s.length; i++, k += 2) { const v = s[i]; o[k] = v >> 8; o[k + 1] = v & 255; }
  return o;
}

// ---------------------------------------------------------------- reader
export interface MovSample { off: number; size: number }
export interface MovParse {
  codec: string;
  width: number;
  height: number;
  depth: number;
  fps: number;
  frames: MovSample[];
  audio: { codec: string; sampleRate: number; channels: number } | null;
  hasMoov: boolean;
}

type Reader = (off: number, len: number) => Promise<Uint8Array>;

async function children(read: Reader, start: number, end: number): Promise<{ type: string; at: number; body: number; end: number }[]> {
  const out: { type: string; at: number; body: number; end: number }[] = [];
  let p = start;
  while (p + 8 <= end) {
    const h = await read(p, 16);
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = dv.getUint32(0), hdr = 8;
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    if (size === 1) { size = dv.getUint32(8) * 2 ** 32 + dv.getUint32(12); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type, at: p, body: p + hdr, end: p + size });
    p += size;
  }
  return out;
}

/** Parses a QuickTime / ISO file far enough to read the samples of an uncompressed video track. */
export async function parseMov(file: Blob): Promise<MovParse> {
  const read: Reader = async (off, len) => new Uint8Array(await file.slice(off, Math.min(file.size, off + len)).arrayBuffer());
  const top = await children(read, 0, file.size);
  const moov = top.find((a) => a.type === "moov");
  const res: MovParse = { codec: "", width: 0, height: 0, depth: 0, fps: 0, frames: [], audio: null, hasMoov: !!moov };
  if (!moov) return res;
  const mv = await read(moov.at, moov.end - moov.at);
  const local: Reader = async (off, len) => mv.subarray(off - moov.at, off - moov.at + len);
  const find = async (s: number, e: number, t: string) => (await children(local, s, e)).find((a) => a.type === t);
  const dv = new DataView(mv.buffer, mv.byteOffset, mv.byteLength);
  const U32 = (at: number) => dv.getUint32(at - moov.at), U16 = (at: number) => dv.getUint16(at - moov.at);
  const str = (at: number) => String.fromCharCode(...mv.subarray(at - moov.at, at - moov.at + 4));
  for (const trak of (await children(local, moov.body, moov.end)).filter((a) => a.type === "trak")) {
    const mdia = await find(trak.body, trak.end, "mdia"); if (!mdia) continue;
    const hd = await find(mdia.body, mdia.end, "hdlr"), md = await find(mdia.body, mdia.end, "mdhd"), minf = await find(mdia.body, mdia.end, "minf");
    if (!hd || !md || !minf) continue;
    const sub = str(hd.body + 8);
    const v1 = mv[md.body - moov.at] === 1;
    const timescale = U32(md.body + (v1 ? 20 : 12));
    const stbl = await find(minf.body, minf.end, "stbl"); if (!stbl) continue;
    const stsd = await find(stbl.body, stbl.end, "stsd"); if (!stsd) continue;
    const entry = stsd.body + 8, codec = str(entry + 4);
    if (sub === "soun" && !res.audio) {
      const ver = U16(entry + 16);
      const rate = ver === 2 ? dv.getFloat64(entry + 40 - moov.at) : U32(entry + 32) / 65536;
      const chans = ver === 2 ? U32(entry + 48) : U16(entry + 24);
      res.audio = { codec, sampleRate: rate, channels: chans };
      continue;
    }
    if (sub !== "vide" || res.codec) continue;
    res.codec = codec; res.width = U16(entry + 32); res.height = U16(entry + 34); res.depth = U16(entry + 82);
    const stts = await find(stbl.body, stbl.end, "stts"), stsc = await find(stbl.body, stbl.end, "stsc"), stsz = await find(stbl.body, stbl.end, "stsz");
    const stco = (await find(stbl.body, stbl.end, "co64")) ?? (await find(stbl.body, stbl.end, "stco"));
    if (!stsc || !stsz || !stco) continue;
    const wide = stco.type === "co64";
    const nChunks = U32(stco.body + 4);
    const chunkOff = (i: number) => wide ? U32(stco.body + 8 + i * 8) * 2 ** 32 + U32(stco.body + 12 + i * 8) : U32(stco.body + 8 + i * 4);
    const fixed = U32(stsz.body + 4), count = U32(stsz.body + 8);
    const sizeOf = (i: number) => fixed || U32(stsz.body + 12 + i * 4);
    const runs = U32(stsc.body + 4);
    let s = 0;
    for (let r = 0; r < runs && s < count; r++) {
      const first = U32(stsc.body + 8 + r * 12) - 1, per = U32(stsc.body + 12 + r * 12);
      const last = r + 1 < runs ? U32(stsc.body + 8 + (r + 1) * 12) - 1 : nChunks;
      for (let c = first; c < last && s < count; c++) {
        let off = chunkOff(c);
        for (let k = 0; k < per && s < count; k++, s++) { const sz = sizeOf(s); res.frames.push({ off, size: sz }); off += sz; }
      }
    }
    if (stts && U32(stts.body + 4) >= 1) {
      let total = 0, dur = 0;
      for (let i = 0; i < U32(stts.body + 4); i++) { const c = U32(stts.body + 8 + i * 8), d = U32(stts.body + 12 + i * 8); total += c; dur += c * d; }
      res.fps = dur ? (total * timescale) / dur : 0;
    }
  }
  return res;
}
