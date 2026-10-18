// FFT based processing: deconvolution (Wiener, Tikhonov, Richardson–Lucy), spectrum
// display and frequency domain filtering. Two real channels are packed into one
// complex transform (R + iG) since all filters used here have Hermitian transfer functions.
import type { Psf } from "../../shared/psf";
import { luma, split, merge, type Frame } from "../frame";
import { defineKernel, parallelWorthIt, runJobs } from "../pool";

interface Table { cos: Float64Array; sin: Float64Array; nsin: Float64Array; rev: Uint32Array }
const tables = new Map<number, Table>();

function table(n: number): Table {
  let t = tables.get(n);
  if (t) return t;
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), nsin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); nsin[i] = -sin[i]; }
  t = { cos, sin, nsin, rev };
  tables.set(n, t);
  return t;
}

export const nextPow2 = (v: number) => 2 ** Math.ceil(Math.log2(Math.max(2, v)));

export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  const { cos, sin, nsin, rev } = table(n);
  const sn = inverse ? sin : nsin; // nsin[k] = -sin[k]: the same twiddles as before, without a branch per butterfly
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  // The butterflies of one stage touch disjoint pairs, so their order does not change any result. Early stages
  // (few butterflies per block) run each twiddle across all blocks: long inner loops instead of tiny ones.
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    if (half < 16) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const c = cos[k], s = sn[k];
        for (let a = j; a < n; a += size) {
          const b = a + half;
          const tre = re[b] * c - im[b] * s, tim = re[b] * s + im[b] * c;
          re[b] = re[a] - tre; im[b] = im[a] - tim;
          re[a] += tre; im[a] += tim;
        }
      }
      continue;
    }
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const c = cos[k], s = sn[k];
        const a = i + j, b = a + half;
        const tre = re[b] * c - im[b] * s, tim = re[b] * s + im[b] * c;
        re[b] = re[a] - tre; im[b] = im[a] - tim;
        re[a] += tre; im[a] += tim;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** Columns gathered per sweep: 8 doubles = one 64-byte cache line per row, instead of one value per line. */
const COL_BLOCK = 8;

export function fft2(re: Float64Array, im: Float64Array, W: number, H: number, inverse = false) {
  for (let y = 0; y < H; y++) fft(re.subarray(y * W, y * W + W), im.subarray(y * W, y * W + W), inverse);
  // Column transforms, a block of adjacent columns at a time. Each column goes through exactly the same
  // 1-D transform as before (identical results); only the memory traffic of the gather/scatter changes.
  const B = Math.min(COL_BLOCK, W);
  const cr = new Float64Array(H * B), ci = new Float64Array(H * B);
  const colR: Float64Array[] = [], colI: Float64Array[] = [];
  for (let b = 0; b < B; b++) { colR.push(cr.subarray(b * H, b * H + H)); colI.push(ci.subarray(b * H, b * H + H)); }
  for (let x0 = 0; x0 < W; x0 += B) {
    const nb = Math.min(B, W - x0);
    for (let y = 0; y < H; y++) {
      const row = y * W + x0;
      for (let b = 0, o = y; b < nb; b++, o += H) { cr[o] = re[row + b]; ci[o] = im[row + b]; }
    }
    for (let b = 0; b < nb; b++) fft(colR[b], colI[b], inverse);
    for (let y = 0; y < H; y++) {
      const row = y * W + x0;
      for (let b = 0, o = y; b < nb; b++, o += H) { re[row + b] = cr[o]; im[row + b] = ci[o]; }
    }
  }
}

const reflect = (i: number, n: number) => {
  const p = 2 * n;
  i = ((i % p) + p) % p;
  return i < n ? i : p - 1 - i;
};

function padReflect(src: Float32Array, w: number, h: number, W: number, H: number, ox: number, oy: number): Float64Array {
  const out = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = reflect(y - oy, h) * w;
    for (let x = 0; x < W; x++) out[y * W + x] = src[sy + reflect(x - ox, w)];
  }
  return out;
}

function crop(src: Float64Array, W: number, w: number, h: number, ox: number, oy: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = src[(y + oy) * W + x + ox];
  return out;
}

function otf(psf: Psf, W: number, H: number) {
  const re = new Float64Array(W * H), im = new Float64Array(W * H);
  const cx = psf.w >> 1, cy = psf.h >> 1;
  for (let y = 0; y < psf.h; y++) for (let x = 0; x < psf.w; x++) {
    const X = (x - cx + W) % W, Y = (y - cy + H) % H;
    re[Y * W + X] += psf.d[y * psf.w + x];
  }
  fft2(re, im, W, H, false);
  return { re, im };
}

