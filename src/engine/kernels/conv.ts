// Spatial filtering kernels operating on planar float data (edge pixels replicated).
import { luma, merge, split, type Frame } from "../frame";
import { bandCount, defineKernel, laneCount, parallelWorthIt, rowBands, runJobs, threadCount, windowOf, type Job } from "../pool";

const clampi = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export function boxBlurPlane(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return new Float32Array(src);
  const tmp = new Float32Array(src.length), dst = new Float32Array(src.length);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + clampi(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * inv;
      acc += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[clampi(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * inv;
      acc += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
    }
  }
  return dst;
}

export function gaussKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

export function convolveSep(src: Float32Array, w: number, h: number, kx: Float32Array, ky: Float32Array): Float32Array {
  return convolveSepRows(src, w, h, 0, 0, h, kx, ky);
}

/**
 * Rows [y0, y1) of the separable convolution of an image of height h. `src` holds image rows from `wy0` on and
 * must include the ky.length >> 1 rows above and below the band (clamped to the image). The full image is the
 * band [0, h): every output value is computed by the same expression whatever the band.
 */
export function convolveSepRows(src: Float32Array, w: number, h: number, wy0: number, y0: number, y1: number, kx: Float32Array, ky: Float32Array): Float32Array {
  const rx = kx.length >> 1, ry = ky.length >> 1;
  const ty0 = Math.max(0, y0 - ry), ty1 = Math.min(h, y1 + ry);
  const tmp = new Float32Array((ty1 - ty0) * w), dst = new Float32Array((y1 - y0) * w);
  for (let y = ty0; y < ty1; y++) {
    const row = (y - wy0) * w, trow = (y - ty0) * w;
    for (let x = 0; x < w; x++) {
      let a = 0;
      if (x >= rx && x < w - rx) { const base = row + x - rx; for (let k = 0; k < kx.length; k++) a += src[base + k] * kx[k]; }
      else for (let k = 0; k < kx.length; k++) a += src[row + clampi(x + k - rx, 0, w - 1)] * kx[k];
      tmp[trow + x] = a;
    }
  }
  for (let y = y0; y < y1; y++) {
    const orow = (y - y0) * w;
    for (let x = 0; x < w; x++) {
      let a = 0;
      if (y >= ry && y < h - ry) { let idx = (y - ry - ty0) * w + x; for (let k = 0; k < ky.length; k++, idx += w) a += tmp[idx] * ky[k]; }
      else for (let k = 0; k < ky.length; k++) a += tmp[(clampi(y + k - ry, 0, h - 1) - ty0) * w + x] * ky[k];
      dst[orow + x] = a;
    }
  }
  return dst;
}

/** Gaussian blur; large sigmas use three box passes (≈ Gaussian, O(1) per pixel). */
export function blurPlane(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0.05) return new Float32Array(src);
  if (sigma <= 3) { const k = gaussKernel(sigma); return convolveSep(src, w, h, k, k); }
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  let out = src;
  for (let i = 0; i < n; i++) out = boxBlurPlane(out, w, h, ((i < m ? wl : wu) - 1) / 2);
  return out;
}

export function mapRGB(f: Frame, fn: (p: Float32Array) => Float32Array): Frame {
  const [r, g, b, a] = split(f);
  return merge(f.w, f.h, fn(r), fn(g), fn(b), a);
}

export const gaussianBlur = (f: Frame, sigma: number) => mapRGB(f, (p) => blurPlane(p, f.w, f.h, sigma));
export const boxBlur = (f: Frame, r: number) => mapRGB(f, (p) => boxBlurPlane(p, f.w, f.h, r));

export function conv3x3(src: Float32Array, w: number, h: number, k: number[]): Float32Array {
  const dst = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1), y2 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1), x2 = Math.min(w - 1, x + 1);
      dst[y * w + x] =
        k[0] * src[y0 * w + x0] + k[1] * src[y0 * w + x] + k[2] * src[y0 * w + x2] +
        k[3] * src[y * w + x0] + k[4] * src[y * w + x] + k[5] * src[y * w + x2] +
        k[6] * src[y2 * w + x0] + k[7] * src[y2 * w + x] + k[8] * src[y2 * w + x2];
    }
  }
  return dst;
}

