// ISO base media file format (MP4 / MOV / 3GP) demuxer.
//
// The demuxer reads the structure of the file and builds the exact frame table: the number of
// frames, their type (key or not), their size, their offset in the file and their presentation
// timestamp. The colour information of the file (the colour matrix, the range and the HDR
// metadata) is read as well, so the YUV conversion of the app uses the values of the file.
//
// The decoding of the video codecs themselves is not part of this build: asking for a frame of an
// H.264, HEVC, AV1 or VP9 file returns a clear message instead of a wrong image.
import type { ByteSource } from "../../codecs/byteSource";
import type { FrameMeta, FrameTable, SourceInfo } from "../../shared/types";
import { baseInfo, fmtBytes, type SourceProvider } from "./types";
import type { Frame } from "../frame";

const fourcc = (d: Uint8Array, o: number) => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
const u32 = (d: Uint8Array, o: number) => (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3];
const u16 = (d: Uint8Array, o: number) => (d[o] << 8) | d[o + 1];
const u64 = (d: Uint8Array, o: number) => u32(d, o) * 0x100000000 + u32(d, o + 4);

export interface Mp4Sample {
  offset: number;
  size: number;
  /** Presentation time in seconds. */
  pts: number;
  /** Duration in seconds. */
  duration: number;
  key: boolean;
}

export interface Mp4Parse {
  brand: string;
  timescale: number;
  duration: number;
  width: number;
  height: number;
  codec: string;
  /** Codec of the audio track, when there is one. */
  audioCodec?: string;
  samples: Mp4Sample[];
  /** Colour matrix of the file ("bt601", "bt709", "bt2020"), when it is signalled. */
  matrix?: "bt601" | "bt709" | "bt2020";
  /** True when the file signals the full range. */
  fullRange?: boolean;
  /** Transfer function ("pq", "hlg", "bt709", …). */
  transfer?: string;
  primaries?: string;
  /** Peak luminance of the mastering display (cd/m²) and the maximum light level of the content. */
  maxLuminance?: number;
  maxCll?: number;
  audioTracks: number;
  notes: string[];
}

/** Reads the boxes of the file: a simple recursive descent over the box tree. */
interface Box {
  type: string;
  start: number;
  /** Start of the payload of the box. */
  body: number;
  end: number;
}

async function readBoxes(src: ByteSource, start: number, end: number, depth = 0): Promise<Box[]> {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    const h = await src.read(p, 16);
    if (h.length < 8) break;
    let size = u32(h, 0);
    const type = fourcc(h, 4);
    let body = p + 8;
    if (size === 1) {
      size = u64(h, 8);
      body = p + 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < 8 || p + size > end) break;
    out.push({ type, start: p, body, end: p + size });
    p += size;
  }
  return out;
}

const MATRIX_BY_CODE: Record<number, "bt601" | "bt709" | "bt2020"> = {
  5: "bt601", // BT.601 (525/625)
  6: "bt709",
  9: "bt2020",
};

const TRANSFER_BY_CODE: Record<number, string> = {
  1: "bt709",
  6: "bt709",
  8: "linear",
  13: "srgb",
  16: "pq",
  18: "hlg",
};

const PRIMARIES_BY_CODE: Record<number, string> = {
  1: "bt709",
  5: "bt709",
  9: "bt2020",
};