/** Apply a complex frequency response to up to two real planes at once. */
function filterPair(a: Float32Array, b: Float32Array | null, w: number, h: number, W: number, H: number, ox: number, oy: number, fre: Float64Array, fim: Float64Array): [Float32Array, Float32Array | null] {
  const zr = padReflect(a, w, h, W, H, ox, oy);
  const zi = b ? padReflect(b, w, h, W, H, ox, oy) : new Float64Array(W * H);
  fft2(zr, zi, W, H, false);
  for (let i = 0; i < zr.length; i++) {
    const r = zr[i], m = zi[i];
    zr[i] = r * fre[i] - m * fim[i];
    zi[i] = r * fim[i] + m * fre[i];
  }
  fft2(zr, zi, W, H, true);
  return [crop(zr, W, w, h, ox, oy), b ? crop(zi, W, w, h, ox, oy) : null];
}

export type DeconvMethod = "wiener" | "rl" | "tikhonov";

interface DeconvSetup { w: number; h: number; W: number; H: number; ox: number; oy: number; T: { re: Float64Array; im: Float64Array }; fre: Float64Array | null; fim: Float64Array | null }

/** Padding, transfer function and (Wiener / Tikhonov) inverse filter: shared by both channel pairs. */
function deconvSetup(w: number, h: number, psf: Psf, method: DeconvMethod, K: number): DeconvSetup {
  const pad = Math.max(16, Math.max(psf.w, psf.h) * 2);
  const W = nextPow2(w + 2 * pad), H = nextPow2(h + 2 * pad);
  const ox = (W - w) >> 1, oy = (H - h) >> 1;
  const T = otf(psf, W, H);
  let fre: Float64Array | null = null, fim: Float64Array | null = null;
  if (method !== "rl") {
    fre = new Float64Array(W * H); fim = new Float64Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const hr = T.re[i], hi = T.im[i];
      let reg = K;
      if (method === "tikhonov") {
        const l = 4 - 2 * Math.cos((2 * Math.PI * x) / W) - 2 * Math.cos((2 * Math.PI * y) / H);
        reg = (K * l * l) / 4 + 1e-9;
      }
      const den = hr * hr + hi * hi + reg;
      fre[i] = hr / den; fim[i] = -hi / den;
    }
  }
  return { w, h, W, H, ox, oy, T, fre, fim };
}

/** Deconvolve one channel pair (packed as R + iG) or a single channel. */
function deconvPair(S: DeconvSetup, p1: Float32Array, p2: Float32Array | null, method: DeconvMethod, K: number, iterations: number, progress?: (v: number) => void, pBase = 0, pSpan = 1, isCancelled?: () => boolean): [Float32Array, Float32Array | null] {
  const { w, h, W, H, ox, oy, T } = S;
  if (method !== "rl") return filterPair(p1, p2, w, h, W, H, ox, oy, S.fre!, S.fim!);
  // Richardson–Lucy
  const n = W * H;
  {
    const g1 = padReflect(p1, w, h, W, H, ox, oy), g2 = p2 ? padReflect(p2, w, h, W, H, ox, oy) : new Float64Array(n);
    for (let i = 0; i < n; i++) { g1[i] = Math.max(g1[i], 0.5); g2[i] = Math.max(g2[i], 0.5); }
    const u1 = Float64Array.from(g1), u2 = Float64Array.from(g2);
    const zr = new Float64Array(n), zi = new Float64Array(n);
    for (let it = 0; it < iterations; it++) {
      if (isCancelled?.()) throw new Error("Cancelled");
      zr.set(u1); zi.set(u2);
      fft2(zr, zi, W, H, false);
      for (let i = 0; i < n; i++) { const a0 = zr[i], b0 = zi[i]; zr[i] = a0 * T.re[i] - b0 * T.im[i]; zi[i] = a0 * T.im[i] + b0 * T.re[i]; }
      fft2(zr, zi, W, H, true);
      for (let i = 0; i < n; i++) { zr[i] = g1[i] / Math.max(zr[i], 1e-3); zi[i] = g2[i] / Math.max(zi[i], 1e-3); }
      fft2(zr, zi, W, H, false);
      for (let i = 0; i < n; i++) { const a0 = zr[i], b0 = zi[i]; zr[i] = a0 * T.re[i] + b0 * T.im[i]; zi[i] = -a0 * T.im[i] + b0 * T.re[i]; }
      fft2(zr, zi, W, H, true);
      // damping toward the observation controls noise amplification (K acts as a regularizer)
      const damp = Math.min(0.5, K * 2);
      for (let i = 0; i < n; i++) {
        u1[i] = Math.max(0, u1[i] * (zr[i] * (1 - damp) + damp));
        u2[i] = Math.max(0, u2[i] * (zi[i] * (1 - damp) + damp));
      }
      progress?.(pBase + (pSpan * (it + 1)) / iterations);
    }
    return [crop(u1, W, w, h, ox, oy), p2 ? crop(u2, W, w, h, ox, oy) : null];
  }
}

