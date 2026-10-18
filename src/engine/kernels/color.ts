// Color conversions, LUTs, histogram equalization (global and CLAHE) and statistics.
import type { Frame } from "../frame";

export const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Interpolated lookup on the nominal 0..255 range (values outside are clamped). */
export class Lut {
  readonly t: Float32Array;
  constructor(fn: (v: number) => number, readonly n = 4096) {
    this.t = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) this.t[i] = fn((i / n) * 255);
  }
  map(v: number): number {
    const x = (v < 0 ? 0 : v > 255 ? 255 : v) * (this.n / 255);
    const i = x | 0;
    return i >= this.n ? this.t[this.n] : this.t[i] + (this.t[i + 1] - this.t[i]) * (x - i);
  }
}

/** Lut.map with the table fields passed in (same arithmetic, so the same values); a monomorphic helper V8 inlines. */
function lutAt(t: Float32Array, n: number, sc: number, v: number): number {
  const x = (v < 0 ? 0 : v > 255 ? 255 : v) * sc;
  const i = x | 0;
  return i >= n ? t[n] : t[i] + (t[i + 1] - t[i]) * (x - i);
}

/**
 * Lut.map of the 256 integer inputs, computed once with lutAt itself: frames from 8-bit sources hold whole
 * numbers, and for those a single lookup replaces the interpolation (same function, so the same values).
 */
function integerTable(l: Lut): Float64Array {
  const k = new Float64Array(256), sc = l.n / 255;
  for (let v = 0; v < 256; v++) k[v] = lutAt(l.t, l.n, sc, v);
  return k;
}

/** lutAt with the integer table in front (v | 0 === v only for whole numbers in int32 range; -0 maps like 0). */
function lutAtI(t: Float32Array, n: number, sc: number, k: Float64Array, v: number): number {
  const iv = v | 0;
  return iv === v && iv >= 0 && iv <= 255 ? k[iv] : lutAt(t, n, sc, v);
}

export function applyLuts(f: Frame, lr: Lut | null, lg: Lut | null, lb: Lut | null): Frame {
  const d = f.d, out = new Float32Array(d.length);
  const none = new Float64Array(0);
  const tr = lr ? lr.t : d, nr = lr ? lr.n : 0, sr = nr / 255, kr = lr ? integerTable(lr) : none;
  const tg = lg ? lg.t : d, ng = lg ? lg.n : 0, sg = ng / 255, kg = lg ? (lg === lr ? kr : integerTable(lg)) : none;
  const tb = lb ? lb.t : d, nb = lb ? lb.n : 0, sb = nb / 255, kb = lb ? (lb === lr ? kr : lb === lg ? kg : integerTable(lb)) : none;
  for (let i = 0; i < d.length; i += 4) {
    out[i] = lr ? lutAtI(tr, nr, sr, kr, d[i]) : d[i];
    out[i + 1] = lg ? lutAtI(tg, ng, sg, kg, d[i + 1]) : d[i + 1];
    out[i + 2] = lb ? lutAtI(tb, nb, sb, kb, d[i + 2]) : d[i + 2];
    out[i + 3] = d[i + 3];
  }
  return { w: f.w, h: f.h, d: out };
}

/**
 * Per-pixel map through a callback. Convenient, but a shared call site: once several filters use it V8 stops
 * inlining the callbacks (megamorphic) and every pixel pays a real call. Hot filters write their own loop.
 */
export function mapPixels(f: Frame, fn: (r: number, g: number, b: number, o: Float32Array, i: number) => void): Frame {
  const d = f.d, out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) { fn(d[i], d[i + 1], d[i + 2], out, i); out[i + 3] = d[i + 3]; }
  return { w: f.w, h: f.h, d: out };
}

// ---------------------------------------------------------------- conversions (inputs 0..255)
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-9) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx > 0 ? d / mx : 0, mx];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d > 1e-9) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  return hsvToRgb(h, l + c / 2 > 0 ? c / (l + c / 2) : 0, l + c / 2);
}

const srgbToLinear = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255;

export function rgbToXyz(r: number, g: number, b: number): [number, number, number] {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  return [0.4124564 * R + 0.3575761 * G + 0.1804375 * B, 0.2126729 * R + 0.7151522 * G + 0.072175 * B, 0.0193339 * R + 0.119192 * G + 0.9503041 * B];
}

