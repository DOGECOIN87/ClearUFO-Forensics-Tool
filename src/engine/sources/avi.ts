// RIFF/AVI demuxer (AVI 1.0 idx1 and OpenDML scanning) with Motion JPEG, raw YUV/RGB
// and H.264/H.265 (handed to the DVR remuxer) support.
import { BRAND } from "../../brand";
import type { FrameMeta, SourceInfo } from "../../shared/types";
import { alloc, type Frame } from "../frame";
import { decodeImageBlob } from "./image";
import { baseInfo, decodeKey, fmtBytes, SourceFrameCache, type DecodeOpts, type SourceProvider } from "./types";
import { DEFAULT_CHROMA, resolveYuv, yuvToFrame } from "./yuv";

const fourcc = (d: Uint8Array, o: number) => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
const u32 = (d: Uint8Array, o: number) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const u16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);

// ---------------------------------------------------------------- MJPEG Huffman table repair
const BITS_DC_L = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const BITS_DC_C = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const VALS_DC = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const BITS_AC_L = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const VALS_AC_L = [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];
const BITS_AC_C = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const VALS_AC_C = [0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];

const STD_DHT = (() => {
  const body: number[] = [];
  for (const [cls, bits, vals] of [[0x00, BITS_DC_L, VALS_DC], [0x01, BITS_DC_C, VALS_DC], [0x10, BITS_AC_L, VALS_AC_L], [0x11, BITS_AC_C, VALS_AC_C]] as [number, number[], number[]][]) body.push(cls, ...bits, ...vals);
  const len = body.length + 2;
  return new Uint8Array([0xff, 0xc4, len >> 8, len & 255, ...body]);
})();

/** Insert the standard Huffman tables in "AVI1" Motion JPEG frames that omit them. */
export function fixMjpeg(d: Uint8Array): Uint8Array {
  let p = 2;
  while (p + 4 < d.length) {
    if (d[p] !== 0xff) return d;
    const m = d[p + 1];
    if (m === 0xc4) return d;
    if (m === 0xda) {
      const out = new Uint8Array(d.length + STD_DHT.length);
      out.set(d.subarray(0, p), 0);
      out.set(STD_DHT, p);
      out.set(d.subarray(p), p + STD_DHT.length);
      return out;
    }
    p += 2 + ((d[p + 2] << 8) | d[p + 3]);
  }
  return d;
}

export async function decodeMjpeg(bytes: Uint8Array): Promise<Frame> {
  return decodeImageBlob(new Blob([fixMjpeg(bytes) as BlobPart], { type: "image/jpeg" }));
}

// ---------------------------------------------------------------- raw decoders
type RawKind = "dib24" | "dib32" | "gray" | "yuy2" | "uyvy" | "i420" | "yv12" | "nv12";

const isYuvKind = (k: RawKind) => k === "yuy2" || k === "uyvy" || k === "i420" || k === "yv12" || k === "nv12";

/**
 * Raw YUV through the shared converter, so the Video Loader's Color Matrix, Range and Chroma Filter apply.
 * Uncompressed AVI carries no colorimetry: BT.601 limited range is assumed (as ffmpeg does), BT.709 for the
 * HDYC FourCC, which is defined as BT.709 UYVY; 4:2:2 and 4:2:0 chroma are taken as left-sited.
 */
function decodeRawYuv(kind: RawKind, b: Uint8Array, w: number, h: number, opts: DecodeOpts | undefined, hdyc: boolean): Frame {
  const p = resolveYuv(opts, { matrix: hdyc ? "bt709" : "smpte170m", fullRange: false, siting: "left" }, h);
  if (kind === "yuy2" || kind === "uyvy") {
    const cw = (w + 1) >> 1, uo = w * h, vo = uo + cw * h;
    const planar = new Uint8Array(vo + cw * h);
    const [iy0, iu, iy1, iv] = kind === "yuy2" ? [0, 1, 2, 3] : [1, 0, 3, 2];
    for (let y = 0; y < h; y++) {
      const s0 = y * w * 2, yo = y * w, co = y * cw;
      for (let i = 0; i < cw; i++) {
        const s = s0 + i * 4;
        planar[yo + 2 * i] = b[s + iy0];
        if (2 * i + 1 < w) planar[yo + 2 * i + 1] = b[s + iy1];
        planar[uo + co + i] = b[s + iu]; planar[vo + co + i] = b[s + iv];
      }
    }
    return yuvToFrame(planar, [{ offset: 0, stride: w }, { offset: uo, stride: cw }, { offset: vo, stride: cw }], "I422", w, h, p);
  }
  const ysz = w * h, cw = w >> 1, csz = cw * (h >> 1);
  if (kind === "nv12") return yuvToFrame(b, [{ offset: 0, stride: w }, { offset: ysz, stride: cw * 2 }], "NV12", w, h, p);
  const [uo, vo] = kind === "i420" ? [ysz, ysz + csz] : [ysz + csz, ysz];
  return yuvToFrame(b, [{ offset: 0, stride: w }, { offset: uo, stride: cw }, { offset: vo, stride: cw }], "I420", w, h, p);
}

