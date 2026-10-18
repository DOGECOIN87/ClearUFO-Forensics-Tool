// Geometric transforms: resampling, warping, homographies and template matching.
import type { Pt } from "../../shared/types";
import { alloc, type Frame } from "../frame";
import { bandCount, defineKernel, parallelWorthIt, rowBands, runJobs, type Job } from "../pool";

export type Interp = "nearest" | "bilinear" | "bicubic" | "lanczos";

function kernelFn(interp: Interp): [(x: number) => number, number] {
  switch (interp) {
    case "bilinear": return [(x) => { x = Math.abs(x); return x < 1 ? 1 - x : 0; }, 1];
    case "bicubic": return [(x) => {
      const a = -0.5;
      x = Math.abs(x);
      if (x < 1) return (a + 2) * x * x * x - (a + 3) * x * x + 1;
      if (x < 2) return a * x * x * x - 5 * a * x * x + 8 * a * x - 4 * a;
      return 0;
    }, 2];
    case "lanczos": return [(x) => {
      x = Math.abs(x);
      if (x < 1e-8) return 1;
      if (x >= 3) return 0;
      const px = Math.PI * x;
      return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
    }, 3];
    default: return [() => 1, 0.5];
  }
}

interface Weights { start: Int32Array; count: Int32Array; w: Float32Array; maxTaps: number }

function computeWeights(src: number, dst: number, interp: Interp): Weights {
  const scale = src / dst;
  const [k, support] = kernelFn(interp);
  const fs = Math.max(1, scale); // filter scale when downsampling (antialiasing)
  const sup = support * fs;
  const maxTaps = Math.ceil(sup * 2) + 2;
  const start = new Int32Array(dst), count = new Int32Array(dst), w = new Float32Array(dst * maxTaps);
  for (let i = 0; i < dst; i++) {
    const center = (i + 0.5) * scale - 0.5;
    const s = Math.floor(center - sup) + 1, e = Math.floor(center + sup);
    let sum = 0, c = 0;
    const s0 = Math.max(0, s), e0 = Math.min(src - 1, e);
    for (let j = s0; j <= e0 && c < maxTaps; j++, c++) { const v = k((j - center) / fs); w[i * maxTaps + c] = v; sum += v; }
    if (c === 0) { w[i * maxTaps] = 1; c = 1; sum = 1; start[i] = Math.min(src - 1, Math.max(0, Math.round(center))); }
    else start[i] = s0;
    for (let j = 0; j < c; j++) w[i * maxTaps + j] /= sum || 1;
    count[i] = c;
  }
  return { start, count, w, maxTaps };
}

export function resize(f: Frame, nw: number, nh: number, interp: Interp): Frame {
  nw = Math.max(1, Math.round(nw)); nh = Math.max(1, Math.round(nh));
  if (nw === f.w && nh === f.h) return { w: f.w, h: f.h, d: new Float32Array(f.d) };
  if (interp === "nearest") {
    const out = alloc(nw, nh, false);
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(f.h - 1, Math.floor(((y + 0.5) * f.h) / nh));
      for (let x = 0; x < nw; x++) {
        const sx = Math.min(f.w - 1, Math.floor(((x + 0.5) * f.w) / nw));
        const s = (sy * f.w + sx) * 4, o = (y * nw + x) * 4;
        out.d[o] = f.d[s]; out.d[o + 1] = f.d[s + 1]; out.d[o + 2] = f.d[s + 2]; out.d[o + 3] = f.d[s + 3];
      }
    }
    return out;
  }
  const wx = computeWeights(f.w, nw, interp), wy = computeWeights(f.h, nh, interp);
  const tmp = new Float32Array(nw * f.h * 4);
  for (let y = 0; y < f.h; y++) {
    const row = y * f.w * 4;
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const st = wx.start[x], c = wx.count[x], base = x * wx.maxTaps;
      for (let j = 0; j < c; j++) {
        const wt = wx.w[base + j], s = row + (st + j) * 4;
        r += f.d[s] * wt; g += f.d[s + 1] * wt; b += f.d[s + 2] * wt; a += f.d[s + 3] * wt;
      }
      const o = (y * nw + x) * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }
  const out = alloc(nw, nh, false);
  for (let y = 0; y < nh; y++) {
    const st = wy.start[y], c = wy.count[y], base = y * wy.maxTaps;
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < c; j++) {
        const wt = wy.w[base + j], s = ((st + j) * nw + x) * 4;
        r += tmp[s] * wt; g += tmp[s + 1] * wt; b += tmp[s + 2] * wt; a += tmp[s + 3] * wt;
      }
      const o = (y * nw + x) * 4;
      out.d[o] = r; out.d[o + 1] = g; out.d[o + 2] = b; out.d[o + 3] = a;
    }
  }
  return out;
}

const cubic = (x: number) => {
  const a = -0.5;
  x = Math.abs(x);
  if (x < 1) return (a + 2) * x * x * x - (a + 3) * x * x + 1;
  if (x < 2) return a * x * x * x - 5 * a * x * x + 8 * a * x - 4 * a;
  return 0;
};

