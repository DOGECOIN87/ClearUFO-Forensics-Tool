// Filters that change the number/order of frames or combine several frames.
import type { ParamValues, RectP } from "../../shared/types";
import { alloc, luma, type Frame } from "../frame";
import { hannWindowed, nextPow2, phaseCorrelate } from "../kernels/fft";
import { downPlane, matchTemplate, matchTemplateP, resize, translate } from "../kernels/geometry";
import type { SourceProvider } from "../sources/types";
import { clampFrameIndex, constantStream, mapStream, needInput, remapStream, type BuildCtx, type FilterImpl, type Stream } from "../stream";
import { deinterlaceFrame } from "./basic";

// ---------------------------------------------------------------- helpers
function thumb(f: Frame, roi: RectP | null, size = 64): Float32Array {
  const Y = luma(f);
  const x0 = roi ? Math.max(0, Math.round(roi.x)) : 0, y0 = roi ? Math.max(0, Math.round(roi.y)) : 0;
  const w = roi ? Math.max(1, Math.min(f.w - x0, Math.round(roi.w))) : f.w, h = roi ? Math.max(1, Math.min(f.h - y0, Math.round(roi.h))) : f.h;
  const tw = Math.min(size, w), th = Math.min(size, h);
  const out = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    let s = 0, n = 0;
    const sx0 = x0 + Math.floor((x * w) / tw), sx1 = x0 + Math.max(Math.floor(((x + 1) * w) / tw), Math.floor((x * w) / tw) + 1);
    const sy0 = y0 + Math.floor((y * h) / th), sy1 = y0 + Math.max(Math.floor(((y + 1) * h) / th), Math.floor((y * h) / th) + 1);
    for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) { s += Y[yy * f.w + xx]; n++; }
    out[y * tw + x] = s / Math.max(1, n);
  }
  return out;
}

const mad = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

async function scan(input: Stream, ctx: BuildCtx, label: string, fn: (f: Frame, i: number) => void) {
  const n = input.info.frameCount;
  for (let i = 0; i < n; i++) {
    if (ctx.isStale()) throw new Error("Cancelled");
    fn(await input.getFrame(i), i);
    if (i % 5 === 0) ctx.progress(label, i / n);
  }
  ctx.progress(label, 1);
}

export function parseFrameList(s: string, n: number): number[] {
  const out: number[] = [];
  for (const part of String(s || "").split(/[,;\s]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) { const a = +m[1], b = +m[2]; for (let i = Math.min(a, b); i <= Math.max(a, b) && out.length < 1e6; i++) if (i < n) out.push(i); }
    else if (/^\d+$/.test(part) && +part < n) out.push(+part);
  }
  return out;
}

// ---------------------------------------------------------------- select frames
const single: FilterImpl = (input, p) => { const s = needInput(input); return remapStream(s, [clampFrameIndex(p.frame, s.info.frameCount)]); };

const range: FilterImpl = (input, p) => {
  const s = needInput(input), n = s.info.frameCount;
  const a = clampFrameIndex(p.start, n), b = clampFrameIndex(p.end, n, true);
  const idx: number[] = [];
  for (let i = Math.min(a, b); i <= Math.max(a, b); i += Math.max(1, p.step | 0)) idx.push(i);
  return remapStream(s, idx);
};

const sparse: FilterImpl = (input, p) => {
  const s = needInput(input);
  const idx = parseFrameList(p.frames, s.info.frameCount);
  if (!idx.length) throw new Error("No valid frames in the list");
  return remapStream(s, idx);
};

const removeDuplicates: FilterImpl = async (input, p, ctx) => {
  const s = needInput(input);
  const keep: number[] = [];
  let last: Float32Array | null = null;
  await scan(s, ctx, "Removing duplicates", (f, i) => {
    const t = thumb(f, p.roi);
    if (!last || mad(t, last) > p.threshold) { keep.push(i); last = t; }
  });
  return remapStream(s, keep);
};

const frameType: FilterImpl = async (input, p, ctx) => {
  const s = needInput(input);
  // wait for the background frame type analysis of the source when needed
  const src: SourceProvider | null = ctx.sourceOfChain();
  if (src?.analyze && !src.info.frameTypesReady) await src.analyze((v) => ctx.progress("Analyzing frame types", v));
  const keep: number[] = [];
  for (let i = 0; i < s.info.frameCount; i++) {
    const t = s.meta(i).type;
    if ((t === "I" && p.keepI) || (t === "P" && p.keepP) || (t === "B" && p.keepB) || (t === "?" && p.keepI)) keep.push(i);
  }
  if (!keep.length) throw new Error("No frames of the selected types");
  return remapStream(s, keep);
};