function decodeRaw(kind: RawKind, b: Uint8Array, w: number, h: number, bottomUp: boolean, opts?: DecodeOpts, hdyc = false): Frame {
  // Only the earlier default (sample replication, automatic BT.601 limited) keeps the original fixed-point
  // path below, so projects made before the chroma options existed reproduce bit for bit.
  if (isYuvKind(kind) && (hdyc || (opts?.chroma ?? DEFAULT_CHROMA) !== "nearest" || (opts?.matrix ?? "auto") !== "auto" || (opts?.colorRange ?? "auto") !== "auto"))
    return decodeRawYuv(kind, b, w, h, opts, hdyc);
  const f = alloc(w, h, true);
  const d = f.d;
  const yuv = (Y: number, U: number, V: number, o: number) => {
    const y = (Y - 16) * 1.164383, u = U - 128, v = V - 128;
    d[o] = y + 1.596027 * v; d[o + 1] = y - 0.391762 * u - 0.812968 * v; d[o + 2] = y + 2.017232 * u;
  };
  if (kind === "dib24" || kind === "dib32") {
    const bpp = kind === "dib24" ? 3 : 4, stride = (w * bpp + 3) & ~3;
    for (let y = 0; y < h; y++) {
      const sy = bottomUp ? h - 1 - y : y;
      for (let x = 0; x < w; x++) {
        const s = sy * stride + x * bpp, o = (y * w + x) * 4;
        d[o] = b[s + 2]; d[o + 1] = b[s + 1]; d[o + 2] = b[s];
      }
    }
  } else if (kind === "gray") {
    const stride = b.length >= ((w + 3) & ~3) * h ? (w + 3) & ~3 : w;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = b[y * stride + x], o = (y * w + x) * 4; d[o] = d[o + 1] = d[o + 2] = v; }
  } else if (kind === "yuy2" || kind === "uyvy") {
    const stride = w * 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x += 2) {
      const s = y * stride + x * 2;
      const [Y0, U, Y1, V] = kind === "yuy2" ? [b[s], b[s + 1], b[s + 2], b[s + 3]] : [b[s + 1], b[s], b[s + 3], b[s + 2]];
      yuv(Y0, U, V, (y * w + x) * 4);
      if (x + 1 < w) yuv(Y1, U, V, (y * w + x + 1) * 4);
    }
  } else {
    const ysz = w * h, cw = w >> 1, csz = cw * (h >> 1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const ci = (y >> 1) * cw + (x >> 1);
      let U: number, V: number;
      if (kind === "nv12") { U = b[ysz + ci * 2]; V = b[ysz + ci * 2 + 1]; }
      else if (kind === "i420") { U = b[ysz + ci]; V = b[ysz + csz + ci]; }
      else { V = b[ysz + ci]; U = b[ysz + csz + ci]; }
      yuv(b[y * w + x], U, V, (y * w + x) * 4);
    }
  }
  return f;
}

// ---------------------------------------------------------------- frame list provider
export interface ByteRange { off: number; size: number; key: boolean }

