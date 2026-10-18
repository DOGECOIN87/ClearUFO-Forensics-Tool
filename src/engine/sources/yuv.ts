// Explicit YUV → RGB conversion of decoded video frames.
// Doing this ourselves (instead of letting the browser draw the frame) gives the examiner control over
// the color matrix, the range and the chroma reconstruction, and keeps float precision: 10 and 12-bit
// samples keep their fractional values on the 0..255 scale, nothing is rounded before the filters.
import { alloc, type Frame } from "../frame";
import { bandCount, defineKernel, forcedBandCount, laneCount, parallelWorthIt, rowBands, runJobs, type Job } from "../pool";

export type Matrix = "bt601" | "bt709" | "bt2020";
/** How subsampled (4:2:0 / 4:2:2) chroma is brought to full resolution. */
export type ChromaFilter = "nearest" | "bilinear" | "bicubic";
/** Position of the chroma samples relative to the luma grid (ITU-T H.273 chroma_sample_loc_type 0..5). */
export type Siting = "left" | "center" | "topleft" | "top" | "bottomleft" | "bottom";
export interface YuvParams { matrix: Matrix; full: boolean; chroma: ChromaFilter; siting: Siting }

/** Default reconstruction for new Video Loaders: bicubic (Catmull-Rom) from correctly sited samples. */
export const DEFAULT_CHROMA: ChromaFilter = "bicubic";
export const CHROMA_FILTERS: readonly ChromaFilter[] = ["nearest", "bilinear", "bicubic"];
export const SITINGS: readonly Siting[] = ["left", "center", "topleft", "top", "bottomleft", "bottom"];
/** chroma_sample_loc_type (H.264/HEVC VUI) → siting. */
export const SITING_FROM_LOC: readonly Siting[] = SITINGS;
export const SITING_LABEL: Record<Siting, string> = {
  left: "Left (MPEG-2, H.264, HEVC default)", center: "Center (JPEG, MPEG-1)", topleft: "Top-left (co-sited)",
  top: "Top", bottomleft: "Bottom-left", bottom: "Bottom",
};
export const CHROMA_LABEL: Record<ChromaFilter, string> = {
  bicubic: "Bicubic (Catmull-Rom)", bilinear: "Bilinear", nearest: "Nearest (replicate samples)",
};
/** Luma-grid position of chroma sample (0, 0) for 4:2:0, in luma pixels: horizontally 0 or ½, vertically 0, ½ or 1. */
const SITE: Record<Siting, [number, number]> = { left: [0, 0.5], center: [0.5, 0.5], topleft: [0, 0], top: [0.5, 0], bottomleft: [0, 1], bottom: [0.5, 1] };

interface PlaneLayoutLike { offset: number; stride: number }

export const YUV_FORMATS = new Set(["I420", "I420A", "I422", "I422A", "I444", "I444A", "NV12", "I420P10", "I420P12", "I422P10", "I422P12", "I444P10", "I444P12", "I420AP10", "I420AP12", "I422AP10", "I422AP12", "I444AP10", "I444AP12"]);
export const RGB_FORMATS = new Set(["RGBA", "RGBX", "BGRA", "BGRX"]);

function coefficients(p: { matrix: Matrix; full: boolean }) {
  // (same expressions as earlier versions, so the replicate path stays bit-identical)
  const [Kr, Kb] = p.matrix === "bt709" ? [0.2126, 0.0722] : p.matrix === "bt2020" ? [0.2627, 0.0593] : [0.299, 0.114];
  const Kg = 1 - Kr - Kb;
  const ys = p.full ? 1 : 255 / 219, yo = p.full ? 0 : 16, cs = p.full ? 1 : 255 / 224;
  const crR = 2 * (1 - Kr) * cs, cbB = 2 * (1 - Kb) * cs;
  const cbG = (-2 * (1 - Kb) * Kb / Kg) * cs, crG = (-2 * (1 - Kr) * Kr / Kg) * cs;
  return { ys, yo, crR, cbB, cbG, crG };
}

/** Sample layout facts of a WebCodecs pixel format. */
export function formatInfo(format: string) {
  const bits = format.endsWith("P10") ? 10 : format.endsWith("P12") ? 12 : 8;
  const nv12 = format === "NV12";
  return { bits, nv12, sx: format.startsWith("I444") ? 0 : 1, sy: format.startsWith("I420") || nv12 ? 1 : 0 };
}

/**
 * Scale of the raw samples onto the 0..255 working range. Limited range scales by 2^(n-8) (BT.601/709/2100:
 * black 16·2^(n-8), white 235·2^(n-8)); full range by 255/(2^n − 1) with chroma centred on 2^(n−1) (H.273).
 */