const demux: FilterImpl = async (input, p, ctx) => {
  const s = needInput(input);
  const ref = thumb(await s.getFrame(clampFrameIndex(p.reference, s.info.frameCount)), p.roi);
  const keep: number[] = [];
  await scan(s, ctx, "Demultiplexing", (f, i) => {
    const t = thumb(f, p.roi);
    // similarity: 100 = identical, using normalized correlation of thumbnails
    let ma = 0, mb = 0;
    for (let k = 0; k < t.length; k++) { ma += t[k]; mb += ref[k]; }
    ma /= t.length; mb /= t.length;
    let num = 0, da = 0, db = 0;
    for (let k = 0; k < t.length; k++) { const x = t[k] - ma, y = ref[k] - mb; num += x * y; da += x * x; db += y * y; }
    const sim = da > 0 && db > 0 ? (num / Math.sqrt(da * db)) * 100 : 100 - mad(t, ref);
    if (sim >= p.threshold) keep.push(i);
  });
  if (!keep.length) throw new Error("No frames are similar to the reference frame: lower the threshold");
  return remapStream(s, keep);
};

const motion: FilterImpl = async (input, p, ctx) => {
  const s = needInput(input);
  const keep: number[] = [];
  let prev: Float32Array | null = null;
  await scan(s, ctx, "Detecting motion", (f, i) => {
    const t = thumb(f, p.roi, 96);
    let moving = false;
    if (prev) {
      let c = 0;
      for (let k = 0; k < t.length; k++) if (Math.abs(t[k] - prev[k]) > p.threshold) c++;
      moving = (c / t.length) * 100 >= p.minArea;
    }
    if ((p.mode === "motion") === moving || (i === 0 && p.mode === "still")) keep.push(i);
    prev = t;
  });
  if (!keep.length) throw new Error(p.mode === "motion" ? "No motion detected in the region" : "No still frames found");
  return remapStream(s, keep);
};

// ---------------------------------------------------------------- deinterlacing (temporal / geometry changing)
const deinterlace: FilterImpl = (input, p) => {
  const s = needInput(input);
  if (p.method !== "bob") return mapStream(s, (f) => deinterlaceFrame(f, p.field === "top", p.method));
  const n = s.info.frameCount;
  const topFirst = p.field === "top";
  return {
    info: { ...s.info, frameCount: n * 2, fps: s.info.fps * 2 },
    meta: (i) => ({ ...s.meta(i >> 1), pts: (s.meta(i >> 1).pts ?? (i >> 1) / s.info.fps) + (i & 1) / (s.info.fps * 2) }),
    getFrame: async (i) => deinterlaceFrame(await s.getFrame(i >> 1), (i & 1) === 0 ? topFirst : !topFirst, "linear"),
  };
};

function fieldOf(f: Frame, bottom: boolean): Frame {
  const h2 = Math.floor((f.h + (bottom ? 0 : 1)) / 2);
  const out = alloc(f.w, h2, false);
  for (let y = 0; y < h2; y++) { const sy = y * 2 + (bottom ? 1 : 0); if (sy < f.h) out.d.set(f.d.subarray(sy * f.w * 4, (sy + 1) * f.w * 4), y * f.w * 4); }
  return out;
}

const fieldSeparation: FilterImpl = (input, p) => {
  const s = needInput(input);
  if (p.mode === "sequence") {
    const h2 = Math.ceil(s.info.height / 2);
    return {
      info: { ...s.info, frameCount: s.info.frameCount * 2, fps: s.info.fps * 2, height: h2 },
      meta: (i) => s.meta(i >> 1),
      getFrame: async (i) => { const f = fieldOf(await s.getFrame(i >> 1), (i & 1) === 1); return f.h === h2 ? f : resize(f, f.w, h2, "nearest"); },
    };
  }
  return mapStream(s, (f) => {
    const top = fieldOf(f, false), bot = fieldOf(f, true), out = alloc(f.w, f.h, true);
    out.d.set(top.d, 0);
    out.d.set(bot.d.subarray(0, Math.min(bot.d.length, out.d.length - top.d.length)), top.d.length);
    return out;
  });
};

const interleave: FilterImpl = (input, p) => {
  const s = needInput(input);
  const n = Math.max(1, Math.floor(s.info.frameCount / 2));
  return {
    info: { ...s.info, frameCount: n, fps: s.info.fps / 2 },
    meta: (i) => s.meta(i * 2),
    getFrame: async (i) => {
      const a = await s.getFrame(i * 2), b = await s.getFrame(Math.min(s.info.frameCount - 1, i * 2 + 1));
      const out = alloc(a.w, a.h, true);
      const first = p.first === "top" ? a : b, second = p.first === "top" ? b : a;
      for (let y = 0; y < a.h; y++) { const src = (y & 1) === 0 ? first : second; out.d.set(src.d.subarray(y * a.w * 4, (y + 1) * a.w * 4), y * a.w * 4); }
      return out;
    },
  };
};