export class FrameListSource implements SourceProvider {
  private cache = new SourceFrameCache(192 * 1024 * 1024);
  /** `optsAware`: the decoder honours the loader's decode options (raw YUV), so they are part of the cache key. */
  constructor(public id: string, public info: SourceInfo, private read: (r: ByteRange) => Promise<Uint8Array>, private frames: ByteRange[], private decode: (b: Uint8Array, opts?: DecodeOpts) => Promise<Frame>, private optsAware = false) {}
  async getFrame(i: number, opts?: DecodeOpts): Promise<Frame> {
    i = Math.max(0, Math.min(this.frames.length - 1, i | 0));
    let k = i;
    while (k > 0 && this.frames[k].size === 0) k--; // zero sized chunks repeat the previous frame
    const ck = this.optsAware ? `${k}|${decodeKey(opts)}` : String(k);
    const hit = this.cache.get(ck);
    if (hit) return hit;
    let f = await this.decode(await this.read(this.frames[k]), opts);
    if (f.w !== this.info.width || f.h !== this.info.height) {
      if (!this.info.width) { this.info.width = f.w; this.info.height = f.h; }
      else {
        const W = this.info.width, H = this.info.height, out = alloc(W, H, true);
        for (let y = 0; y < Math.min(H, f.h); y++) out.d.set(f.d.subarray(y * f.w * 4, y * f.w * 4 + Math.min(W, f.w) * 4), y * W * 4);
        f = out;
      }
    }
    this.cache.set(ck, f);
    return f;
  }
  meta(i: number): FrameMeta {
    const r = this.frames[i];
    return { type: this.info.codec === "MJPEG" || r?.key ? "I" : "P", key: !!r?.key, pts: i / this.info.fps, bytes: r?.size ?? 0, src: i };
  }
  dispose() { this.cache.clear(); }
}

// ---------------------------------------------------------------- AVI parsing
export interface AviParse {
  width: number;
  height: number;
  bottomUp: boolean;
  fps: number;
  fourcc: string;
  compression: string;
  bitCount: number;
  frames: ByteRange[];
  extradata: Uint8Array;
  streams: { type: string; handler: string }[];
  notes: string[];
}

class BlobReader {
  private buf = new Uint8Array(0);
  private start = 0;
  constructor(private blob: Blob) {}
  async read(off: number, len: number): Promise<Uint8Array> {
    if (off >= this.start && off + len <= this.start + this.buf.length) return this.buf.subarray(off - this.start, off - this.start + len);
    const size = Math.max(len, 4 * 1024 * 1024);
    this.buf = new Uint8Array(await this.blob.slice(off, Math.min(this.blob.size, off + size)).arrayBuffer());
    this.start = off;
    return this.buf.subarray(0, Math.min(len, this.buf.length));
  }
}