function sampleScale(bits: number, full: boolean) {
  if (bits === 8) return { norm: 1, center: 128 };
  if (!full) return { norm: 1 / (1 << (bits - 8)), center: 128 };
  const norm = 255 / ((1 << bits) - 1);
  return { norm, center: (1 << (bits - 1)) * norm };
}

export function yuvToFrame(buf: Uint8Array, layout: PlaneLayoutLike[], format: string, w: number, h: number, p: YuvParams): Frame {
  return { w, h, d: yuvRows(buf, layout, format, w, h, p, 0, h, 0, 0) };
}

/** Uses sample replication rather than interpolation (4:4:4, or the Nearest chroma filter). */
const replicates = (fi: ReturnType<typeof formatInfo>, p: YuvParams) => p.chroma === "nearest" || (fi.sx === 0 && fi.sy === 0);

/**
 * Output rows [y0, y1) (RGBA float) of the conversion of a w × h frame. In `buf`, the luma plane starts at image
 * row `ly0` and the chroma planes at chroma row `c0` (the layout offsets point there); the whole frame is
 * (0, h, 0, 0). Every output row is computed exactly as in a whole-frame conversion.
 */
export function yuvRows(buf: Uint8Array, layout: PlaneLayoutLike[], format: string, w: number, h: number, p: YuvParams, y0: number, y1: number, ly0: number, c0: number): Float32Array {
  const fi = formatInfo(format);
  if (replicates(fi, p)) return yuvReplicate(buf, layout, fi, w, h, p, y0, y1, ly0, c0);
  return yuvInterpolated(buf, layout, fi, w, h, p, y0, y1, ly0, c0);
}

/** Sample replication (each chroma sample covers its 2×2 or 2×1 luma block). Exactly the conversion of earlier versions. */
function yuvReplicate(buf: Uint8Array, layout: PlaneLayoutLike[], fi: ReturnType<typeof formatInfo>, w: number, h: number, p: YuvParams, y0: number, y1: number, ly0: number, c0: number): Float32Array {
  const d = alloc(w, y1 - y0, true).d;
  const { ys, yo, crR, cbB, cbG, crG } = coefficients(p);
  const { nv12, sx, sy, bits } = fi;
  const L0 = layout[0], L1 = layout[1], L2 = nv12 ? layout[1] : layout[2];
  if (bits === 8) {
    // 8-bit fast path: direct indexing, no per-sample function calls
    for (let y = y0; y < y1; y++) {
      const yRow = L0.offset + (y - ly0) * L0.stride, cy = (y >> sy) - c0;
      const uRow = L1.offset + cy * L1.stride, vRow = L2.offset + cy * L2.stride;
      let o = (y - y0) * w * 4;
      for (let x = 0; x < w; x++, o += 4) {
        const cx = x >> sx;
        const yy = (buf[yRow + x] - yo) * ys;
        let u: number, v: number;
        if (nv12) { const k = uRow + cx * 2; u = buf[k] - 128; v = buf[k + 1] - 128; }
        else { u = buf[uRow + cx] - 128; v = buf[vRow + cx] - 128; }
        d[o] = yy + crR * v;
        d[o + 1] = yy + cbG * u + crG * v;
        d[o + 2] = yy + cbB * u;
      }
    }
    return d;
  }
  const { norm, center } = sampleScale(bits, p.full);
  const r16 = (o: number) => buf[o] | (buf[o + 1] << 8); // little-endian 16-bit containers, value in the low bits
  for (let y = y0; y < y1; y++) {
    const cy = (y >> sy) - c0;
    const yRow = L0.offset + (y - ly0) * L0.stride, uRow = L1.offset + cy * L1.stride, vRow = L2.offset + cy * L2.stride;
    for (let x = 0; x < w; x++) {
      const cx = x >> sx;
      const yy = (r16(yRow + x * 2) * norm - yo) * ys, u = r16(uRow + cx * 2) * norm - center, v = r16(vRow + cx * 2) * norm - center;
      const i = ((y - y0) * w + x) * 4;
      d[i] = yy + crR * v;
      d[i + 1] = yy + cbG * u + crG * v;
      d[i + 2] = yy + cbB * u;
    }
  }
  return d;
}

/** Catmull-Rom (bicubic, B = 0, C = ½) weights for the taps at -1, 0, +1, +2 around a fractional position t. */
function catmullRom(t: number): [number, number, number, number] {
  const t2 = t * t, t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}