export function xyzToRgb(x: number, y: number, z: number): [number, number, number] {
  return [linearToSrgb(3.2404542 * x - 1.5371385 * y - 0.4985314 * z), linearToSrgb(-0.969266 * x + 1.8760108 * y + 0.041556 * z), linearToSrgb(0.0556434 * x - 0.2040259 * y + 1.0572252 * z)];
}

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const [x, y, z] = rgbToXyz(r, g, b);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x / 0.95047), fy = f(y / 1), fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  return xyzToRgb(inv(fx) * 0.95047, inv(fy), inv(fz) * 1.08883);
}

export function ycbcr(r: number, g: number, b: number, bt709: boolean): [number, number, number] {
  const [kr, kb] = bt709 ? [0.2126, 0.0722] : [0.299, 0.114];
  const y = kr * r + (1 - kr - kb) * g + kb * b;
  return [y, 128 + (b - y) / (2 * (1 - kb)), 128 + (r - y) / (2 * (1 - kr))];
}

export function ycbcrToRgb(y: number, cb: number, cr: number, bt709 = false): [number, number, number] {
  const [kr, kb] = bt709 ? [0.2126, 0.0722] : [0.299, 0.114];
  const r = y + 2 * (1 - kr) * (cr - 128), b = y + 2 * (1 - kb) * (cb - 128);
  return [r, (y - kr * r - kb * b) / (1 - kr - kb), b];
}

// ---------------------------------------------------------------- statistics
export function histogramPlane(p: Float32Array, bins = 256): Uint32Array {
  const h = new Uint32Array(bins);
  for (let i = 0; i < p.length; i++) h[Math.min(bins - 1, Math.max(0, Math.round(p[i])))]++;
  return h;
}

export function percentileFromHist(h: Uint32Array, total: number, q: number): number {
  const target = q * total;
  let acc = 0;
  for (let i = 0; i < h.length; i++) { acc += h[i]; if (acc >= target) return i; }
  return h.length - 1;
}

/** Equalization mapping from a histogram (CDF based). */
export function equalizeMap(h: Uint32Array, total: number): Float32Array {
  const map = new Float32Array(256);
  let acc = 0, cdfMin = 0;
  for (let i = 0; i < 256; i++) if (h[i]) { cdfMin = h[i]; break; }
  for (let i = 0; i < 256; i++) { acc += h[i]; map[i] = total > cdfMin ? ((acc - cdfMin) / (total - cdfMin)) * 255 : i; }
  return map;
}

/** Contrast Limited Adaptive Histogram Equalization of a plane (0..255). */
export function clahe(p: Float32Array, w: number, h: number, tiles: number, clip: number): Float32Array {
  const tx = Math.max(1, Math.min(tiles, w)), ty = Math.max(1, Math.min(tiles, h));
  const tw = w / tx, th = h / ty;
  const maps: Float32Array[] = [];
  for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) {
    const x0 = Math.floor(i * tw), x1 = Math.floor((i + 1) * tw), y0 = Math.floor(j * th), y1 = Math.floor((j + 1) * th);
    const hist = new Float64Array(256);
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { hist[Math.min(255, Math.max(0, Math.round(p[y * w + x])))]++; n++; }
    const limit = Math.max(1, (clip * n) / 256);
    let excess = 0;
    for (let k = 0; k < 256; k++) if (hist[k] > limit) { excess += hist[k] - limit; hist[k] = limit; }
    const add = excess / 256;
    const map = new Float32Array(256);
    let acc = 0;
    for (let k = 0; k < 256; k++) { acc += hist[k] + add; map[k] = n ? (acc / n) * 255 : k; }
    maps.push(map);
  }
  const out = new Float32Array(p.length);
  for (let y = 0; y < h; y++) {
    const gy = y / th - 0.5, j0 = Math.max(0, Math.min(ty - 1, Math.floor(gy))), j1 = Math.min(ty - 1, j0 + 1), fy = Math.max(0, Math.min(1, gy - j0));
    for (let x = 0; x < w; x++) {
      const gx = x / tw - 0.5, i0 = Math.max(0, Math.min(tx - 1, Math.floor(gx))), i1 = Math.min(tx - 1, i0 + 1), fx = Math.max(0, Math.min(1, gx - i0));
      const v = Math.min(255, Math.max(0, Math.round(p[y * w + x])));
      const a = maps[j0 * tx + i0][v], b = maps[j0 * tx + i1][v], c = maps[j1 * tx + i0][v], d = maps[j1 * tx + i1][v];
      out[y * w + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}