// ---------------------------------------------------------------- extract (temporal)
const frameDifference: FilterImpl = (input, p) => {
  const s = needInput(input);
  return mapStream(s, async (f, i) => {
    const prev = await s.getFrame(Math.max(0, i - Math.max(1, p.offset | 0)));
    const out = alloc(f.w, f.h, true);
    for (let k = 0; k < f.d.length; k++) {
      if ((k & 3) === 3) continue;
      const d = (f.d[k] - prev.d[k]) * p.gain;
      out.d[k] = p.mode === "signed" ? 128 + d / 2 : Math.abs(d);
    }
    return out;
  });
};

// ---------------------------------------------------------------- stabilization
const localStab: FilterImpl = async (input, p, ctx) => {
  const s = needInput(input);
  const roi: RectP | null = p.roi;
  if (!roi || roi.w < 4 || roi.h < 4) return s;
  const ref = clampFrameIndex(p.reference, s.info.frameCount);
  const rf = await s.getFrame(ref);
  const RY = luma(rf);
  const rx = Math.max(0, Math.round(roi.x)), ry = Math.max(0, Math.round(roi.y));
  const rw = Math.min(rf.w - rx, Math.round(roi.w)), rh = Math.min(rf.h - ry, Math.round(roi.h));
  // template (downscaled when large for speed; refined at full resolution)
  const k = Math.max(1, Math.floor(Math.max(rw, rh) / 64));
  const tplFull = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) tplFull[y * rw + x] = RY[(ry + y) * rf.w + rx + x];
  const tplSmall = k > 1 ? downPlane(tplFull, rw, rh, k) : null;
  const cache = new Map<number, { dx: number; dy: number }>();
  // template matching on all cores (matchTemplateP: same positions and scores as the single-thread search)
  const track = async (f: Frame) => {
    const Y = luma(f);
    let cx = rx, cy = ry;
    if (tplSmall) {
      const sm = downPlane(Y, f.w, f.h, k);
      const m = await matchTemplateP(sm.d, sm.w, sm.h, tplSmall.d, tplSmall.w, tplSmall.h, rx / k, ry / k, Math.ceil(p.search / k) + 1, ctx.isStale);
      cx = m.x * k; cy = m.y * k;
      const r = await matchTemplateP(Y, f.w, f.h, tplFull, rw, rh, cx, cy, k + 1, ctx.isStale);
      return { dx: r.x - rx, dy: r.y - ry, score: r.score };
    }
    const r = await matchTemplateP(Y, f.w, f.h, tplFull, rw, rh, cx, cy, p.search, ctx.isStale);
    return { dx: r.x - rx, dy: r.y - ry, score: r.score };
  };
  return mapStream(s, async (f, i) => {
    if (i === ref) return f;
    let off = cache.get(i);
    if (!off) {
      const t = await track(f);
      off = p.subpixel ? { dx: t.dx, dy: t.dy } : { dx: Math.round(t.dx), dy: Math.round(t.dy) };
      cache.set(i, off);
    }
    return translate(f, -off.dx, -off.dy, p.fill === "edge");
  });
};

const globalStab: FilterImpl = async (input, p) => {
  const s = needInput(input);
  const ref = clampFrameIndex(p.reference, s.info.frameCount);
  const { width: w, height: h } = s.info;
  const S = Math.min(512, nextPow2(Math.max(w, h)) / 2);
  const k = Math.max(1, Math.ceil(Math.max(w, h) / S));
  const prep = (f: Frame) => { const d = downPlane(luma(f), f.w, f.h, k); return { win: hannWindowed(d.d, d.w, d.h, 0, 0, nextPow2(d.w), nextPow2(d.h)), W: nextPow2(d.w), H: nextPow2(d.h) }; };
  const R = prep(await s.getFrame(ref));
  const cache = new Map<number, { dx: number; dy: number }>();
  return mapStream(s, (f, i) => {
    if (i === ref) return f;
    let off = cache.get(i);
    if (!off) {
      const P = prep(f);
      const r = phaseCorrelate(R.win, P.win, R.W, R.H);
      off = { dx: r.dx * k, dy: r.dy * k };
      if (!p.subpixel) off = { dx: Math.round(off.dx), dy: Math.round(off.dy) };
      cache.set(i, off);
    }
    return translate(f, -off.dx, -off.dy, p.fill === "edge");
  });
};