/** Sample a frame at a sub-pixel position. Returns false when outside (and edge mode is "none"). */
export function sampleInto(f: Frame, x: number, y: number, interp: Interp, out: Float32Array, edge: boolean): boolean {
  const { w, h, d } = f;
  if (!edge && (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5)) return false;
  const cx = (v: number) => (v < 0 ? 0 : v >= w ? w - 1 : v), cy = (v: number) => (v < 0 ? 0 : v >= h ? h - 1 : v);
  if (interp === "nearest") {
    const s = (cy(Math.round(y)) * w + cx(Math.round(x))) * 4;
    out[0] = d[s]; out[1] = d[s + 1]; out[2] = d[s + 2]; out[3] = d[s + 3];
    return true;
  }
  if (interp === "bilinear") {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const a = (cy(y0) * w + cx(x0)) * 4, b = (cy(y0) * w + cx(x0 + 1)) * 4, c = (cy(y0 + 1) * w + cx(x0)) * 4, e = (cy(y0 + 1) * w + cx(x0 + 1)) * 4;
    for (let k = 0; k < 4; k++) out[k] = (d[a + k] * (1 - fx) + d[b + k] * fx) * (1 - fy) + (d[c + k] * (1 - fx) + d[e + k] * fx) * fy;
    return true;
  }
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let j = -1; j <= 2; j++) {
    const wy = cubic(j - fy), row = cy(y0 + j) * w;
    for (let i = -1; i <= 2; i++) {
      const wt = wy * cubic(i - fx), s = (row + cx(x0 + i)) * 4;
      out[0] += d[s] * wt; out[1] += d[s + 1] * wt; out[2] += d[s + 2] * wt; out[3] += d[s + 3] * wt;
    }
  }
  return true;
}

/** Inverse warping: for each output pixel `map` writes the source position into `p`. */
export function warp(f: Frame, ow: number, oh: number, map: (x: number, y: number, p: Float64Array) => void, interp: Interp, bg: [number, number, number] = [0, 0, 0], edge = false): Frame {
  const out = alloc(ow, oh, true);
  const p = new Float64Array(2), s = new Float32Array(4);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    map(x, y, p);
    const o = (y * ow + x) * 4;
    if (sampleInto(f, p[0], p[1], interp, s, edge)) { out.d[o] = s[0]; out.d[o + 1] = s[1]; out.d[o + 2] = s[2]; }
    else { out.d[o] = bg[0]; out.d[o + 1] = bg[1]; out.d[o + 2] = bg[2]; }
  }
  return out;
}

export function translate(f: Frame, dx: number, dy: number, edge: boolean): Frame {
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return f;
  return warp(f, f.w, f.h, (x, y, p) => { p[0] = x - dx; p[1] = y - dy; }, "bilinear", [0, 0, 0], edge);
}

/** Solve the 3x3 homography H mapping src[i] → dst[i] (4 correspondences). */
export function homography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) throw new Error("Degenerate point configuration");
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const k = A[r][c] / A[c][c];
      for (let j = c; j < 9; j++) A[r][j] -= k * A[c][j];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return [...h, 1];
}