// ---------------------------------------------------------------- median
/** Rows [y0, y1) of the 3x3 median; `src` holds image rows from `wy0` on (band ± 1 row). */
function median3Rows(src: Float32Array, w: number, h: number, wy0: number, y0: number, y1: number): Float32Array {
  const dst = new Float32Array((y1 - y0) * w);
  for (let y = y0; y < y1; y++) {
    const r0 = (Math.max(0, y - 1) - wy0) * w, r1 = (y - wy0) * w, r2 = (Math.min(h - 1, y + 1) - wy0) * w, ro = (y - y0) * w;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? x - 1 : 0, xr = x < w - 1 ? x + 1 : w - 1;
      let p0 = src[r0 + xl], p1 = src[r0 + x], p2 = src[r0 + xr];
      let p3 = src[r1 + xl], p4 = src[r1 + x], p5 = src[r1 + xr];
      let p6 = src[r2 + xl], p7 = src[r2 + x], p8 = src[r2 + xr];
      let t: number;
      // 19 compare-exchange median-of-9 network (Paeth / Devillard)
      if (p1 > p2) { t = p1; p1 = p2; p2 = t; } if (p4 > p5) { t = p4; p4 = p5; p5 = t; } if (p7 > p8) { t = p7; p7 = p8; p8 = t; }
      if (p0 > p1) { t = p0; p0 = p1; p1 = t; } if (p3 > p4) { t = p3; p3 = p4; p4 = t; } if (p6 > p7) { t = p6; p6 = p7; p7 = t; }
      if (p1 > p2) { t = p1; p1 = p2; p2 = t; } if (p4 > p5) { t = p4; p4 = p5; p5 = t; } if (p7 > p8) { t = p7; p7 = p8; p8 = t; }
      if (p0 > p3) { t = p0; p0 = p3; p3 = t; } if (p5 > p8) { t = p5; p5 = p8; p8 = t; } if (p4 > p7) { t = p4; p4 = p7; p7 = t; }
      if (p3 > p6) { t = p3; p3 = p6; p6 = t; } if (p1 > p4) { t = p1; p1 = p4; p4 = t; } if (p2 > p5) { t = p2; p2 = p5; p5 = t; }
      if (p4 > p7) { t = p4; p4 = p7; p7 = t; } if (p4 > p2) { t = p4; p4 = p2; p2 = t; } if (p6 > p4) { t = p6; p6 = p4; p4 = t; }
      if (p4 > p2) { p4 = p2; }
      dst[ro + x] = p4;
    }
  }
  return dst;
}

/** Huang's sliding histogram median (values quantized to 0..255). */
export function medianPlane(src: Float32Array, w: number, h: number, r: number): Float32Array {
  return medianRows(src, w, h, 0, 0, h, r);
}

/** Rows [y0, y1) of the median of radius r; `src` holds image rows from `wy0` on (band ± r rows, clamped). */
export function medianRows(src: Float32Array, w: number, h: number, wy0: number, y0: number, y1: number, r: number): Float32Array {
  if (r <= 1) return median3Rows(src, w, h, wy0, y0, y1);
  const q = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) q[i] = clampi(Math.round(src[i]), 0, 255);
  const dst = new Float32Array((y1 - y0) * w);
  const hist = new Int32Array(256);
  const half = ((2 * r + 1) * (2 * r + 1)) >> 1;
  for (let y = y0; y < y1; y++) {
    hist.fill(0);
    for (let dy = -r; dy <= r; dy++) {
      const row = (clampi(y + dy, 0, h - 1) - wy0) * w;
      for (let dx = -r; dx <= r; dx++) hist[q[row + clampi(dx, 0, w - 1)]]++;
    }
    let med = 0, below = 0;
    // find initial median
    let acc = 0;
    for (med = 0; med < 256; med++) { if (acc + hist[med] > half) break; acc += hist[med]; }
    below = acc;
    for (let x = 0; x < w; x++) {
      dst[(y - y0) * w + x] = med;
      if (x === w - 1) break;
      const xo = clampi(x - r, 0, w - 1), xi = clampi(x + r + 1, 0, w - 1);
      for (let dy = -r; dy <= r; dy++) {
        const row = (clampi(y + dy, 0, h - 1) - wy0) * w;
        const vo = q[row + xo], vi = q[row + xi];
        hist[vo]--; if (vo < med) below--;
        hist[vi]++; if (vi < med) below++;
      }
      while (below > half) { med--; below -= hist[med]; }
      while (below + hist[med] <= half) { below += hist[med]; med++; }
    }
  }
  return dst;
}