// ---------------------------------------------------------------- integrate
async function combine(s: Stream, indices: number[], method: string, sigma: number, ctx: BuildCtx, label: string): Promise<Frame> {
  const first = await s.getFrame(indices[0]);
  const n = first.d.length;
  if (method === "mean") {
    const acc = new Float64Array(n);
    for (let k = 0; k < indices.length; k++) {
      if (ctx.isStale()) throw new Error("Cancelled");
      const f = k === 0 ? first : await s.getFrame(indices[k]);
      for (let i = 0; i < n; i++) acc[i] += f.d[i];
      if (indices.length > 8) ctx.progress(label, k / indices.length);
    }
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = acc[i] / indices.length;
    return { w: first.w, h: first.h, d: out };
  }
  // median / sigma clipped: gather 8-bit samples (bounded memory)
  const m = Math.min(indices.length, 99);
  const stack = new Uint8Array(n * m);
  for (let k = 0; k < m; k++) {
    if (ctx.isStale()) throw new Error("Cancelled");
    const f = k === 0 ? first : await s.getFrame(indices[k]);
    for (let i = 0; i < n; i++) stack[i * m + k] = f.d[i] < 0 ? 0 : f.d[i] > 255 ? 255 : Math.round(f.d[i]);
    if (m > 8) ctx.progress(label, k / m);
  }
  const out = new Float32Array(n), buf = new Uint8Array(m);
  for (let i = 0; i < n; i++) {
    if ((i & 3) === 3) { out[i] = 255; continue; }
    for (let k = 0; k < m; k++) buf[k] = stack[i * m + k];
    buf.sort();
    if (method === "median") { out[i] = m & 1 ? buf[m >> 1] : (buf[m / 2 - 1] + buf[m / 2]) / 2; continue; }
    let mean = 0;
    for (let k = 0; k < m; k++) mean += buf[k];
    mean /= m;
    let v = 0;
    for (let k = 0; k < m; k++) v += (buf[k] - mean) ** 2;
    const sd = Math.sqrt(v / m) || 1;
    let s2 = 0, c = 0;
    for (let k = 0; k < m; k++) if (Math.abs(buf[k] - mean) <= sigma * sd) { s2 += buf[k]; c++; }
    out[i] = c ? s2 / c : mean;
  }
  return { w: first.w, h: first.h, d: out };
}

const averaging: FilterImpl = async (input, p, ctx) => {
  const s = needInput(input), n = s.info.frameCount;
  if (p.mode === "all") {
    const idx = Array.from({ length: n }, (_, i) => i);
    const f = await combine(s, idx, p.method, p.sigma, ctx, "Averaging frames");
    return constantStream(f, s.info, { ...s.meta(0), type: "I" });
  }
  const win = Math.max(2, p.window | 0);
  return mapStream(s, async (_f, i) => {
    const a = Math.max(0, i - Math.floor((win - 1) / 2)), b = Math.min(n - 1, a + win - 1);
    const idx: number[] = [];
    for (let k = a; k <= b; k++) idx.push(k);
    return combine(s, idx, p.method, p.sigma, ctx, "Averaging frames");
  });
};

// ---------------------------------------------------------------- temporal smoothing
/*
 * Temporal Smoothing: every output frame combines the co-located pixels of the frames in a moving window around it;
 * the number of frames and their timing are unchanged (Brailean et al. 1995: temporal, motion-adaptive filtering).
 *  - Window: `size` frames, floor((size - 1) / 2) before the current frame and the rest after it (as the Moving
 *    Window of Frame Averaging), clipped at the ends of the clip, where fewer frames are combined.
 *  - Method: mean (equal weights), gaussian (weight exp(-k² / 2σ²) for the frame k frames away, σ = size / 4: the
 *    window spans ±2σ) or median (of each channel).
 *  - Motion protection: a pixel of a neighboring frame takes part only where its difference to the current frame is
 *    at most `threshold` levels. The difference is the largest of the absolute R, G and B differences (so a change
 *    of color at the same brightness counts as well as a change of brightness), averaged over the 3x3 area around
 *    the pixel with weights 1-2-1 x 1-2-1 / 16 (edges replicated): robust to noise, yet a thin moving line still
 *    counts with half its contrast. Moving subjects leave no ghost trails; the current frame always takes part.
 * Full float precision (no 8-bit rounding), double precision sums in time order, weights rounded to float32 (Math.exp
 * may differ in the last bit between JavaScript engines): the output is bit-exact on every run and machine, and the
 * same whichever way it is computed (all frames of the window kept and summed pixel by pixel, or streamed one at a
 * time for windows too large to keep). Alpha is the current frame's. Neighbors of a different size (resolution
 * change in a DVR stream) are left out.
 */
export type SmoothMethod = "mean" | "gaussian" | "median";
export interface SmoothOptions {
  size: number; method: SmoothMethod; protect: boolean; threshold: number; showMask: boolean;
  /** Largest window (bytes of frames) kept in memory at once; bigger windows are streamed. */
  holdBytes?: number;
}
const HOLD_BYTES = 512 * 1024 * 1024;

/** First and last input frame of the window of output frame i (n frames in the clip). */
export function smoothingWindow(i: number, n: number, size: number): [number, number] {
  const before = Math.floor((size - 1) / 2);
  return [Math.max(0, i - before), Math.min(n - 1, i - before + size - 1)];
}

/** Weight of the frame k frames away from the current one. */
export function smoothingWeight(method: SmoothMethod, k: number, size: number): number {
  if (method !== "gaussian") return 1;
  const sigma = size / 4;
  return Math.fround(Math.exp(-(k * k) / (2 * sigma * sigma)));
}