export function deconvolve(f: Frame, psf: Psf, method: DeconvMethod, K: number, iterations: number, progress?: (v: number) => void, isCancelled?: () => boolean): Frame {
  const { w, h } = f;
  const S = deconvSetup(w, h, psf, method, K);
  const [r, g, b, a] = split(f);
  if (method !== "rl") {
    progress?.(0.3);
    const [or, og] = deconvPair(S, r, g, method, K, iterations);
    progress?.(0.7);
    const [ob] = deconvPair(S, b, null, method, K, iterations);
    return merge(w, h, or, og!, ob, a);
  }
  const [or, og] = deconvPair(S, r, g, method, K, iterations, progress, 0, 0.66, isCancelled);
  const [ob] = deconvPair(S, b, null, method, K, iterations, progress, 0.66, 0.34, isCancelled);
  return merge(w, h, or, og!, ob, a);
}

// Multi-core: the two channel pairs are independent jobs; each computes the (identical) setup itself.
defineKernel("deconvPair", (a: { w: number; h: number; psf: Psf; method: DeconvMethod; K: number; iterations: number; p1: Float32Array; p2: Float32Array | null }) =>
  deconvPair(deconvSetup(a.w, a.h, a.psf, a.method, a.K), a.p1, a.p2, a.method, a.K, a.iterations));

export async function deconvolveP(f: Frame, psf: Psf, method: DeconvMethod, K: number, iterations: number, progress?: (v: number) => void, isCancelled?: () => boolean): Promise<Frame> {
  const { w, h } = f;
  if (!parallelWorthIt(w * h * 40)) return deconvolve(f, psf, method, K, iterations, progress, isCancelled);
  const [r, g, b, a] = split(f);
  const base = { w, h, psf, method, K, iterations };
  progress?.(0.1);
  const res = await runJobs<[Float32Array, Float32Array | null]>("deconvPair", [
    { args: { ...base, p1: r, p2: g }, transfer: [r.buffer, g.buffer] },
    { args: { ...base, p1: b, p2: null }, transfer: [b.buffer] },
  ], isCancelled);
  return merge(w, h, res[0][0], res[0][1]!, res[1][0], a);
}

/** Centered log-magnitude (or phase) spectrum resampled to the frame size. */
export function spectrum(plane: Float32Array, w: number, h: number, mode: "magnitude" | "phase", log: boolean): Float32Array {
  const W = nextPow2(w), H = nextPow2(h);
  const re = padReflect(plane, w, h, W, H, 0, 0), im = new Float64Array(W * H);
  let mean = 0;
  for (let i = 0; i < re.length; i++) mean += re[i];
  mean /= re.length;
  for (let i = 0; i < re.length; i++) re[i] -= mean;
  fft2(re, im, W, H, false);
  const mag = new Float64Array(W * H);
  let max = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = (x + W / 2) % W, sy = (y + H / 2) % H;
    const i = sy * W + sx;
    let v = mode === "phase" ? Math.atan2(im[i], re[i]) : Math.hypot(re[i], im[i]);
    if (mode === "magnitude" && log) v = Math.log1p(v);
    mag[y * W + x] = v;
    if (mode === "magnitude" && v > max) max = v;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fx = ((x + 0.5) * W) / w - 0.5, fy = ((y + 0.5) * H) / h - 0.5;
    const x0 = Math.max(0, Math.min(W - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)));
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
    const v = (mag[y0 * W + x0] * (1 - ax) + mag[y0 * W + x1] * ax) * (1 - ay) + (mag[y1 * W + x0] * (1 - ax) + mag[y1 * W + x1] * ax) * ay;
    out[y * w + x] = mode === "phase" ? ((v + Math.PI) / (2 * Math.PI)) * 255 : max > 0 ? (v / max) * 255 : 0;
  }
  return out;
}

export function spectrumOf(f: Frame, channel: string, mode: "magnitude" | "phase", log: boolean): Float32Array {
  const planes = split(f);
  const p = channel === "r" ? planes[0] : channel === "g" ? planes[1] : channel === "b" ? planes[2] : luma(f);
  return spectrum(p, f.w, f.h, mode, log);
}

export interface FourierFilterParams {
  filter: "notch" | "lowpass" | "highpass";
  points: { x: number; y: number }[];
  radius: number;
  symmetric: boolean;
  cutoff: number;
  smooth: boolean;
}