// ---------------------------------------------------------------- bilateral (luma guided range weights)
export const bilateralRadius = (sigmaS: number) => Math.max(1, Math.ceil(sigmaS * 2));

export function bilateral(f: Frame, sigmaS: number, sigmaR: number): Frame {
  return { w: f.w, h: f.h, d: bilateralRows(f.d, f.w, f.h, 0, 0, f.h, sigmaS, sigmaR) };
}

/** Rows [y0, y1) (RGBA) of the bilateral filter; `d` holds RGBA rows from `wy0` on (band ± radius rows). */
export function bilateralRows(d: Float32Array, w: number, h: number, wy0: number, y0: number, y1: number, sigmaS: number, sigmaR: number): Float32Array {
  const r = bilateralRadius(sigmaS);
  // BT.601 luma of the rows present (the expression of frame.luma, so the same values)
  const Y = new Float32Array(d.length >> 2);
  for (let i = 0, j = 0; i < Y.length; i++, j += 4) Y[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  const sw = new Float32Array((2 * r + 1) * (2 * r + 1));
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) sw[(dy + r) * (2 * r + 1) + dx + r] = Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS));
  const rw = new Float32Array(512);
  for (let i = 0; i < 512; i++) rw[i] = Math.exp(-(i * i) / (2 * sigmaR * sigmaR));
  const out = new Float32Array((y1 - y0) * w * 4);
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) {
    const c = (y - wy0) * w + x;
    const yc = Y[c];
    let ws = 0, ar = 0, ag = 0, ab = 0;
    for (let dy = -r; dy <= r; dy++) {
      const yy = clampi(y + dy, 0, h - 1) - wy0;
      for (let dx = -r; dx <= r; dx++) {
        const xx = clampi(x + dx, 0, w - 1);
        const idx = yy * w + xx;
        const wt = sw[(dy + r) * (2 * r + 1) + dx + r] * rw[Math.min(511, Math.abs(Y[idx] - yc) | 0)];
        const k = idx * 4;
        ws += wt; ar += d[k] * wt; ag += d[k + 1] * wt; ab += d[k + 2] * wt;
      }
    }
    const o = ((y - y0) * w + x) * 4;
    out[o] = ar / ws; out[o + 1] = ag / ws; out[o + 2] = ab / ws; out[o + 3] = d[c * 4 + 3];
  }
  return out;
}

// ---------------------------------------------------------------- non-local means (integral image formulation)
export function nlMeans(f: Frame, hParam: number, patch: number, search: number, isCancelled?: () => boolean): Frame {
  return { w: f.w, h: f.h, d: nlMeansRows(luma(f), f.d, 0, f.w, f.h, 0, f.h, hParam, patch, search, isCancelled) };
}

/**
 * Rows [y0, y1) (RGBA) of non-local means. `Y` holds luma rows 0 .. min(h, y1 + patch + search) (the integral
 * image is accumulated from the top row, as for the whole image, so every patch distance is the same number);
 * `d` holds RGBA rows from `dw0` on, covering the band ± search rows.
 */