/**
 * Resampling taps that bring `srcN` chroma samples to `n` luma positions. Chroma sample i sits at luma
 * position 2i + off (or i when not subsampled). Beyond the edges the plane is mirrored (half-sample
 * symmetric: …, 1, 0 | 0, 1, …), as zimg does, rather than repeating the outermost sample.
 */
function taps(n: number, srcN: number, sub: number, off: number, filter: "bilinear" | "bicubic") {
  const k = sub ? (filter === "bicubic" ? 4 : 2) : 1;
  const idx = new Int32Array(n * k), wt = new Float64Array(n * k);
  const cl = (i: number) => {
    if (srcN === 1) return 0;
    while (i < 0 || i >= srcN) i = i < 0 ? -i - 1 : 2 * srcN - i - 1;
    return i;
  };
  for (let x = 0; x < n; x++) {
    if (k === 1) { idx[x] = cl(x); wt[x] = 1; continue; }
    const c = (x - off) / 2, i0 = Math.floor(c), t = c - i0;
    if (k === 2) { idx[x * 2] = cl(i0); idx[x * 2 + 1] = cl(i0 + 1); wt[x * 2] = 1 - t; wt[x * 2 + 1] = t; continue; }
    const wv = catmullRom(t);
    for (let j = 0; j < 4; j++) { idx[x * 4 + j] = cl(i0 - 1 + j); wt[x * 4 + j] = wv[j]; }
  }
  return { k, idx, wt };
}

/** Separable bilinear / bicubic chroma reconstruction honouring the chroma siting, in float. */
/** Chroma rows the vertical resampling of output rows [y0, y1) reads: [first, end). */
export function chromaRowsFor(format: string, w: number, h: number, p: YuvParams, y0: number, y1: number): [number, number] {
  const fi = formatInfo(format);
  if (replicates(fi, p)) return [y0 >> fi.sy, ((y1 - 1) >> fi.sy) + 1];
  const ch = (h + (1 << fi.sy) - 1) >> fi.sy;
  const ty = taps(h, ch, fi.sy, (SITE[p.siting] ?? SITE.left)[1], p.chroma === "bilinear" ? "bilinear" : "bicubic");
  let a = ch, b = 0;
  for (let i = y0 * ty.k; i < y1 * ty.k; i++) { const c = ty.idx[i]; if (c < a) a = c; if (c + 1 > b) b = c + 1; }
  return [a, b];
}