export async function parseMp4(src: ByteSource): Promise<Mp4Parse> {
  const head = await src.read(0, 12);
  if (fourcc(head, 4) !== "ftyp") throw new Error("Not an ISO base media file (no ftyp box)");
  const brand = fourcc(head, 8);
  const top = await readBoxes(src, 0, src.size);
  const moov = top.find((b) => b.type === "moov");
  if (!moov) throw new Error("The file has no moov box: it is not complete (a download that was interrupted?)");
  const res: Mp4Parse = {
    brand, timescale: 0, duration: 0, width: 0, height: 0, codec: "", samples: [],
    audioTracks: 0, notes: [],
  };

  const moovChildren = await readBoxes(src, moov.body, moov.end);
  for (const box of moovChildren) {
    if (box.type === "mvhd") {
      const d = await src.read(box.body, Math.min(120, box.end - box.body));
      const version = d[0];
      if (version === 1) {
        res.timescale = u32(d, 20);
        res.duration = u64(d, 24) / (res.timescale || 1);
      } else {
        res.timescale = u32(d, 12);
        res.duration = u32(d, 16) / (res.timescale || 1);
      }
    }
    if (box.type !== "trak") continue;
    const trak = await readBoxes(src, box.body, box.end);
    let handler = "";
    let isVideo = false;
    let isAudio = false;
    let stblBox: Box | null = null;
    let mdia: Box | null = null;
    for (const t of trak) {
      if (t.type !== "mdia") continue;
      mdia = t;
      const mdiaChildren = await readBoxes(src, t.body, t.end);
      for (const m of mdiaChildren) {
        if (m.type === "hdlr") {
          const d = await src.read(m.body, 12);
          handler = fourcc(d, 8);
          isVideo = handler === "vide";
          isAudio = handler === "soun";
        }
        if (m.type === "minf") {
          const minf = await readBoxes(src, m.body, m.end);
          for (const mi of minf) if (mi.type === "stbl") stblBox = mi;
        }
      }
    }
    if (!stblBox) continue;
    if (isAudio) {
      res.audioTracks++;
      continue;
    }
    if (!isVideo) continue;
    const stbl = await readBoxes(src, stblBox.body, stblBox.end);
    const stsd = stbl.find((b) => b.type === "stsd");
    const stts = stbl.find((b) => b.type === "stts");
    const stss = stbl.find((b) => b.type === "stss");
    const stsc = stbl.find((b) => b.type === "stsc");
    const stsz = stbl.find((b) => b.type === "stsz");
    const stz2 = stbl.find((b) => b.type === "stz2");
    const stco = stbl.find((b) => b.type === "stco");
    const co64 = stbl.find((b) => b.type === "co64");
    if (!stsd || !stts || !stsc || (!stsz && !stz2) || (!stco && !co64))
      throw new Error("The video track of the file is damaged (the sample table is incomplete)");

    // the sample description: the codec and the size of the picture
    // (the sample entries start after the version, the flags and the number of entries)
    const entry = await src.read(stsd.body + 8, Math.min(200, stsd.end - stsd.body - 8));
    res.codec = fourcc(entry, 4);
    // a visual sample entry: 6 bytes reserved, the data reference, 16 bytes of predefined values,
    // then the width and the height as 16-bit values
    const w = u16(entry, 8 + 24);
    const h = u16(entry, 8 + 26);
    if (w && h) {
      res.width = w;
      res.height = h;
    }
    // the colour information (colr box of the sample entry)
    const entryEnd = stsd.end;
    const entryBoxes = await readBoxes(src, stsd.body + 8, entryEnd);
    for (const b of entryBoxes) {
      if (b.type !== "colr") continue;
      const d = await src.read(b.body, 10);
      const kind = fourcc(d, 0);
      if (kind === "nclx") {
        const primaries = u16(d, 4), transfer = u16(d, 6), matrix = u16(d, 8);
        res.primaries = PRIMARIES_BY_CODE[primaries];
        res.transfer = TRANSFER_BY_CODE[transfer];
        res.matrix = MATRIX_BY_CODE[matrix];
        res.fullRange = (d[10] & 0x80) !== 0;
      }
    }
    // the mastering display and the content light level (HDR)
    for (const b of moovChildren) {
      if (b.type !== "udta") continue;
      const udta = await readBoxes(src, b.body, b.end);
      for (const u of udta) {
        if (u.type === "mdcv") {
          const d = await src.read(u.body, 24);
          res.maxLuminance = u32(d, 20) / 10000;
        }
        if (u.type === "clli") {
          const d = await src.read(u.body, 4);
          res.maxCll = u32(d, 2);
        }
      }
    }

    // the sample table
    const tsd = await src.read(stts.body, Math.min(8 + 4 * 4096, stts.end - stts.body));
    const tCount = u32(tsd, 4);
    const times: { count: number; delta: number }[] = [];
    for (let i = 0; i < tCount; i++) times.push({ count: u32(tsd, 8 + i * 8), delta: u32(tsd, 12 + i * 8) });

    const sizes: number[] = [];
    if (stsz) {
      const d = await src.read(stsz.body, Math.min(12 + 4 * 65536, stsz.end - stsz.body));
      const uniform = u32(d, 4);
      const count = u32(d, 8);
      if (uniform) for (let i = 0; i < count; i++) sizes.push(uniform);
      else for (let i = 0; i < count && 12 + i * 4 + 4 <= d.length; i++) sizes.push(u32(d, 12 + i * 4));
    } else if (stz2) {
      const d = await src.read(stz2.body, Math.min(12 + 4 * 65536, stz2.end - stz2.body));
      const fieldSize = d[7];
      const count = u32(d, 8);
      for (let i = 0; i < count; i++) {
        if (fieldSize === 16) sizes.push(u16(d, 12 + i * 2));
        else if (fieldSize === 8) sizes.push(d[12 + i]);
        else if (fieldSize === 4) sizes.push((d[12 + (i >> 1)] >> ((i & 1) ? 0 : 4)) & 15);
        else break;
      }
    }

    const chunkOffsets: number[] = [];
    if (stco) {
      const d = await src.read(stco.body, Math.min(8 + 4 * 65536, stco.end - stco.body));
      const n = u32(d, 4);
      for (let i = 0; i < n && 8 + i * 4 + 4 <= d.length; i++) chunkOffsets.push(u32(d, 8 + i * 4));
    } else if (co64) {
      const d = await src.read(co64.body, Math.min(8 + 8 * 65536, co64.end - co64.body));
      const n = u32(d, 4);
      for (let i = 0; i < n && 8 + i * 8 + 8 <= d.length; i++) chunkOffsets.push(u64(d, 8 + i * 8));
    }

    const scd = await src.read(stsc.body, Math.min(8 + 12 * 4096, stsc.end - stsc.body));
    const scCount = u32(scd, 4);
    const stscEntries: { firstChunk: number; samplesPerChunk: number }[] = [];
    for (let i = 0; i < scCount && 8 + i * 12 + 12 <= scd.length; i++)
      stscEntries.push({ firstChunk: u32(scd, 8 + i * 12), samplesPerChunk: u32(scd, 12 + i * 12) });

    const syncSamples = new Set<number>();
    if (stss) {
      const d = await src.read(stss.body, Math.min(8 + 4 * 65536, stss.end - stss.body));
      const n = u32(d, 4);
      for (let i = 0; i < n && 8 + i * 4 + 4 <= d.length; i++) syncSamples.add(u32(d, 8 + i * 4) - 1);
    }

    // the samples of the track
    const samples: Mp4Sample[] = [];
    let sampleIndex = 0;
    let time = 0;
    // the runs of samples with the same duration, with the time of every run
    const timeIndex: { start: number; end: number; delta: number }[] = [];
    {
      let acc = 0;
      for (const t of times) {
        timeIndex.push({ start: acc, end: acc + t.count, delta: t.delta });
        acc += t.count;
      }
    }
    const timeAt = (index: number) => {
      let base = 0;
      for (const e of timeIndex) {
        if (index < e.end) return base + (index - e.start) * e.delta;
        base += (e.end - e.start) * e.delta;
      }
      return base;
    };
    const durationAt = (index: number) => {
      for (const e of timeIndex) if (index < e.end) return e.delta;
      return times.length ? times[times.length - 1].delta : 0;
    };
    let chunk = 0;
    for (const entry of stscEntries) {
      const last = entry === stscEntries[stscEntries.length - 1] ? chunkOffsets.length : stscEntries[stscEntries.indexOf(entry) + 1].firstChunk;
      for (; chunk < last && chunk < chunkOffsets.length; chunk++) {
        let offset = chunkOffsets[chunk];
        for (let s = 0; s < entry.samplesPerChunk; s++) {
          const size = sizes[sampleIndex];
          if (size === undefined) break;
          const timescale = res.timescale || 1;
          samples.push({
            offset,
            size,
            pts: timeAt(sampleIndex) / timescale,
            duration: durationAt(sampleIndex) / timescale,
            key: stss ? syncSamples.has(sampleIndex) : true,
          });
          offset += size;
          sampleIndex++;
        }
      }
    }
    res.samples = samples;
    if (res.maxLuminance) res.notes.push(`Mastering display: ${res.maxLuminance.toFixed(0)} cd/m²`);
    if (res.maxCll) res.notes.push(`Maximum content light level: ${res.maxCll} cd/m²`);
    res.notes.push(`${samples.length} samples, ${syncSamples.size || samples.length} key frames`);
    break;
  }
  if (!res.samples.length) throw new Error("The file has no video samples");
  return res;
}