export function nlMeansRows(Y: Float32Array, d: Float32Array, dw0: number, w: number, h: number, y0: number, y1: number, hParam: number, patch: number, search: number, isCancelled?: () => boolean): Float32Array {
  const n = (y1 - y0) * w;
  const rows = Math.min(h, y1 + patch); // integral rows needed: 0 .. rows
  const accR = new Float64Array(n), accG = new Float64Array(n), accB = new Float64Array(n), wsum = new Float64Array(n), wmax = new Float64Array(n);
  const diff = new Float64Array((w + 1) * (rows + 1));
  const area = (2 * patch + 1) * (2 * patch + 1);
  const h2 = hParam * hParam;
  for (let dy = -search; dy <= search; dy++) {
    for (let dx = -search; dx <= search; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (isCancelled?.()) throw new Error("Cancelled");
      // integral image of squared differences
      for (let y = 0; y < rows; y++) {
        let rowSum = 0;
        const yy = clampi(y + dy, 0, h - 1);
        for (let x = 0; x < w; x++) {
          const xx = clampi(x + dx, 0, w - 1);
          const t = Y[y * w + x] - Y[yy * w + xx];
          rowSum += t * t;
          diff[(y + 1) * (w + 1) + x + 1] = diff[y * (w + 1) + x + 1] + rowSum;
        }
      }
      for (let y = y0; y < y1; y++) {
        const ya = Math.max(0, y - patch), yb = Math.min(h - 1, y + patch) + 1;
        const yy = clampi(y + dy, 0, h - 1) - dw0;
        for (let x = 0; x < w; x++) {
          const x0 = Math.max(0, x - patch), x1 = Math.min(w - 1, x + patch) + 1;
          const ssd = (diff[yb * (w + 1) + x1] - diff[ya * (w + 1) + x1] - diff[yb * (w + 1) + x0] + diff[ya * (w + 1) + x0]) / ((yb - ya) * (x1 - x0) || area);
          const wt = Math.exp(-ssd / h2);
          const i = (y - y0) * w + x;
          const k = (yy * w + clampi(x + dx, 0, w - 1)) * 4;
          accR[i] += wt * d[k]; accG[i] += wt * d[k + 1]; accB[i] += wt * d[k + 2];
          wsum[i] += wt;
          if (wt > wmax[i]) wmax[i] = wt;
        }
      }
    }
  }
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const wc = wmax[i] || 1, o = i * 4, k = ((y0 - dw0) * w + i) * 4, ws = wsum[i] + wc;
    out[o] = (accR[i] + wc * d[k]) / ws; out[o + 1] = (accG[i] + wc * d[k + 1]) / ws; out[o + 2] = (accB[i] + wc * d[k + 2]) / ws; out[o + 3] = d[k + 3];
  }
  return out;
}

// ---------------------------------------------------------------- adaptive Wiener (Lim)
export function wienerAdaptive(f: Frame, r: number, noise: number): Frame {
  return mapRGB(f, (p) => wienerPlane(p, f.w, f.h, r, noise));
}

/** One channel of the adaptive Wiener filter (channels are independent). */
export function wienerPlane(p: Float32Array, w: number, h: number, r: number, noise: number): Float32Array {
  {
    const sq = new Float32Array(p.length);
    for (let i = 0; i < p.length; i++) sq[i] = p[i] * p[i];
    const mu = boxBlurPlane(p, w, h, r), mu2 = boxBlurPlane(sq, w, h, r);
    const vari = new Float32Array(p.length);
    let mean = 0;
    for (let i = 0; i < p.length; i++) { vari[i] = Math.max(0, mu2[i] - mu[i] * mu[i]); mean += vari[i]; }
    const nv = noise > 0 ? noise : mean / p.length;
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i++) out[i] = mu[i] + (Math.max(0, vari[i] - nv) / Math.max(vari[i], nv || 1e-6)) * (p[i] - mu[i]);
    return out;
  }
}

// ---------------------------------------------------------------- deblocking
export function deblock(f: Frame, B: number, strength: number, thr: number): Frame {
  const { w, h } = f;
  const beta = thr / 2, tc = (thr / 2) * strength;
  const filt = (p: Float32Array, idx: (i: number) => number, len: number, at: number) => {
    if (at < 2 || at > len - 2) return;
    const p1 = p[idx(at - 2)], p0 = p[idx(at - 1)], q0 = p[idx(at)], q1 = p[idx(at + 1)];
    if (Math.abs(p0 - q0) >= thr || Math.abs(p1 - p0) >= beta || Math.abs(q1 - q0) >= beta) return;
    let delta = ((q0 - p0) * 4 + (p1 - q1)) / 8;
    delta = Math.max(-tc, Math.min(tc, delta)) * strength + delta * (1 - strength) * 0.25;
    p[idx(at - 1)] = p0 + delta;
    p[idx(at)] = q0 - delta;
    p[idx(at - 2)] = p1 + delta * 0.5 * strength;
    p[idx(at + 1)] = q1 - delta * 0.5 * strength;
  };
  return mapRGB(f, (src) => {
    const p = new Float32Array(src);
    for (let y = 0; y < h; y++) for (let x = B; x < w; x += B) filt(p, (i) => y * w + i, w, x);
    for (let x = 0; x < w; x++) for (let y = B; y < h; y += B) filt(p, (i) => i * w + x, h, y);
    return p;
  });
}