function yuvInterpolated(buf: Uint8Array, layout: PlaneLayoutLike[], fi: ReturnType<typeof formatInfo>, w: number, h: number, p: YuvParams, y0: number, y1: number, ly0: number, c0: number): Float32Array {
  const { ys, yo, crR, cbB, cbG, crG } = coefficients(p);
  const { nv12, sx, sy, bits } = fi;
  const { norm, center } = sampleScale(bits, p.full);
  const cw = (w + (1 << sx) - 1) >> sx, ch = (h + (1 << sy) - 1) >> sy;
  const L0 = layout[0], L1 = layout[1], L2 = nv12 ? layout[1] : layout[2];
  const filter = p.chroma === "bilinear" ? "bilinear" : "bicubic";
  const [offX, offY] = SITE[p.siting] ?? SITE.left;
  const ty = taps(h, ch, sy, offY, filter);
  // chroma rows this band reads (all of them for the whole frame)
  let ca = ch, cb = 0;
  for (let i = y0 * ty.k; i < y1 * ty.k; i++) { const c = ty.idx[i]; if (c < ca) ca = c; if (c + 1 > cb) cb = c + 1; }
  const crows = Math.max(0, cb - ca);

  // chroma planes on the working scale, centred on 0 (rows ca .. cb, stored from row ca on)
  const U = new Float32Array(cw * crows), V = new Float32Array(cw * crows);
  for (let j = 0; j < crows; j++) {
    const uRow = L1.offset + (ca + j - c0) * L1.stride, vRow = L2.offset + (ca + j - c0) * L2.stride, o = j * cw;
    if (nv12) for (let i = 0; i < cw; i++) { U[o + i] = buf[uRow + i * 2] - 128; V[o + i] = buf[uRow + i * 2 + 1] - 128; }
    else if (bits === 8) for (let i = 0; i < cw; i++) { U[o + i] = buf[uRow + i] - 128; V[o + i] = buf[vRow + i] - 128; }
    else for (let i = 0; i < cw; i++) {
      U[o + i] = (buf[uRow + i * 2] | (buf[uRow + i * 2 + 1] << 8)) * norm - center;
      V[o + i] = (buf[vRow + i * 2] | (buf[vRow + i * 2 + 1] << 8)) * norm - center;
    }
  }

  // horizontal pass: crows rows of w samples
  let Uh = U, Vh = V;
  if (sx) {
    const tx = taps(w, cw, 1, offX, filter);
    Uh = new Float32Array(w * crows); Vh = new Float32Array(w * crows);
    const { k, idx, wt } = tx;
    for (let j = 0; j < crows; j++) {
      const s = j * cw, o = j * w;
      if (k === 4) for (let x = 0, b = 0; x < w; x++, b += 4) {
        const q0 = s + idx[b], q1 = s + idx[b + 1], q2 = s + idx[b + 2], q3 = s + idx[b + 3];
        const a0 = wt[b], a1 = wt[b + 1], a2 = wt[b + 2], a3 = wt[b + 3];
        Uh[o + x] = a0 * U[q0] + a1 * U[q1] + a2 * U[q2] + a3 * U[q3];
        Vh[o + x] = a0 * V[q0] + a1 * V[q1] + a2 * V[q2] + a3 * V[q3];
      }
      else for (let x = 0, b = 0; x < w; x++, b += 2) {
        const q0 = s + idx[b], q1 = s + idx[b + 1], a0 = wt[b], a1 = wt[b + 1];
        Uh[o + x] = a0 * U[q0] + a1 * U[q1];
        Vh[o + x] = a0 * V[q0] + a1 * V[q1];
      }
    }
  }

  // vertical pass fused with the matrix: every output row reads up to four chroma rows
  const d = alloc(w, y1 - y0, true).d;
  const k = ty.k;
  // one row of chroma, vertically resampled, then the matrix (luma read per bit depth outside the hot branch)
  const Ur = new Float32Array(w), Vr = new Float32Array(w);
  for (let y = y0; y < y1; y++) {
    const yRow = L0.offset + (y - ly0) * L0.stride;
    const b = y * k;
    const r0 = (ty.idx[b] - ca) * w, a0 = ty.wt[b];
    if (k === 1) { Ur.set(Uh.subarray(r0, r0 + w)); Vr.set(Vh.subarray(r0, r0 + w)); }
    else if (k === 2) {
      const r1 = (ty.idx[b + 1] - ca) * w, a1 = ty.wt[b + 1];
      for (let x = 0; x < w; x++) { Ur[x] = a0 * Uh[r0 + x] + a1 * Uh[r1 + x]; Vr[x] = a0 * Vh[r0 + x] + a1 * Vh[r1 + x]; }
    } else {
      const r1 = (ty.idx[b + 1] - ca) * w, r2 = (ty.idx[b + 2] - ca) * w, r3 = (ty.idx[b + 3] - ca) * w;
      const a1 = ty.wt[b + 1], a2 = ty.wt[b + 2], a3 = ty.wt[b + 3];
      for (let x = 0; x < w; x++) {
        Ur[x] = a0 * Uh[r0 + x] + a1 * Uh[r1 + x] + a2 * Uh[r2 + x] + a3 * Uh[r3 + x];
        Vr[x] = a0 * Vh[r0 + x] + a1 * Vh[r1 + x] + a2 * Vh[r2 + x] + a3 * Vh[r3 + x];
      }
    }
    let o = (y - y0) * w * 4;
    if (bits === 8) for (let x = 0; x < w; x++, o += 4) {
      const yy = (buf[yRow + x] - yo) * ys, u = Ur[x], v = Vr[x];
      d[o] = yy + crR * v; d[o + 1] = yy + cbG * u + crG * v; d[o + 2] = yy + cbB * u;
    }
    else for (let x = 0; x < w; x++, o += 4) {
      const yy = ((buf[yRow + x * 2] | (buf[yRow + x * 2 + 1] << 8)) * norm - yo) * ys, u = Ur[x], v = Vr[x];
      d[o] = yy + crR * v; d[o + 1] = yy + cbG * u + crG * v; d[o + 2] = yy + cbB * u;
    }
  }
  return d;
}

export function rgbxToFrame(buf: Uint8Array, layout: PlaneLayoutLike[], format: string, w: number, h: number): Frame {
  const out = alloc(w, h, true);
  const d = out.d;
  const bgr = format.startsWith("BGR");
  const L = layout[0];
  for (let y = 0; y < h; y++) {
    let s = L.offset + y * L.stride;
    let o = y * w * 4;
    for (let x = 0; x < w; x++, s += 4, o += 4) {
      d[o] = buf[bgr ? s + 2 : s]; d[o + 1] = buf[s + 1]; d[o + 2] = buf[bgr ? s : s + 2];
    }
  }
  return out;
}