/** Row y of the motion statistic before the vertical pass: largest absolute R/G/B difference per pixel, then the
 * horizontal 1-2-1 sum (edges replicated), into ring[o..o+w). */
function diffRow(a: Float32Array, b: Float32Array, w: number, y: number, ring: Float32Array, o: number, dy: Float32Array) {
  for (let x = 0, q = y * w * 4; x < w; x++, q += 4) {
    const dr = Math.abs(b[q] - a[q]), dg = Math.abs(b[q + 1] - a[q + 1]), db = Math.abs(b[q + 2] - a[q + 2]);
    const m = dr > dg ? dr : dg;
    dy[x] = m > db ? m : db;
  }
  if (w === 1) { ring[o] = dy[0] + 2 * dy[0] + dy[0]; return; }
  ring[o] = dy[0] + 2 * dy[0] + dy[1];
  for (let x = 1; x < w - 1; x++) ring[o + x] = dy[x - 1] + 2 * dy[x] + dy[x + 1];
  ring[o + w - 1] = dy[w - 2] + 2 * dy[w - 1] + dy[w - 1];
}

/**
 * Motion test of a whole neighboring frame (streamed path): sets `bit` in bits[p] where the 1-2-1 weighted 3x3 mean
 * of the largest R/G/B difference to the current frame is at most `threshold` (still); moving pixels are left alone.
 * The horizontal sums of the last three rows are kept in `ring` (3 * w), `dy` (w) holds one row of differences.
 */
function motionBits(cur: Frame, nb: Frame, threshold: number, bits: Uint32Array, bit: number, ring: Float32Array, dy: Float32Array) {
  const { w, h } = cur, a = cur.d, b = nb.d, lim = 16 * threshold;
  diffRow(a, b, w, 0, ring, 0, dy);
  for (let y = 0; y < h; y++) {
    if (y + 1 < h) diffRow(a, b, w, y + 1, ring, ((y + 1) % 3) * w, dy);
    const o0 = ((y > 0 ? y - 1 : 0) % 3) * w, o1 = (y % 3) * w, o2 = ((y < h - 1 ? y + 1 : y) % 3) * w, r = y * w;
    for (let x = 0; x < w; x++) if (ring[o0 + x] + 2 * ring[o1 + x] + ring[o2 + x] <= lim) bits[r + x] |= bit;
  }
}

const med3 = (a: number, b: number, c: number) => (a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b);
/** Devillard's 7-exchange median-of-5 network (branches beat Math.min/max, which also handle NaN and -0, in V8). */
function med5(a: number, b: number, c: number, d: number, e: number) {
  let t: number;
  if (a > b) { t = a; a = b; b = t; }
  if (d > e) { t = d; d = e; e = t; }
  if (a > d) { d = a; }
  if (b > e) { b = e; }
  if (b > c) { t = b; b = c; c = t; }
  if (c > d) { c = d; }
  return b > c ? b : c;
}

/** Median of buf[0..k) (mean of the two middle values when k is even); may reorder buf. */
export function medianInPlace(buf: Float64Array, k: number): number {
  if (k === 1) return buf[0];
  if (k === 3) return med3(buf[0], buf[1], buf[2]);
  if (k === 5) return med5(buf[0], buf[1], buf[2], buf[3], buf[4]);
  const mid = k >> 1;
  if (k <= 16) {
    for (let i = 1; i < k; i++) { const v = buf[i]; let j = i - 1; while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; } buf[j + 1] = v; }
    return k & 1 ? buf[mid] : (buf[mid - 1] + buf[mid]) / 2;
  }
  // Wirth's selection: afterwards buf[mid] is the mid-th smallest, everything before it is <= and after it >=
  let l = 0, m = k - 1;
  while (l < m) {
    const x = buf[mid];
    let i = l, j = m;
    do {
      while (buf[i] < x) i++;
      while (x < buf[j]) j--;
      if (i <= j) { const t = buf[i]; buf[i] = buf[j]; buf[j] = t; i++; j--; }
    } while (i <= j);
    if (j < mid) l = i;
    if (mid < i) m = j;
  }
  if (k & 1) return buf[mid];
  let lo = buf[0];
  for (let i = 1; i < mid; i++) if (buf[i] > lo) lo = buf[i];
  return (lo + buf[mid]) / 2;
}

/** Streaming: acc/kept += weight * frame where the mask allows (no mask: everywhere). */
function accumulate(acc: Float64Array, kept: Float64Array | null, d: Float32Array, wk: number, mk: Uint32Array | null) {
  const np = acc.length / 3;
  if (!mk) {
    for (let q = 0, t = 0, e = np * 4; q < e; q += 4, t += 3) { acc[t] += wk * d[q]; acc[t + 1] += wk * d[q + 1]; acc[t + 2] += wk * d[q + 2]; }
    if (kept) for (let p = 0; p < np; p++) kept[p] += wk;
    return;
  }
  for (let p = 0, q = 0, t = 0; p < np; p++, q += 4, t += 3) {
    if (mk[p] === 0) continue;
    acc[t] += wk * d[q]; acc[t + 1] += wk * d[q + 1]; acc[t + 2] += wk * d[q + 2]; kept![p] += wk;
  }
}
/** Show Protected Areas: the pixel in gray, tinted red in proportion to the weight left out because of motion
 * (red minus green = 255 x 0.6 x the share left out), so the marks show on any color. */