// ---------------------------------------------------------------- multi-core versions
// Each runs the row (or channel) functions above on the kernel pool; the single-thread functions run the same
// functions over the whole image, so both give identical results (tests/perf.test.ts, filter hash suite).
type Cancel = (() => boolean) | undefined;

defineKernel("convSepRows", (a: { src: Float32Array; w: number; h: number; wy0: number; y0: number; y1: number; kx: Float32Array; ky: Float32Array }) =>
  convolveSepRows(a.src, a.w, a.h, a.wy0, a.y0, a.y1, a.kx, a.ky));
defineKernel("medianRows", (a: { src: Float32Array; w: number; h: number; wy0: number; y0: number; y1: number; r: number }) =>
  medianRows(a.src, a.w, a.h, a.wy0, a.y0, a.y1, a.r));
defineKernel("bilateralRows", (a: { d: Float32Array; w: number; h: number; wy0: number; y0: number; y1: number; sigmaS: number; sigmaR: number }) =>
  bilateralRows(a.d, a.w, a.h, a.wy0, a.y0, a.y1, a.sigmaS, a.sigmaR));
defineKernel("nlMeansRows", (a: { Y: Float32Array; d: Float32Array; dw0: number; w: number; h: number; y0: number; y1: number; hParam: number; patch: number; search: number }) =>
  nlMeansRows(a.Y, a.d, a.dw0, a.w, a.h, a.y0, a.y1, a.hParam, a.patch, a.search));
defineKernel("blurPlane", (a: { src: Float32Array; w: number; h: number; sigma: number }) => blurPlane(a.src, a.w, a.h, a.sigma));
defineKernel("wienerPlane", (a: { p: Float32Array; w: number; h: number; r: number; noise: number }) => wienerPlane(a.p, a.w, a.h, a.r, a.noise));

/** Row bands of several planes as one job list (so all threads stay busy); returns the full output planes. */
async function planesByRows(kernel: string, planes: Float32Array[], w: number, h: number, halo: number, extra: object, isCancelled: Cancel): Promise<Float32Array[]> {
  const bands = rowBands(h, Math.max(1, Math.ceil(bandCount() / planes.length)));
  const jobs: Job[] = [], where: [number, number][] = [];
  planes.forEach((pl, pi) => {
    for (const [y0, y1] of bands) {
      const [a, b] = windowOf(h, y0, y1, halo);
      const src = pl.slice(a * w, b * w);
      jobs.push({ args: { src, w, h, wy0: a, y0, y1, ...extra }, transfer: [src.buffer] });
      where.push([pi, y0]);
    }
  });
  const res = await runJobs<Float32Array>(kernel, jobs, isCancelled);
  const outs = planes.map(() => new Float32Array(w * h));
  res.forEach((r, j) => outs[where[j][0]].set(r, where[j][1] * w));
  return outs;
}

/** Per-channel jobs (R, G, B planes); alpha kept. */
async function channelJobs(f: Frame, kernel: string, args: (p: Float32Array) => object, isCancelled: Cancel): Promise<Frame> {
  const [r, g, b, a] = split(f);
  const out = await runJobs<Float32Array>(kernel, [r, g, b].map((p) => ({ args: args(p), transfer: [p.buffer] })), isCancelled);
  return merge(f.w, f.h, out[0], out[1], out[2], a);
}

/** gaussianBlur on all cores: small sigmas split by rows; large ones (running box sums down columns) by channel. */
export async function gaussianBlurP(f: Frame, sigma: number, isCancelled?: Cancel): Promise<Frame> {
  const { w, h } = f;
  if (sigma <= 0.05) return gaussianBlur(f, sigma);
  if (sigma <= 3) {
    const k = gaussKernel(sigma);
    if (!parallelWorthIt(w * h * 6 * k.length)) return gaussianBlur(f, sigma);
    const [r, g, b, a] = split(f);
    const p = await planesByRows("convSepRows", [r, g, b], w, h, k.length >> 1, { kx: k, ky: k }, isCancelled);
    return merge(w, h, p[0], p[1], p[2], a);
  }
  if (!parallelWorthIt(w * h * 40)) return gaussianBlur(f, sigma);
  return channelJobs(f, "blurPlane", (src) => ({ src, w, h, sigma }), isCancelled);
}