/** Color facts of a stream: signaled matrix (WebCodecs names), range and chroma siting, when known. */
export interface StreamColor { matrix?: string | null; fullRange?: boolean | null; siting?: Siting | null }
export interface YuvOptions { colorRange?: string; matrix?: string; chroma?: string; siting?: string }

/** Resolve "auto" choices from the stream color space. */
export function resolveYuv(opts: YuvOptions | undefined, cs: StreamColor | undefined, height: number): YuvParams {
  let matrix: Matrix;
  if (opts?.matrix === "bt601" || opts?.matrix === "bt709" || opts?.matrix === "bt2020") matrix = opts.matrix;
  else matrix = autoMatrix(cs?.matrix, height);
  let full: boolean;
  if (opts?.colorRange === "full") full = true;
  else if (opts?.colorRange === "limited") full = false;
  else full = cs?.fullRange === true;
  const chroma = (CHROMA_FILTERS as readonly string[]).includes(opts?.chroma ?? "") ? (opts!.chroma as ChromaFilter) : DEFAULT_CHROMA;
  const siting = (SITINGS as readonly string[]).includes(opts?.siting ?? "") ? (opts!.siting as Siting) : (cs?.siting ?? "left");
  return { matrix, full, chroma, siting };
}

/** Matrix from the signaled coefficients, else the documented convention: BT.601 for SD, BT.709 for HD. */
export function autoMatrix(signaled: string | null | undefined, height: number): Matrix {
  if (signaled === "bt709") return "bt709";
  if (signaled === "bt470bg" || signaled === "smpte170m") return "bt601";
  if (signaled === "bt2020-ncl") return "bt2020";
  return height >= 720 ? "bt709" : "bt601";
}

export const MATRIX_LABEL: Record<Matrix, string> = { bt601: "BT.601", bt709: "BT.709", bt2020: "BT.2020" };

// ---------------------------------------------------------------- multi-core conversion
defineKernel("yuvRows", (a: { buf: Uint8Array; layout: PlaneLayoutLike[]; format: string; w: number; h: number; p: YuvParams; y0: number; y1: number; ly0: number; c0: number }) =>
  yuvRows(a.buf, a.layout, a.format, a.w, a.h, a.p, a.y0, a.y1, a.ly0, a.c0));

/**
 * yuvToFrame on all cores: bands of output rows, each job carrying a copy of just the luma and chroma rows it
 * reads. Every row is converted by the same code as in yuvToFrame, so the frame is identical.
 */
export async function yuvToFrameP(buf: Uint8Array, layout: PlaneLayoutLike[], format: string, w: number, h: number, p: YuvParams): Promise<Frame> {
  // The browser's video decoder needs CPU time too: with fewer than three lanes (dual-core machines) splitting
  // the conversion slows playback down (measured), so it stays in one thread there.
  if (!parallelWorthIt(w * h * 24) || (laneCount() < 3 && !forcedBandCount())) return yuvToFrame(buf, layout, format, w, h, p);
  const fi = formatInfo(format);
  const L0 = layout[0], L1 = layout[1], L2 = fi.nv12 ? layout[1] : layout[2];
  const rows = (L: PlaneLayoutLike, a: number, b: number) => buf.subarray(L.offset + a * L.stride, Math.min(buf.length, L.offset + b * L.stride));
  const bands = rowBands(h, bandCount(), 16);
  const jobs = bands.map(([y0, y1]): Job => {
    const [ca, cb] = chromaRowsFor(format, w, h, p, y0, y1);
    const yLen = (y1 - y0) * L0.stride, uLen = (cb - ca) * L1.stride, vLen = fi.nv12 ? 0 : (cb - ca) * L2.stride;
    const b = new Uint8Array(yLen + uLen + vLen);
    b.set(rows(L0, y0, y1), 0);
    b.set(rows(L1, ca, cb), yLen);
    if (!fi.nv12) b.set(rows(L2, ca, cb), yLen + uLen);
    const lay = fi.nv12 ? [{ offset: 0, stride: L0.stride }, { offset: yLen, stride: L1.stride }]
      : [{ offset: 0, stride: L0.stride }, { offset: yLen, stride: L1.stride }, { offset: yLen + uLen, stride: L2.stride }];
    return { args: { buf: b, layout: lay, format, w, h, p, y0, y1, ly0: y0, c0: ca }, transfer: [b.buffer] };
  });
  const res = await runJobs<Float32Array>("yuvRows", jobs);
  const d = new Float32Array(w * h * 4);
  res.forEach((band, k) => d.set(band, bands[k][0] * w * 4));
  return { w, h, d };
}
