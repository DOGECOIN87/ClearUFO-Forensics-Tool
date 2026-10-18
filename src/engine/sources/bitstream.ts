// H.264 / H.265 bitstream parsing: NAL splitting, SPS/PPS/slice header parsing,
// frame type (I/P/B) detection and decoder configuration records (avcC / hvcC).
import type { FrameType } from "../../shared/types";

export class BitReader {
  private pos = 0; // bit position
  constructor(private d: Uint8Array) {}
  get bitsLeft() { return this.d.length * 8 - this.pos; }
  u1(): number {
    if (this.pos >= this.d.length * 8) throw new Error("Bitstream overrun");
    const v = (this.d[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.u1();
    return v;
  }
  skip(n: number) { this.pos += n; }
  ue(): number {
    let zeros = 0;
    while (this.u1() === 0) { zeros++; if (zeros > 31) throw new Error("Invalid Exp-Golomb code"); }
    return zeros ? 2 ** zeros - 1 + this.u(zeros) : 0;
  }
  se(): number { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -(k / 2); }
}

/** Remove emulation prevention bytes (00 00 03 → 00 00). */
export function unescapeRbsp(nal: Uint8Array, maxLen = Infinity): Uint8Array {
  const n = Math.min(nal.length, maxLen);
  const out = new Uint8Array(n);
  let o = 0, zeros = 0;
  for (let i = 0; i < n; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

/** Find NAL units in an Annex B byte stream. Returns subarrays (no start codes). */
export function splitAnnexB(d: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const n = d.length;
  let start = -1;
  let i = 0;
  while (i + 2 < n) {
    if (d[i + 2] > 1) { i += 3; continue; }
    if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && d[end - 1] === 0) end--;
        if (end > start) out.push(d.subarray(start, end));
      }
      start = i + 3;
      i += 3;
    } else i++;
  }
  if (start >= 0 && start < n) {
    let end = n;
    while (end > start && d[end - 1] === 0) end--;
    if (end > start) out.push(d.subarray(start, end));
  }
  return out;
}

export function splitLengthPrefixed(d: Uint8Array, lenSize: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let p = 0;
  while (p + lenSize <= d.length) {
    let len = 0;
    for (let k = 0; k < lenSize; k++) len = len * 256 + d[p + k];
    p += lenSize;
    if (len <= 0 || p + len > d.length) break;
    out.push(d.subarray(p, p + len));
    p += len;
  }
  return out;
}

export function isAnnexB(d: Uint8Array): boolean {
  return d.length > 4 && d[0] === 0 && d[1] === 0 && (d[2] === 1 || (d[2] === 0 && d[3] === 1));
}

// ---------------------------------------------------------------- H.264
const SAR_TABLE: [number, number][] = [[0, 0], [1, 1], [12, 11], [10, 11], [16, 11], [40, 33], [24, 11], [20, 11], [32, 11], [80, 33], [18, 11], [15, 11], [64, 33], [160, 99], [4, 3], [3, 2], [2, 1]];

export interface H264Sps {
  id: number;
  profile: number;
  constraint: number;
  level: number;
  chromaFormat: number;
  separateColourPlane: boolean;
  bitDepth: number;
  log2MaxFrameNum: number;
  pocType: number;
  log2MaxPocLsb: number;
  frameMbsOnly: boolean;
  width: number;
  height: number;
  sar: [number, number];
  fps?: number;
  fullRange?: boolean;
  primaries?: number;
  transfer?: number;
  matrix?: number;
  /** chroma_sample_loc_type_top_field (0 = left … 5 = bottom), when the VUI signals it. */
  chromaLoc?: number;
}

export function parseH264Sps(nal: Uint8Array): H264Sps {
  const r = new BitReader(unescapeRbsp(nal.subarray(1), 512));
  const profile = r.u(8), constraint = r.u(8), level = r.u(8);
  const id = r.ue();
  let chromaFormat = 1, separateColourPlane = false, bitDepth = 8;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chromaFormat = r.ue();
    if (chromaFormat === 3) separateColourPlane = r.u1() === 1;
    bitDepth = r.ue() + 8;
    r.ue();
    r.u1();
    if (r.u1()) {
      const lists = chromaFormat !== 3 ? 8 : 12;
      for (let i = 0; i < lists; i++) {
        if (r.u1()) {
          const size = i < 6 ? 16 : 64;
          let last = 8, next = 8;
          for (let j = 0; j < size; j++) {
            if (next !== 0) next = (last + r.se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
  }
  const log2MaxFrameNum = r.ue() + 4;
  const pocType = r.ue();
  let log2MaxPocLsb = 0;
  if (pocType === 0) log2MaxPocLsb = r.ue() + 4;
  else if (pocType === 1) {
    r.u1(); r.se(); r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.u1(); // gaps
  const wMbs = r.ue() + 1;
  const hMap = r.ue() + 1;
  const frameMbsOnly = r.u1() === 1;
  if (!frameMbsOnly) r.u1();
  r.u1(); // direct_8x8
  let cl = 0, cr = 0, ct = 0, cb = 0;
  if (r.u1()) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
  const subW = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
  const subH = chromaFormat === 1 ? 2 : 1;
  const cropX = chromaFormat === 0 || separateColourPlane ? 1 : subW;
  const cropY = (chromaFormat === 0 || separateColourPlane ? 1 : subH) * (frameMbsOnly ? 1 : 2);
  const width = wMbs * 16 - (cl + cr) * cropX;
  const height = (frameMbsOnly ? 1 : 2) * hMap * 16 - (ct + cb) * cropY;
  const sps: H264Sps = { id, profile, constraint, level, chromaFormat, separateColourPlane, bitDepth, log2MaxFrameNum, pocType, log2MaxPocLsb, frameMbsOnly, width, height, sar: [1, 1] };
  try {
    if (r.u1()) {
      if (r.u1()) {
        const idc = r.u(8);
        if (idc === 255) sps.sar = [r.u(16), r.u(16)];
        else if (SAR_TABLE[idc] && idc > 0) sps.sar = SAR_TABLE[idc];
      }
      if (r.u1()) r.u1();
      if (r.u1()) {
        r.u(3);
        sps.fullRange = r.u1() === 1;
        if (r.u1()) { sps.primaries = r.u(8); sps.transfer = r.u(8); sps.matrix = r.u(8); }
      }
      if (r.u1()) { const loc = r.ue(); r.ue(); if (loc <= 5) sps.chromaLoc = loc; }
      if (r.u1()) {
        const units = r.u(32), scale = r.u(32);
        if (units > 0 && scale > 0) {
          const fps = scale / (2 * units);
          if (fps > 0.5 && fps < 400) sps.fps = fps;
        }
      }
    }
  } catch { /* truncated VUI is not fatal */ }
  if (!sps.sar[0] || !sps.sar[1]) sps.sar = [1, 1];
  return sps;
}

export interface H264Pps { id: number; spsId: number; bottomFieldPicOrder: boolean }
export function parseH264Pps(nal: Uint8Array): H264Pps {
  const r = new BitReader(unescapeRbsp(nal.subarray(1), 64));
  const id = r.ue(), spsId = r.ue();
  r.u1();
  return { id, spsId, bottomFieldPicOrder: r.u1() === 1 };
}

export interface H264Slice {
  firstMb: number;
  type: FrameType;
  ppsId: number;
  frameNum: number;
  field: boolean;
  bottom: boolean;
  idr: boolean;
  refIdc: number;
  pocLsb: number;
}

const H264_SLICE_TYPES: FrameType[] = ["P", "B", "I", "P", "I"]; // P, B, I, SP, SI

export function parseH264Slice(nal: Uint8Array, spsMap: Map<number, H264Sps>, ppsMap: Map<number, H264Pps>): H264Slice | null {
  const nalType = nal[0] & 0x1f;
  const r = new BitReader(unescapeRbsp(nal.subarray(1), 48));
  const firstMb = r.ue();
  const st = r.ue();
  const ppsId = r.ue();
  const slice: H264Slice = { firstMb, type: H264_SLICE_TYPES[st % 5] ?? "?", ppsId, frameNum: 0, field: false, bottom: false, idr: nalType === 5, refIdc: (nal[0] >> 5) & 3, pocLsb: 0 };
  const pps = ppsMap.get(ppsId);
  const sps = pps ? spsMap.get(pps.spsId) : spsMap.values().next().value;
  if (!sps) return slice;
  try {
    if (sps.separateColourPlane) r.u(2);
    slice.frameNum = r.u(sps.log2MaxFrameNum);
    if (!sps.frameMbsOnly) {
      slice.field = r.u1() === 1;
      if (slice.field) slice.bottom = r.u1() === 1;
    }
    if (slice.idr) r.ue();
    if (sps.pocType === 0) slice.pocLsb = r.u(sps.log2MaxPocLsb);
  } catch { /* partial header */ }
  return slice;
}

export function avcCodecString(sps: Uint8Array): string {
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `avc1.${h(sps[1])}${h(sps[2])}${h(sps[3])}`;
}

/** Build an AVCDecoderConfigurationRecord (avcC). */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array[], spsInfo?: H264Sps): Uint8Array {
  const parts: number[] = [1, sps[1], sps[2], sps[3], 0xff, 0xe1, (sps.length >> 8) & 255, sps.length & 255, ...sps, pps.length];
  for (const p of pps) parts.push((p.length >> 8) & 255, p.length & 255, ...p);
  if (spsInfo && [100, 110, 122, 144].includes(spsInfo.profile)) {
    parts.push(0xfc | (spsInfo.chromaFormat & 3), 0xf8 | ((spsInfo.bitDepth - 8) & 7), 0xf8 | ((spsInfo.bitDepth - 8) & 7), 0);
  }
  return new Uint8Array(parts);
}

// ---------------------------------------------------------------- H.265
export interface HevcSps {
  id: number;
  width: number;
  height: number;
  chromaFormat: number;
  separateColourPlane: boolean;
  bitDepth: number;
  bitDepthChroma: number;
  log2MaxPocLsb: number;
  maxSubLayersMinus1: number;
  temporalIdNesting: boolean;
  ptl: Uint8Array; // 12 bytes general profile_tier_level
}

export function parseHevcSps(nal: Uint8Array): HevcSps {
  const rb = unescapeRbsp(nal, 600);
  const r = new BitReader(rb.subarray(2));
  r.u(4);
  const maxSub = r.u(3);
  const nesting = r.u1() === 1;
  const ptl = rb.slice(3, 15);
  r.skip(96);
  const subProf: number[] = [], subLvl: number[] = [];
  for (let i = 0; i < maxSub; i++) { subProf.push(r.u1()); subLvl.push(r.u1()); }
  if (maxSub > 0) for (let i = maxSub; i < 8; i++) r.u(2);
  for (let i = 0; i < maxSub; i++) { if (subProf[i]) r.skip(88); if (subLvl[i]) r.skip(8); }
  const id = r.ue();
  const chromaFormat = r.ue();
  let separateColourPlane = false;
  if (chromaFormat === 3) separateColourPlane = r.u1() === 1;
  let width = r.ue(), height = r.ue();
  if (r.u1()) {
    const subW = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
    const subH = chromaFormat === 1 ? 2 : 1;
    const l = r.ue(), rr = r.ue(), t = r.ue(), b = r.ue();
    width -= (l + rr) * subW;
    height -= (t + b) * subH;
  }
  const bitDepth = r.ue() + 8;
  const bitDepthChroma = r.ue() + 8;
  const log2MaxPocLsb = r.ue() + 4;
  return { id, width, height, chromaFormat, separateColourPlane, bitDepth, bitDepthChroma, log2MaxPocLsb, maxSubLayersMinus1: maxSub, temporalIdNesting: nesting, ptl };
}

export interface HevcPps { id: number; spsId: number; dependentSlices: boolean; outputFlagPresent: boolean; extraBits: number }
export function parseHevcPps(nal: Uint8Array): HevcPps {
  const r = new BitReader(unescapeRbsp(nal.subarray(2), 32));
  const id = r.ue(), spsId = r.ue();
  const dependentSlices = r.u1() === 1;
  const outputFlagPresent = r.u1() === 1;
  const extraBits = r.u(3);
  return { id, spsId, dependentSlices, outputFlagPresent, extraBits };
}

export interface HevcSlice { first: boolean; type: FrameType; nalType: number; pocLsb: number; tid: number; irap: boolean; idr: boolean }
const HEVC_SLICE_TYPES: FrameType[] = ["B", "P", "I"];

export function parseHevcSlice(nal: Uint8Array, spsMap: Map<number, HevcSps>, ppsMap: Map<number, HevcPps>): HevcSlice | null {
  const nalType = (nal[0] >> 1) & 0x3f;
  const tid = (nal[1] & 7) - 1;
  const irap = nalType >= 16 && nalType <= 23;
  const idr = nalType === 19 || nalType === 20;
  const r = new BitReader(unescapeRbsp(nal.subarray(2), 48));
  const first = r.u1() === 1;
  const out: HevcSlice = { first, type: irap ? "I" : "?", nalType, pocLsb: 0, tid, irap, idr };
  if (!first) return out;
  try {
    if (irap) r.u1();
    const ppsId = r.ue();
    const pps = ppsMap.get(ppsId);
    const sps = pps ? spsMap.get(pps.spsId) : spsMap.values().next().value;
    r.skip(pps?.extraBits ?? 0);
    const st = r.ue();
    out.type = HEVC_SLICE_TYPES[st] ?? "?";
    if (pps?.outputFlagPresent) r.u1();
    if (sps?.separateColourPlane) r.u(2);
    if (!idr && sps) out.pocLsb = r.u(sps.log2MaxPocLsb);
  } catch { /* partial */ }
  return out;
}

export function hevcCodecString(sps: HevcSps): string {
  const p = sps.ptl;
  const space = (p[0] >> 6) & 3, tier = (p[0] >> 5) & 1, idc = p[0] & 31;
  let compat = ((p[1] << 24) | (p[2] << 16) | (p[3] << 8) | p[4]) >>> 0;
  let rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  const cons = Array.from(p.subarray(5, 11));
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  const level = p[11];
  return `hvc1.${["", "A", "B", "C"][space]}${idc}.${(rev >>> 0).toString(16)}.${tier ? "H" : "L"}${level}${cons.length ? "." + cons.map((c) => c.toString(16)).join(".") : ""}`;
}

/** Build an HEVCDecoderConfigurationRecord (hvcC). */
export function buildHvcC(vps: Uint8Array[], sps: Uint8Array[], pps: Uint8Array[], info: HevcSps): Uint8Array {
  const out: number[] = [1, ...info.ptl.subarray(0, 12)];
  out.splice(1, 0); // ptl already: profile byte, 4 compat, 6 constraint, level
  out.push(0xf0, 0x00); // min_spatial_segmentation_idc
  out.push(0xfc); // parallelismType
  out.push(0xfc | (info.chromaFormat & 3));
  out.push(0xf8 | ((info.bitDepth - 8) & 7));
  out.push(0xf8 | ((info.bitDepthChroma - 8) & 7));
  out.push(0, 0); // avgFrameRate
  out.push(((info.maxSubLayersMinus1 + 1) << 3) | ((info.temporalIdNesting ? 1 : 0) << 2) | 3);
  const arrays: [number, Uint8Array[]][] = [[32, vps], [33, sps], [34, pps]];
  out.push(arrays.filter((a) => a[1].length).length);
  for (const [type, list] of arrays) {
    if (!list.length) continue;
    out.push(0x80 | type, (list.length >> 8) & 255, list.length & 255);
    for (const n of list) out.push((n.length >> 8) & 255, n.length & 255, ...n);
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------- packet-level frame type
export interface FrameTypeContext {
  codec: string;
  nalLenSize: number; // 0 = Annex B
  h264Sps: Map<number, H264Sps>;
  h264Pps: Map<number, H264Pps>;
  hevcSps: Map<number, HevcSps>;
  hevcPps: Map<number, HevcPps>;
}

export function makeFrameTypeContext(codec: string, description?: Uint8Array | null): FrameTypeContext {
  const ctx: FrameTypeContext = { codec, nalLenSize: 4, h264Sps: new Map(), h264Pps: new Map(), hevcSps: new Map(), hevcPps: new Map() };
  if (!description || description.length < 7) { ctx.nalLenSize = 0; return ctx; }
  try {
    if (codec === "avc") {
      ctx.nalLenSize = (description[4] & 3) + 1;
      let p = 5;
      const nSps = description[p++] & 31;
      for (let i = 0; i < nSps; i++) { const len = (description[p] << 8) | description[p + 1]; p += 2; const s = parseH264Sps(description.subarray(p, p + len)); ctx.h264Sps.set(s.id, s); p += len; }
      const nPps = description[p++];
      for (let i = 0; i < nPps; i++) { const len = (description[p] << 8) | description[p + 1]; p += 2; const s = parseH264Pps(description.subarray(p, p + len)); ctx.h264Pps.set(s.id, s); p += len; }
    } else if (codec === "hevc") {
      ctx.nalLenSize = (description[21] & 3) + 1;
      let p = 22;
      const nArr = description[p++];
      for (let a = 0; a < nArr; a++) {
        const type = description[p++] & 0x3f;
        const cnt = (description[p] << 8) | description[p + 1]; p += 2;
        for (let i = 0; i < cnt; i++) {
          const len = (description[p] << 8) | description[p + 1]; p += 2;
          const nal = description.subarray(p, p + len);
          try {
            if (type === 33) { const s = parseHevcSps(nal); ctx.hevcSps.set(s.id, s); }
            else if (type === 34) { const s = parseHevcPps(nal); ctx.hevcPps.set(s.id, s); }
          } catch { /* ignore */ }
          p += len;
        }
      }
    }
  } catch { /* keep defaults */ }
  return ctx;
}

/** Determine I/P/B of a coded picture. */
export function frameTypeOf(data: Uint8Array, ctx: FrameTypeContext): FrameType {
  const nals = ctx.nalLenSize === 0 || isAnnexB(data) ? splitAnnexB(data) : splitLengthPrefixed(data, ctx.nalLenSize);
  if (ctx.codec === "avc") {
    for (const n of nals) {
      const t = n[0] & 0x1f;
      try {
        if (t === 7) { const s = parseH264Sps(n); ctx.h264Sps.set(s.id, s); }
        else if (t === 8) { const s = parseH264Pps(n); ctx.h264Pps.set(s.id, s); }
        else if (t === 1 || t === 5) { const s = parseH264Slice(n, ctx.h264Sps, ctx.h264Pps); if (s) return t === 5 ? "I" : s.type; }
      } catch { /* continue */ }
    }
  } else if (ctx.codec === "hevc") {
    for (const n of nals) {
      const t = (n[0] >> 1) & 0x3f;
      try {
        if (t === 33) { const s = parseHevcSps(n); ctx.hevcSps.set(s.id, s); }
        else if (t === 34) { const s = parseHevcPps(n); ctx.hevcPps.set(s.id, s); }
        else if (t <= 31) { const s = parseHevcSlice(n, ctx.hevcSps, ctx.hevcPps); if (s && s.first) return s.type; }
      } catch { /* continue */ }
    }
  }
  return "?";
}

export const FRAME_TYPE_CODE: Record<FrameType, number> = { "?": 0, I: 1, P: 2, B: 3, S: 4 };
export const FRAME_TYPE_FROM_CODE: FrameType[] = ["?", "I", "P", "B", "S"];