export async function medianP(f: Frame, r: number, isCancelled?: Cancel): Promise<Frame> {
  const { w, h } = f;
  if (!parallelWorthIt(w * h * 3 * (r <= 1 ? 25 : 6 * (2 * r + 1)))) return mapRGB(f, (pl) => medianPlane(pl, w, h, r));
  const [R, G, B, A] = split(f);
  const p = await planesByRows("medianRows", [R, G, B], w, h, Math.max(1, r), { r }, isCancelled);
  return merge(w, h, p[0], p[1], p[2], A);
}

export async function bilateralP(f: Frame, sigmaS: number, sigmaR: number, isCancelled?: Cancel): Promise<Frame> {
  const { w, h } = f, r = bilateralRadius(sigmaS);
  if (!parallelWorthIt(w * h * (2 * r + 1) * (2 * r + 1) * 6)) return bilateral(f, sigmaS, sigmaR);
  const bands = rowBands(h, bandCount());
  const jobs = bands.map(([y0, y1]): Job => {
    const [a, b] = windowOf(h, y0, y1, r);
    const d = f.d.slice(a * w * 4, b * w * 4);
    return { args: { d, w, h, wy0: a, y0, y1, sigmaS, sigmaR }, transfer: [d.buffer] };
  });
  const res = await runJobs<Float32Array>("bilateralRows", jobs, isCancelled);
  const out = new Float32Array(f.d.length);
  res.forEach((band, j) => out.set(band, bands[j][0] * w * 4));
  return { w, h, d: out };
}

/**
 * Bands for non-local means with equal cost: a band accumulates the integral image from the top row down to its
 * end (cheap, about 1 unit per row) and computes weights for its own rows (an exp per pixel, about 6 units).
 */
export function nlmBands(h: number, n: number, patch: number): [number, number][] {
  const A = 1, B = 6;
  const ends = (C: number) => {
    const e: number[] = [];
    let prev = 0;
    for (let k = 0; k < n; k++) { prev = Math.max(prev + 1, Math.floor((C + B * prev - A * patch) / (A + B))); e.push(prev); }
    return e;
  };
  let lo = 0, hi = (A + B) * (h + patch) * 2;
  for (let it = 0; it < 64; it++) { const mid = (lo + hi) / 2; if (ends(mid)[n - 1] >= h) hi = mid; else lo = mid; }
  const e = ends(hi), out: [number, number][] = [];
  let prev = 0;
  for (let k = 0; k < n && prev < h; k++) { const y1 = k === n - 1 ? h : Math.min(h, e[k]); if (y1 > prev) out.push([prev, y1]); prev = y1; }
  if (prev < h) out.push([prev, h]);
  return out;
}

export async function nlMeansP(f: Frame, hParam: number, patch: number, search: number, isCancelled?: Cancel): Promise<Frame> {
  const { w, h } = f;
  const parts = Math.min(bandCount(), threadCount() > 1 ? laneCount() : bandCount());
  if (parts < 2 || !parallelWorthIt(w * h * (2 * search + 1) * (2 * search + 1) * 8)) return nlMeans(f, hParam, patch, search, isCancelled);
  const Y = luma(f);
  const bands = nlmBands(h, parts, patch);
  const jobs = bands.map(([y0, y1]): Job => {
    const Yb = Y.slice(0, Math.min(h, y1 + patch + search) * w);
    const [a, b] = windowOf(h, y0, y1, search);
    const d = f.d.slice(a * w * 4, b * w * 4);
    return { args: { Y: Yb, d, dw0: a, w, h, y0, y1, hParam, patch, search }, transfer: [Yb.buffer, d.buffer] };
  });
  const res = await runJobs<Float32Array>("nlMeansRows", jobs, isCancelled);
  const out = new Float32Array(f.d.length);
  res.forEach((band, j) => out.set(band, bands[j][0] * w * 4));
  return { w, h, d: out };
}

export async function wienerP(f: Frame, r: number, noise: number, isCancelled?: Cancel): Promise<Frame> {
  const { w, h } = f;
  if (!parallelWorthIt(w * h * 3 * 30)) return wienerAdaptive(f, r, noise);
  return channelJobs(f, "wienerPlane", (p) => ({ p, w, h, r, noise }), isCancelled);
}