function maskPixel(out: Float32Array, q: number, keptFraction: number) {
  const s = 0.6 * (1 - keptFraction), g = 0.299 * out[q] + 0.587 * out[q + 1] + 0.114 * out[q + 2];
  out[q] = g + (255 - g) * s; out[q + 1] = g * (1 - s); out[q + 2] = g * (1 - s);
}

/** One output frame. `get(j)` returns input frame j; frames are fetched in time order. */
export async function smoothFrame(get: (j: number) => Promise<Frame>, i: number, n: number, o: SmoothOptions, isStale: () => boolean = () => false): Promise<Frame> {
  const cur = await get(i);
  const [a, b] = smoothingWindow(i, n, o.size);
  if (a === b) return cur;
  const { w, h } = cur, np = w * h, cd = cur.d;
  const ring = o.protect ? new Float32Array(3 * w) : null, dy = o.protect ? new Float32Array(w) : null;
  const out = new Float32Array(np * 4);
  const keep = b - a + 1 <= 31 && (o.method === "median" || (b - a + 1) * np * 16 <= (o.holdBytes ?? HOLD_BYTES));
  if (!keep) {
    // streamed (windows too large to keep): one input frame at a time, sums over the whole image
    const acc = new Float64Array(np * 3), kept = o.protect ? new Float64Array(np) : null, mask = o.protect ? new Uint32Array(np) : null;
    let total = 0;
    for (let j = a; j <= b; j++) {
      if (isStale()) throw new Error("Cancelled");
      const f = j === i ? cur : await get(j);
      if (f.w !== w || f.h !== h) continue;
      const wk = smoothingWeight(o.method, j - i, o.size);
      total += wk;
      if (mask && j !== i) { mask.fill(0); motionBits(cur, f, o.threshold, mask, 1, ring!, dy!); }
      accumulate(acc, kept, f.d, wk, mask && j !== i ? mask : null);
    }
    for (let p = 0, q = 0, t = 0; p < np; p++, q += 4, t += 3) {
      const ws = kept ? kept[p] : total;
      out[q] = acc[t] / ws; out[q + 1] = acc[t + 1] / ws; out[q + 2] = acc[t + 2] / ws; out[q + 3] = cd[q + 3];
      if (o.showMask && kept) maskPixel(out, q, kept[p] / total);
    }
    return { w, h, d: out };
  }
  // every frame of the window (time order) with its weight
  const frames: Frame[] = [], data: Float32Array[] = [], wts: number[] = [];
  let total = 0, ct = 0;
  for (let j = a; j <= b; j++) {
    if (isStale()) throw new Error("Cancelled");
    const f = j === i ? cur : await get(j);
    if (f.w !== w || f.h !== h) continue;
    if (j === i) ct = frames.length;
    const wk = smoothingWeight(o.method, j - i, o.size);
    frames.push(f); data.push(f.d); wts.push(wk);
    total += wk;
  }
  const m = frames.length, W = Float64Array.from(wts);
  // One sweep over the rows: the motion test of row y + 1 against every neighbor, then row y of the output. Each
  // frame row is read from memory once (the test brings it into the CPU cache for the output row that follows).
  // bit t of rowBits[x]: frame t takes part at pixel x of the current row.
  const lim = 16 * o.threshold, rowBits = new Uint32Array(w).fill(1 << ct);
  const rings = o.protect ? frames.map((_, t) => (t === ct ? null : new Float32Array(3 * w))) : null;
  if (rings) for (let t = 0; t < m; t++) if (rings[t]) diffRow(cd, data[t], w, 0, rings[t]!, 0, dy!);
  const sel = new Int32Array(m), buf = new Float64Array(m), median = o.method === "median";
  for (let y = 0; y < h; y++) {
    if ((y & 63) === 63 && isStale()) throw new Error("Cancelled");
    if (rings) {
      rowBits.fill(1 << ct);
      const o0 = ((y > 0 ? y - 1 : 0) % 3) * w, o1 = (y % 3) * w, o2 = ((y < h - 1 ? y + 1 : y) % 3) * w;
      for (let t = 0; t < m; t++) {
        const ring = rings[t];
        if (!ring) continue;
        if (y + 1 < h) diffRow(cd, data[t], w, y + 1, ring, ((y + 1) % 3) * w, dy!);
        const bit = 1 << t;
        for (let x = 0; x < w; x++) if (ring[o0 + x] + 2 * ring[o1 + x] + ring[o2 + x] <= lim) rowBits[x] |= bit;
      }
    }
    if (!median) {
      // the sums stay in registers; frames in time order
      for (let x = 0, q = y * w * 4; x < w; x++, q += 4) {
        let s0 = 0, s1 = 0, s2 = 0, ws = total;
        if (rings) {
          ws = 0;
          for (let t = 0, bt = rowBits[x]; bt !== 0; t++, bt >>>= 1) {
            if ((bt & 1) === 0) continue;
            const d = data[t], wk = W[t];
            s0 += wk * d[q]; s1 += wk * d[q + 1]; s2 += wk * d[q + 2]; ws += wk;
          }
        } else {
          for (let t = 0; t < m; t++) { const d = data[t], wk = W[t]; s0 += wk * d[q]; s1 += wk * d[q + 1]; s2 += wk * d[q + 2]; }
        }
        out[q] = s0 / ws; out[q + 1] = s1 / ws; out[q + 2] = s2 / ws; out[q + 3] = cd[q + 3];
        if (o.showMask && rings) maskPixel(out, q, ws / total);
      }
      continue;
    }
    for (let x = 0, q = y * w * 4; x < w; x++, q += 4) {
      let k = 0;
      if (rings) { for (let t = 0, bt = rowBits[x]; bt !== 0; t++, bt >>>= 1) if (bt & 1) sel[k++] = t; }
      else for (; k < m; k++) sel[k] = k;
      if (k === 5) {
        const d0 = data[sel[0]], d1 = data[sel[1]], d2 = data[sel[2]], d3 = data[sel[3]], d4 = data[sel[4]];
        for (let c = q; c < q + 3; c++) out[c] = med5(d0[c], d1[c], d2[c], d3[c], d4[c]);
      } else if (k === 3) {
        const d0 = data[sel[0]], d1 = data[sel[1]], d2 = data[sel[2]];
        for (let c = q; c < q + 3; c++) out[c] = med3(d0[c], d1[c], d2[c]);
      } else {
        for (let c = 0; c < 3; c++) {
          for (let t = 0; t < k; t++) buf[t] = data[sel[t]][q + c];
          out[q + c] = medianInPlace(buf, k);
        }
      }
      out[q + 3] = cd[q + 3];
      if (o.showMask && rings) maskPixel(out, q, k / m);
    }
  }
  return { w, h, d: out };
}