/** The frame table of the file (the types, the sizes and the timestamps of the frames). */
export function mp4FrameTable(sourceId: string, parse: Mp4Parse): FrameTable {
  const n = parse.samples.length;
  const types = new Uint8Array(n);
  const bytes = new Uint32Array(n);
  const pts = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    types[i] = parse.samples[i].key ? 1 : 2;
    bytes[i] = parse.samples[i].size;
    pts[i] = parse.samples[i].pts;
  }
  return { sourceId, count: n, types, bytes, pts, ready: true };
}

/**
 * The source of an MP4 file. The frame table is exact; the pixels of the compressed video codecs are
 * not decoded in this build, so asking for a frame reports the codec instead of returning a wrong
 * image.
 */
export class Mp4Source implements SourceProvider {
  table: FrameTable;
  info: SourceInfo;

  constructor(public id: string, private src: ByteSource, private parse: Mp4Parse) {
    this.table = mp4FrameTable(id, parse);
    this.info = baseInfo(id, parse.brand, "video");
    Object.assign(this.info, {
      width: parse.width, height: parse.height, frameCount: parse.samples.length,
      fps: parse.duration > 0 ? parse.samples.length / parse.duration : 25, duration: parse.duration,
      fileSize: src.size, container: `ISO BMFF (${parse.brand})`, codec: parse.codec,
      engine: "Built-in MP4 demuxer (frame table)", videoStreams: 1, audioStreams: parse.audioTracks,
      frameTypesReady: true,
    });
    this.info.metadata = [
      ["Container", `ISO BMFF (${parse.brand})`],
      ["Video codec", parse.codec],
      ["Frame rate", `${this.info.fps.toFixed(3)} fps`],
      ["Duration", `${parse.duration.toFixed(3)} s`],
      ...(parse.matrix ? ([["Colour matrix", parse.matrix.toUpperCase()]] as [string, string][]) : []),
      ...(parse.transfer ? ([["Transfer", parse.transfer.toUpperCase()]] as [string, string][]) : []),
      ...(parse.fullRange !== undefined ? ([["Range", parse.fullRange ? "full" : "limited"]] as [string, string][]) : []),
      ...(parse.maxLuminance ? ([["Mastering peak", `${parse.maxLuminance.toFixed(0)} cd/m²`]] as [string, string][]) : []),
      ...parse.notes.map((n) => ["Index", n] as [string, string]),
      ["Size", fmtBytes(src.size)],
    ];
  }

  async getFrame(_i = 0): Promise<Frame> {
    throw new Error(
      `The video codec "${this.parse.codec}" cannot be decoded on the device in this build. The frame table of the file ` +
        `(${this.parse.samples.length} frames) was read exactly; use Motion JPEG or an uncompressed AVI for the full processing.`,
    );
  }

  meta(i: number): FrameMeta {
    const s = this.parse.samples[i];
    return { type: s?.key ? "I" : "P", key: !!s?.key, pts: s?.pts ?? 0, bytes: s?.size ?? 0, src: i };
  }

  dispose() {}
}