export async function parseAvi(file: Blob): Promise<AviParse> {
  const r = new BlobReader(file);
  const head = await r.read(0, 12);
  if (fourcc(head, 0) !== "RIFF" || fourcc(head, 8) !== "AVI ") throw new Error("Not an AVI file");
  const res: AviParse = { width: 0, height: 0, bottomUp: true, fps: 25, fourcc: "", compression: "", bitCount: 24, frames: [], extradata: new Uint8Array(0), streams: [], notes: [] };
  let moviStart = -1, moviEnd = -1, idx1Off = -1, idx1Size = 0, vidStream = -1, usPerFrame = 0;
  const superIndex: { off: number; size: number }[] = [];
  const riffEnd = Math.min(file.size, 8 + u32(head, 4));
  let p = 12;
  while (p + 8 <= riffEnd) {
    const h = await r.read(p, 12);
    const id = fourcc(h, 0), size = u32(h, 4);
    if (id === "LIST") {
      const type = fourcc(h, 8);
      if (type === "hdrl") {
        const hd = new Uint8Array(await file.slice(p + 12, p + 8 + size).arrayBuffer());
        let q = 0, strIndex = -1;
        const walk = (d: Uint8Array, from: number, to: number) => {
          let k = from;
          while (k + 8 <= to) {
            const cid = fourcc(d, k), cs = u32(d, k + 4);
            if (cid === "LIST") { if (fourcc(d, k + 8) === "strl") { strIndex++; walk(d, k + 12, k + 8 + cs); } }
            else if (cid === "avih") usPerFrame = u32(d, k + 8);
            else if (cid === "strh") {
              const type = fourcc(d, k + 8), handler = fourcc(d, k + 12);
              res.streams.push({ type, handler });
              if (type === "vids" && vidStream < 0) {
                vidStream = strIndex;
                res.fourcc = handler;
                const scale = u32(d, k + 8 + 20), rate = u32(d, k + 8 + 24);
                if (scale && rate) res.fps = rate / scale;
              }
            } else if (cid === "strf" && strIndex === vidStream && vidStream >= 0 && !res.width) {
              const b = k + 8;
              res.width = u32(d, b + 4);
              const hh = (d[b + 8] | (d[b + 9] << 8) | (d[b + 10] << 16) | (d[b + 11] << 24));
              res.height = Math.abs(hh);
              res.bottomUp = hh > 0;
              res.bitCount = u16(d, b + 14);
              const comp = u32(d, b + 16);
              res.compression = comp === 0 ? "BI_RGB" : comp === 3 ? "BI_BITFIELDS" : fourcc(d, b + 16);
              if (cs > 40) res.extradata = d.slice(b + 40, b + cs);
            } else if (cid === "indx" && strIndex === vidStream && vidStream >= 0 && cs >= 24) {
              // OpenDML super index (AVI_INDEX_OF_INDEXES): where the standard index of each segment is
              const b = k + 8;
              if (u16(d, b) === 4 && d[b + 3] === 0) {
                const used = Math.min(u32(d, b + 4), Math.floor((cs - 24) / 16));
                for (let i = 0; i < used; i++) { const e = b + 24 + i * 16; superIndex.push({ off: u32(d, e) + u32(d, e + 4) * 0x100000000, size: u32(d, e + 8) }); }
              }
            }
            k += 8 + cs + (cs & 1);
          }
        };
        walk(hd, q, hd.length);
      } else if (type === "movi") { moviStart = p + 8; moviEnd = p + 8 + size; }
    } else if (id === "idx1") { idx1Off = p + 8; idx1Size = size; }
    p += 8 + size + (size & 1);
  }
  if (vidStream < 0) throw new Error("The AVI file has no video stream");
  if (!res.fps && usPerFrame) res.fps = 1e6 / usPerFrame;
  const tag = String(vidStream).padStart(2, "0");

  if (superIndex.length) {
    // OpenDML: one standard index (ix##, AVI_INDEX_OF_CHUNKS) per RIFF segment. Offsets point at the
    // chunk data, relative to qwBaseOffset; bit 31 of the size marks a non-key frame.
    try {
      const frames: AviParse["frames"] = [];
      for (const si of superIndex) {
        const ix = new Uint8Array(await file.slice(si.off, si.off + si.size).arrayBuffer());
        if (ix.length < 32 || ix[11] !== 1) throw new Error("bad standard index");
        const longs = u16(ix, 8), n = u32(ix, 12), base = u32(ix, 20) + u32(ix, 24) * 0x100000000;
        if (longs < 2 || 32 + n * longs * 4 > ix.length) throw new Error("bad standard index");
        for (let j = 0; j < n; j++) { const e = 32 + j * longs * 4, sz = u32(ix, e + 4); frames.push({ off: base + u32(ix, e), size: sz & 0x7fffffff, key: (sz & 0x80000000) === 0 }); }
      }
      if (frames.length && frames.every((f) => f.off + f.size <= file.size)) {
        res.frames = frames;
        res.notes.push(`OpenDML index: ${frames.length} video chunks in ${superIndex.length} segment${superIndex.length === 1 ? "" : "s"}`);
      }
    } catch { /* fall back to idx1 or scanning */ }
  }
  if (!res.frames.length && idx1Off > 0 && idx1Size >= 16) {
    const idx = new Uint8Array(await file.slice(idx1Off, idx1Off + idx1Size).arrayBuffer());
    const entries: { off: number; size: number; key: boolean }[] = [];
    for (let e = 0; e + 16 <= idx.length; e += 16) {
      const id = fourcc(idx, e);
      if (id.slice(0, 2) !== tag || (id[2] !== "d")) continue;
      entries.push({ off: u32(idx, e + 8), size: u32(idx, e + 12), key: (u32(idx, e + 4) & 0x10) !== 0 });
    }
    if (entries.length) {
      const probe = entries.find((e) => e.size > 0) ?? entries[0];
      const rel = await r.read(moviStart + probe.off, 4);
      const base = fourcc(rel, 0).slice(0, 2) === tag ? moviStart : 0;
      res.frames = entries.map((e) => ({ off: base + e.off + 8, size: e.size, key: e.key }));
      res.notes.push(`AVI 1.0 index: ${entries.length} video chunks`);
      // idx1 only covers the first RIFF: scan OpenDML continuation segments (RIFF 'AVIX') after it
      let at = riffEnd + (riffEnd & 1), extra = 0;
      while (at + 24 <= file.size) {
        const nh = await r.read(at, 24);
        if (fourcc(nh, 0) !== "RIFF" || fourcc(nh, 8) !== "AVIX" || fourcc(nh, 12) !== "LIST" || fourcc(nh, 20) !== "movi") break;
        const segEnd = Math.min(file.size, at + 8 + u32(nh, 4)), listEnd = Math.min(segEnd, at + 20 + u32(nh, 16));
        let q = at + 24;
        while (q + 8 <= listEnd) {
          const h = await r.read(q, 8);
          const id = fourcc(h, 0), size = u32(h, 4);
          if (id === "LIST") { q += 12; continue; }
          if (!/^[\x20-\x7e]{4}$/.test(id)) break;
          if (id.slice(0, 2) === tag && id[2] === "d") { res.frames.push({ off: q + 8, size, key: true }); extra++; }
          q += 8 + size + (size & 1);
        }
        at = segEnd + (segEnd & 1);
      }
      if (extra) res.notes.push(`${extra} more video chunks found in OpenDML segments`);
    }
  }
  if (!res.frames.length) {
    // sequential scan (no idx1, OpenDML or damaged index)
    let q = moviStart + 4;
    let end = moviEnd;
    while (q + 8 <= file.size) {
      if (q + 8 > end) {
        const nh = await r.read(end, 24);
        if (end + 24 <= file.size && fourcc(nh, 0) === "RIFF" && fourcc(nh, 8) === "AVIX" && fourcc(nh, 12) === "LIST" && fourcc(nh, 20) === "movi") { q = end + 24; end = end + 20 + u32(nh, 16) + 4; continue; }
        break;
      }
      const h = await r.read(q, 12);
      const id = fourcc(h, 0), size = u32(h, 4);
      if (id === "LIST") { q += 12; continue; }
      if (id.slice(0, 2) === tag && id[2] === "d") res.frames.push({ off: q + 8, size, key: false });
      if (!/^[\x20-\x7e]{4}$/.test(id)) break;
      q += 8 + size + (size & 1);
    }
    res.notes.push(`No index: ${res.frames.length} video chunks found by scanning`);
  }
  if (!res.frames.length) throw new Error("No video frames found in the AVI file");
  return res;
}