export function smoothOptions(p: ParamValues): SmoothOptions {
  const method: SmoothMethod = p.method === "median" ? "median" : p.method === "gaussian" ? "gaussian" : "mean";
  const protect = p.protect !== false;
  return { size: Math.max(2, Math.min(31, Math.round(+p.size || 5))), method, protect, threshold: Math.max(0, +p.threshold || 0), showMask: protect && !!p.showMask };
}

const temporalSmoothing: FilterImpl = (input, p, ctx) => {
  const s = needInput(input), o = smoothOptions(p);
  return mapStream(s, (cur, i) => smoothFrame((j) => (j === i ? Promise.resolve(cur) : s.getFrame(j)), i, s.info.frameCount, o, () => ctx.isStale()));
};

const superRes: FilterImpl = async (input, p, ctx) => {
  const s = needInput(input);
  const n = Math.min(s.info.frameCount, Math.max(2, p.maxFrames | 0));
  const S = Math.max(2, Math.min(4, p.scale | 0));
  const ref = await s.getFrame(0);
  const { w, h } = ref;
  const roi: RectP = p.roi && p.roi.w >= 16 && p.roi.h >= 16 ? p.roi : { x: 0, y: 0, w, h };
  const pow2floor = (v: number) => 2 ** Math.floor(Math.log2(Math.max(2, v)));
  const RW = Math.max(32, Math.min(256, pow2floor(roi.w))), RH = Math.max(32, Math.min(256, pow2floor(roi.h)));
  const cx = Math.round(roi.x + roi.w / 2 - RW / 2), cy = Math.round(roi.y + roi.h / 2 - RH / 2);
  const refWin = hannWindowed(luma(ref), w, h, cx, cy, RW, RH);
  const W2 = w * S, H2 = h * S;
  const acc = new Float64Array(W2 * H2 * 3), wsum = new Float64Array(W2 * H2);
  const sig = 0.6 * S, rad = Math.ceil(sig * 2);
  for (let k = 0; k < n; k++) {
    if (ctx.isStale()) throw new Error("Cancelled");
    const f = k === 0 ? ref : await s.getFrame(k);
    const sh = k === 0 ? { dx: 0, dy: 0 } : phaseCorrelate(refWin, hannWindowed(luma(f), w, h, cx, cy, RW, RH), RW, RH);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const X = (x - sh.dx + 0.5) * S - 0.5, Y = (y - sh.dy + 0.5) * S - 0.5;
      const o = (y * w + x) * 4;
      if (p.kernel === "bilinear") {
        const x0 = Math.floor(X), y0 = Math.floor(Y), fx = X - x0, fy = Y - y0;
        // the four bilinear taps, in the same order and with the same arithmetic as before (no per-pixel arrays)
        for (let t = 0; t < 4; t++) {
          const tx = x0 + (t & 1), ty = y0 + (t >> 1);
          const wt = t === 0 ? (1 - fx) * (1 - fy) : t === 1 ? fx * (1 - fy) : t === 2 ? (1 - fx) * fy : fx * fy;
          if (tx < 0 || ty < 0 || tx >= W2 || ty >= H2 || wt <= 0) continue;
          const q = ty * W2 + tx;
          acc[q * 3] += f.d[o] * wt; acc[q * 3 + 1] += f.d[o + 1] * wt; acc[q * 3 + 2] += f.d[o + 2] * wt; wsum[q] += wt;
        }
      } else {
        const x0 = Math.round(X), y0 = Math.round(Y);
        for (let ty = y0 - rad; ty <= y0 + rad; ty++) {
          if (ty < 0 || ty >= H2) continue;
          for (let tx = x0 - rad; tx <= x0 + rad; tx++) {
            if (tx < 0 || tx >= W2) continue;
            const wt = Math.exp(-((tx - X) ** 2 + (ty - Y) ** 2) / (2 * sig * sig));
            const q = ty * W2 + tx;
            acc[q * 3] += f.d[o] * wt; acc[q * 3 + 1] += f.d[o + 1] * wt; acc[q * 3 + 2] += f.d[o + 2] * wt; wsum[q] += wt;
          }
        }
      }
    }
    ctx.progress("Super resolution", (k + 1) / n);
  }
  const base = resize(ref, W2, H2, "bicubic");
  const out = alloc(W2, H2, true);
  for (let q = 0; q < W2 * H2; q++) {
    const ws = wsum[q];
    const blend = Math.min(1, ws / 0.5);
    for (let c = 0; c < 3; c++) out.d[q * 4 + c] = ws > 1e-6 ? (acc[q * 3 + c] / ws) * blend + base.d[q * 4 + c] * (1 - blend) : base.d[q * 4 + c];
  }
  return constantStream(out, { ...s.info, width: W2, height: H2 }, { ...s.meta(0), type: "I" });
};