/** Frequency domain filtering; notch positions are given in display (frame) coordinates of the centered spectrum. */
export function fourierFilter(f: Frame, p: FourierFilterParams): Frame {
  const { w, h } = f;
  const pad = 16;
  const W = nextPow2(w + 2 * pad), H = nextPow2(h + 2 * pad);
  const ox = (W - w) >> 1, oy = (H - h) >> 1;
  const fre = new Float64Array(W * H), fim = new Float64Array(W * H);
  const notches: [number, number][] = [];
  if (p.filter === "notch") for (const pt of p.points || []) {
    const u = (pt.x - w / 2) / w, v = (pt.y - h / 2) / h;
    notches.push([u, v]);
    if (p.symmetric) notches.push([-u, -v]);
  }
  const ru = (p.radius / w) || 1e-3, rv = (p.radius / h) || 1e-3;
  const NN = notches.length, NU = Float64Array.from(notches, (q) => q[0]), NV = Float64Array.from(notches, (q) => q[1]);
  for (let y = 0; y < H; y++) {
    const v = (y < H / 2 ? y : y - H) / H;
    for (let x = 0; x < W; x++) {
      const u = (x < W / 2 ? x : x - W) / W;
      let m = 1;
      if (p.filter === "notch") {
        for (let q = 0; q < NN; q++) {
          const nu = NU[q], nv = NV[q];
          const d2 = ((u - nu) / ru) ** 2 + ((v - nv) / rv) ** 2;
          m *= p.smooth ? 1 - Math.exp(-d2 / 2) : d2 <= 1 ? 0 : 1;
        }
      } else {
        const r = Math.hypot(u, v), c = Math.max(1e-4, p.cutoff);
        const lp = p.smooth ? 1 / (1 + (r / c) ** 4) : r <= c ? 1 : 0;
        m = p.filter === "lowpass" ? lp : 1 - lp;
        if (p.filter === "highpass" && x === 0 && y === 0) m = 1; // keep the mean brightness
      }
      fre[y * W + x] = m;
    }
  }
  const [r, g, b, a] = split(f);
  const [or, og] = filterPair(r, g, w, h, W, H, ox, oy, fre, fim);
  const [ob] = filterPair(b, null, w, h, W, H, ox, oy, fre, fim);
  return merge(w, h, or, og!, ob, a);
}

/** Sub-pixel translation between two equally sized pow2 planes (phase correlation). b ≈ a shifted by (dx, dy). */
export function phaseCorrelate(a: Float64Array, b: Float64Array, W: number, H: number): { dx: number; dy: number; peak: number } {
  const ar = Float64Array.from(a), ai = new Float64Array(W * H);
  const br = Float64Array.from(b), bi = new Float64Array(W * H);
  fft2(ar, ai, W, H, false);
  fft2(br, bi, W, H, false);
  for (let i = 0; i < ar.length; i++) {
    // B * conj(A)
    const re = br[i] * ar[i] + bi[i] * ai[i];
    const im = bi[i] * ar[i] - br[i] * ai[i];
    const m = Math.hypot(re, im) || 1e-12;
    ar[i] = re / m; ai[i] = im / m;
  }
  fft2(ar, ai, W, H, true);
  let best = -Infinity, bx = 0, by = 0;
  for (let i = 0; i < ar.length; i++) if (ar[i] > best) { best = ar[i]; bx = i % W; by = (i / W) | 0; }
  const at = (x: number, y: number) => ar[((y + H) % H) * W + ((x + W) % W)];
  const sub = (m1: number, c: number, p1: number) => { const d = m1 - 2 * c + p1; return Math.abs(d) < 1e-12 ? 0 : (0.5 * (m1 - p1)) / d; };
  let dx = bx + sub(at(bx - 1, by), best, at(bx + 1, by));
  let dy = by + sub(at(bx, by - 1), best, at(bx, by + 1));
  if (dx > W / 2) dx -= W;
  if (dy > H / 2) dy -= H;
  return { dx, dy, peak: best };
}

export function hannWindowed(plane: Float32Array, w: number, h: number, x0: number, y0: number, W: number, H: number): Float64Array {
  const out = new Float64Array(W * H);
  let mean = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.min(w - 1, Math.max(0, x0 + x)), sy = Math.min(h - 1, Math.max(0, y0 + y));
    const v = plane[sy * w + sx];
    out[y * W + x] = v; mean += v; n++;
  }
  mean /= n;
  for (let y = 0; y < H; y++) {
    const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / (H - 1));
    for (let x = 0; x < W; x++) out[y * W + x] = (out[y * W + x] - mean) * wy * (0.5 - 0.5 * Math.cos((2 * Math.PI * x) / (W - 1)));
  }
  return out;
}