const MJPEG_CC = ["MJPG", "AVRN", "AVDJ", "JPEG", "DMB1", "LJPG", "MJLS"];
const H264_CC = ["H264", "X264", "AVC1", "DAVC", "VSSH", "AVCHD"];
const HEVC_CC = ["HEVC", "H265", "HVC1", "HEV1", "X265"];
const MPEG4_CC = ["XVID", "DIVX", "DX50", "FMP4", "MP4V", "M4S2", "DIV3", "MP42", "MP43"];

export type AviOpenResult =
  | { kind: "frames"; provider: SourceProvider }
  | { kind: "bitstream"; codec: "h264" | "hevc"; es: Uint8Array; fps: number; parse: AviParse };

export async function openAvi(id: string, file: File): Promise<AviOpenResult> {
  const a = await parseAvi(file);
  const cc = (a.compression === "BI_RGB" || a.compression === "BI_BITFIELDS" ? a.fourcc : a.compression).toUpperCase().trim();
  const comp = a.compression.toUpperCase();
  const info = baseInfo(id, file.name, "video");
  Object.assign(info, { width: a.width, height: a.height, frameCount: a.frames.length, fps: a.fps, duration: a.frames.length / a.fps, fileSize: file.size, container: "AVI (RIFF)", videoStreams: a.streams.filter((s) => s.type === "vids").length, audioStreams: a.streams.filter((s) => s.type === "auds").length, frameTypesReady: true });
  info.metadata = [["Container", "AVI (RIFF)"], ["Stream Handler", a.fourcc], ["Compression", a.compression], ["Bits Per Pixel", String(a.bitCount)], ["Frame Rate (header)", a.fps.toFixed(3)], ...a.notes.map((n) => ["Index", n] as [string, string]), ["Size", fmtBytes(file.size)]];
  const zero = a.frames.filter((f) => f.size === 0).length;
  if (zero) info.metadata.push(["Repeated Frames", `${zero} zero-length chunks (frame repeats)`]);
  const read = async (r: ByteRange) => new Uint8Array(await file.slice(r.off, r.off + r.size).arrayBuffer());

  if (MJPEG_CC.includes(cc) || MJPEG_CC.includes(comp)) {
    info.codec = "MJPEG";
    info.engine = "Built-in AVI demuxer + native JPEG decoder";
    return { kind: "frames", provider: new FrameListSource(id, info, read, a.frames.map((f) => ({ ...f, key: true })), decodeMjpeg) };
  }
  const rawMap: Record<string, RawKind> = { Y800: "gray", "Y8": "gray", GREY: "gray", YUY2: "yuy2", YUYV: "yuy2", YUNV: "yuy2", V422: "yuy2", UYVY: "uyvy", "2VUY": "uyvy", HDYC: "uyvy", I420: "i420", IYUV: "i420", YV12: "yv12", NV12: "nv12" };
  let raw: RawKind | null = null;
  if (a.compression === "BI_RGB" || a.compression === "BI_BITFIELDS" || comp === "DIB " || comp === "RGB ") raw = a.bitCount === 32 ? "dib32" : a.bitCount === 8 ? "gray" : "dib24";
  else raw = rawMap[comp.trim()] ?? rawMap[cc] ?? null;
  if (raw) {
    info.codec = `Uncompressed (${raw.toUpperCase()})`;
    info.engine = "Built-in AVI demuxer (uncompressed)";
    const k = raw, w = a.width, h = a.height, bu = a.bottomUp, hdyc = comp.trim() === "HDYC" || cc === "HDYC";
    const yuv = isYuvKind(raw);
    if (yuv) {
      info.browserConversion = false;
      info.chromaSiting = "left";
      info.conversion = `${BRAND.name}, from the uncompressed ${raw.toUpperCase()} samples (Color Matrix, Range and Chroma Filter of the Video Loader; automatic: ${hdyc ? "BT.709 (HDYC)" : "BT.601"}, limited range, left chroma siting)`;
      info.metadata.push(["YUV to RGB (auto)", `${hdyc ? "BT.709 (HDYC FourCC)" : "BT.601"}, limited range — uncompressed AVI does not signal colorimetry`]);
    }
    return { kind: "frames", provider: new FrameListSource(id, info, read, a.frames.map((f) => ({ ...f, key: true })), async (b, o) => decodeRaw(k, b, w, h, bu, o, hdyc), yuv) };
  }
  if (H264_CC.includes(cc) || H264_CC.includes(comp) || HEVC_CC.includes(cc) || HEVC_CC.includes(comp)) {
    const codec = HEVC_CC.includes(cc) || HEVC_CC.includes(comp) ? "hevc" : "h264";
    const parts: Uint8Array[] = [];
    let total = 0;
    // parameter sets stored in the stream format extradata
    if (a.extradata.length > 6) {
      if (a.extradata[0] === 1 && codec === "h264") {
        const ed = a.extradata;
        let q = 5;
        const n = ed[q++] & 31;
        for (let i = 0; i < n; i++) { const l = (ed[q] << 8) | ed[q + 1]; q += 2; parts.push(new Uint8Array([0, 0, 0, 1]), ed.subarray(q, q + l)); q += l; }
        const m = ed[q++];
        for (let i = 0; i < m; i++) { const l = (ed[q] << 8) | ed[q + 1]; q += 2; parts.push(new Uint8Array([0, 0, 0, 1]), ed.subarray(q, q + l)); q += l; }
      } else if (a.extradata[0] === 0 && a.extradata[1] === 0) parts.push(a.extradata);
    }
    for (const f of a.frames) {
      if (!f.size) continue;
      let b: Uint8Array = await read(f);
      if (!(b[0] === 0 && b[1] === 0 && (b[2] === 1 || (b[2] === 0 && b[3] === 1)))) {
        // length-prefixed (AVCC) payload → Annex B
        const conv: Uint8Array[] = [];
        let q = 0;
        while (q + 4 <= b.length) { const l = u32be(b, q); q += 4; if (l <= 0 || q + l > b.length) break; conv.push(new Uint8Array([0, 0, 0, 1]), b.subarray(q, q + l)); q += l; }
        b = concatBytes(conv);
      }
      parts.push(b);
      total += b.length;
    }
    return { kind: "bitstream", codec, es: concatBytes(parts), fps: a.fps, parse: a };
  }
  if (MPEG4_CC.includes(cc) || MPEG4_CC.includes(comp)) throw new Error(`The AVI uses the MPEG-4 Part 2 codec (${cc}), which browsers cannot decode. Transcode it to H.264 or Motion JPEG.`);
  throw new Error(`Unsupported AVI codec "${cc || comp}"`);
}

const u32be = (d: Uint8Array, o: number) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
function concatBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
