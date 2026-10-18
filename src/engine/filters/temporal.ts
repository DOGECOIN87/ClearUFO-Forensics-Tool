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
  frame_averaging: averaging, super_resolution: superRes, change_frame_rate: changeFps, convert_frame_rate: convertFps, reverse, freeze_frame: freeze,
};

export type { ParamValues };