// ---------------------------------------------------------------- frame rate / order
const changeFps: FilterImpl = (input, p) => { const s = needInput(input); return { info: { ...s.info, fps: p.fps }, getFrame: (i) => s.getFrame(i), meta: (i) => ({ ...s.meta(i), pts: i / p.fps }) }; };

const convertFps: FilterImpl = (input, p) => {
  const s = needInput(input), n = s.info.frameCount, fps0 = s.info.fps;
  const m = Math.max(1, Math.round((n * p.fps) / fps0));
  return {
    info: { ...s.info, frameCount: m, fps: p.fps },
    meta: (j) => ({ ...s.meta(Math.min(n - 1, Math.round((j * fps0) / p.fps))), pts: j / p.fps }),
    getFrame: async (j) => {
      const t = (j * fps0) / p.fps;
      if (p.method !== "blend") return s.getFrame(Math.min(n - 1, Math.round(t)));
      const a = Math.min(n - 1, Math.floor(t)), b = Math.min(n - 1, a + 1), fr = t - a;
      if (fr < 1e-3 || a === b) return s.getFrame(a);
      const fa = await s.getFrame(a), fb = await s.getFrame(b);
      const out = new Float32Array(fa.d.length);
      for (let i = 0; i < out.length; i++) out[i] = fa.d[i] * (1 - fr) + fb.d[i] * fr;
      return { w: fa.w, h: fa.h, d: out };
    },
  };
};

const reverse: FilterImpl = (input) => { const s = needInput(input), n = s.info.frameCount; return remapStream(s, Array.from({ length: n }, (_, i) => n - 1 - i)); };

const freeze: FilterImpl = (input, p) => {
  const s = needInput(input), n = s.info.frameCount;
  const at = clampFrameIndex(p.frame, n), dur = Math.max(1, p.duration | 0);
  const idx: number[] = [];
  for (let i = 0; i <= at; i++) idx.push(i);
  for (let k = 1; k < dur; k++) idx.push(at);
  for (let i = at + 1; i < n; i++) idx.push(i);
  return remapStream(s, idx);
};

export const temporalFilters: Record<string, FilterImpl> = {
  single_selector: single, range_selector: range, sparse_selector: sparse, remove_duplicates: removeDuplicates, iframes_selector: frameType,
  demultiplexer: demux, motion_detection: motion, deinterlace, field_separation: fieldSeparation, interleave,
  frame_difference: frameDifference, local_stabilization: localStab, global_stabilization: globalStab,
  frame_averaging: averaging, temporal_smoothing: temporalSmoothing, super_resolution: superRes, change_frame_rate: changeFps, convert_frame_rate: convertFps, reverse, freeze_frame: freeze,
};

export type { ParamValues };