export function applyH(H: number[], x: number, y: number): [number, number] {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error("Singular matrix");
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** Normalized cross-correlation search of `tpl` around (cx, cy) ± search. Returns the best top-left position (sub-pixel). */
interface MatchSetup { t: Float32Array; tn: number; x0: number; x1: number; y0: number; y1: number }

/** Zero-mean template, its norm and the search window (null when the template does not fit). */
function matchSetup(iw: number, ih: number, tpl: Float32Array, tw: number, th: number, cx: number, cy: number, search: number): MatchSetup | null {
  let tm = 0;
  for (let i = 0; i < tpl.length; i++) tm += tpl[i];
  tm /= tpl.length;
  const t = new Float32Array(tpl.length);
  let tn = 0;
  for (let i = 0; i < tpl.length; i++) { t[i] = tpl[i] - tm; tn += t[i] * t[i]; }
  tn = Math.sqrt(tn) || 1;
  const x0 = Math.max(0, Math.round(cx - search)), x1 = Math.min(iw - tw, Math.round(cx + search));
  const y0 = Math.max(0, Math.round(cy - search)), y1 = Math.min(ih - th, Math.round(cy + search));
  if (x1 < x0 || y1 < y0) return null;
  return { t, tn, x0, x1, y0, y1 };
}

/**
 * Normalized cross-correlation scores of the positions in rows ya..yb (columns x0..x1) and the first best one in
 * scan order. `img` holds image rows from `wy0` on (ya .. yb + th - 1 at least).
 */
export function matchRows(img: Float32Array, iw: number, wy0: number, t: Float32Array, tw: number, th: number, tn: number, x0: number, x1: number, ya: number, yb: number) {
  const sw = x1 - x0 + 1;
  const scores = new Float32Array(sw * (yb - ya + 1));
  let best = -2, bx = x0, by = ya;
  const n = tw * th;
  for (let y = ya; y <= yb; y++) for (let x = x0; x <= x1; x++) {
    let s = 0, s2 = 0, cross = 0;
    for (let j = 0; j < th; j++) {
      const row = (y + j - wy0) * iw + x, trow = j * tw;
      for (let i = 0; i < tw; i++) { const v = img[row + i]; s += v; s2 += v * v; cross += v * t[trow + i]; }
    }
    const varI = s2 - (s * s) / n;
    const score = varI > 1e-9 ? cross / (Math.sqrt(varI) * tn) : 0;
    scores[(y - ya) * sw + (x - x0)] = score;
    if (score > best) { best = score; bx = x; by = y; }
  }
  return { scores, best, bx, by };
}

/** Sub-pixel position from the score surface around the best position. */
function matchResult(M: MatchSetup, scores: Float32Array, best: number, bx: number, by: number): { x: number; y: number; score: number } {
  const { x0, x1, y0, y1 } = M;
  const sw = x1 - x0 + 1, sh = y1 - y0 + 1;
  const at = (x: number, y: number) => scores[Math.min(sh - 1, Math.max(0, y - y0)) * sw + Math.min(sw - 1, Math.max(0, x - x0))];
  const sub = (m: number, c: number, p: number) => { const d = m - 2 * c + p; return Math.abs(d) < 1e-9 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (m - p)) / d)); };
  const sx = bx > x0 && bx < x1 ? sub(at(bx - 1, by), best, at(bx + 1, by)) : 0;
  const sy = by > y0 && by < y1 ? sub(at(bx, by - 1), best, at(bx, by + 1)) : 0;
  return { x: bx + sx, y: by + sy, score: best };
}

export function matchTemplate(img: Float32Array, iw: number, ih: number, tpl: Float32Array, tw: number, th: number, cx: number, cy: number, search: number): { x: number; y: number; score: number } {
  const M = matchSetup(iw, ih, tpl, tw, th, cx, cy, search);
  if (!M) return { x: cx, y: cy, score: 0 };
  const r = matchRows(img, iw, 0, M.t, tw, th, M.tn, M.x0, M.x1, M.y0, M.y1);
  return matchResult(M, r.scores, r.best, r.bx, r.by);
}

defineKernel("matchRows", (a: { img: Float32Array; iw: number; wy0: number; t: Float32Array; tw: number; th: number; tn: number; x0: number; x1: number; ya: number; yb: number }) =>
  matchRows(a.img, a.iw, a.wy0, a.t, a.tw, a.th, a.tn, a.x0, a.x1, a.ya, a.yb));

/**
 * matchTemplate on all cores: bands of search rows; merging the bands in scan order with a strict comparison
 * keeps the first best position, exactly as the single-thread scan does.
 */
export async function matchTemplateP(img: Float32Array, iw: number, ih: number, tpl: Float32Array, tw: number, th: number, cx: number, cy: number, search: number, isCancelled?: () => boolean): Promise<{ x: number; y: number; score: number }> {
  const M = matchSetup(iw, ih, tpl, tw, th, cx, cy, search);
  if (!M) return { x: cx, y: cy, score: 0 };
  const sw = M.x1 - M.x0 + 1, sh = M.y1 - M.y0 + 1;
  if (sh < 2 || !parallelWorthIt(sw * sh * tw * th * 4)) return matchTemplate(img, iw, ih, tpl, tw, th, cx, cy, search);
  const bands = rowBands(sh, bandCount(), 1);
  const jobs = bands.map(([a, b]): Job => {
    const ya = M.y0 + a, yb = M.y0 + b - 1;
    const win = img.slice(ya * iw, (yb + th) * iw);
    return { args: { img: win, iw, wy0: ya, t: M.t, tw, th, tn: M.tn, x0: M.x0, x1: M.x1, ya, yb }, transfer: [win.buffer] };
  });
  const res = await runJobs<{ scores: Float32Array; best: number; bx: number; by: number }>("matchRows", jobs, isCancelled);
  const scores = new Float32Array(sw * sh);
  let best = -2, bx = M.x0, by = M.y0;
  res.forEach((r, k) => {
    scores.set(r.scores, bands[k][0] * sw);
    if (r.best > best) { best = r.best; bx = r.bx; by = r.by; }
  });
  return matchResult(M, scores, best, bx, by);
}

/** Downscale a plane by an integer factor (box average). */
export function downPlane(p: Float32Array, w: number, h: number, k: number): { d: Float32Array; w: number; h: number } {
  const nw = Math.max(1, Math.floor(w / k)), nh = Math.max(1, Math.floor(h / k));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    let s = 0;
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += p[(y * k + j) * w + x * k + i];
    out[y * nw + x] = s / (k * k);
  }
  return { d: out, w: nw, h: nh };
}
