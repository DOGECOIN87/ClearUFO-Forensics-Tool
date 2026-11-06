// Point spread functions shared by the deconvolution engine, the synthetic generator and
// the PSF preview in Filter Settings. All PSFs are normalized (sum = 1) and centered.
import type { Pt } from "./types";

export interface Psf { w: number; h: number; d: Float32Array }

function splat(d: Float32Array, w: number, h: number, x: number, y: number, v: number) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const put = (xx: number, yy: number, ww: number) => { if (xx >= 0 && yy >= 0 && xx < w && yy < h) d[yy * w + xx] += v * ww; };
  put(x0, y0, (1 - fx) * (1 - fy)); put(x0 + 1, y0, fx * (1 - fy)); put(x0, y0 + 1, (1 - fx) * fy); put(x0 + 1, y0 + 1, fx * fy);
}

export function normalize(p: Psf): Psf {
  let s = 0;
  for (let i = 0; i < p.d.length; i++) s += p.d[i];
  if (s <= 0) { p.d.fill(0); p.d[(p.h >> 1) * p.w + (p.w >> 1)] = 1; return p; }
  for (let i = 0; i < p.d.length; i++) p.d[i] /= s;
  return p;
}

/** Linear motion blur of `length` pixels at `angle` degrees (counter-clockwise from the x axis). */
export function linePsf(length: number, angle: number): Psf {
  const L = Math.max(1, length);
  const size = (Math.ceil(L) + 3) | 1;
  const w = size, h = size, d = new Float32Array(w * h);
  const a = (angle * Math.PI) / 180, dx = Math.cos(a), dy = -Math.sin(a);
  const c = (size - 1) / 2;
  const steps = Math.max(2, Math.ceil(L * 10));
  for (let i = 0; i <= steps; i++) {
    const t = -L / 2 + (L * i) / steps;
    splat(d, w, h, c + dx * (t), c + dy * (t), 1);
  }
  return normalize({ w, h, d });
}

/** Out of focus (uniform disk) blur. */
export function diskPsf(radius: number): Psf {
  const r = Math.max(0.5, radius);
  const size = (Math.ceil(r) * 2 + 3) | 1;
  const c = (size - 1) / 2, d = new Float32Array(size * size);
  const S = 6;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let cov = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const px = x - c + (sx + 0.5) / S - 0.5, py = y - c + (sy + 0.5) / S - 0.5;
      if (px * px + py * py <= r * r) cov++;
    }
    d[y * size + x] = cov / (S * S);
  }
  return normalize({ w: size, h: size, d });
}

export function gaussianPsf(sigma: number): Psf {
  const s = Math.max(0.2, sigma);
  const rad = Math.ceil(s * 3.5);
  const size = rad * 2 + 1, d = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x - rad, dy = y - rad;
    d[y * size + x] = Math.exp(-(dx * dx + dy * dy) / (2 * s * s));
  }
  return normalize({ w: size, h: size, d });
}

/** Arbitrary (non linear) trajectory drawn by the examiner, with a given stroke thickness. */
export function pathPsf(points: Pt[], thickness = 1): Psf {
  if (!points || points.length < 2) return normalize({ w: 1, h: 1, d: new Float32Array([1]) });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const half = Math.ceil(Math.max(maxX - minX, maxY - minY) / 2 + thickness / 2) + 2;
  const size = half * 2 + 1, d = new Float32Array(size * size);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len * 10));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      splat(d, size, size, half + a.x + (b.x - a.x) * t - cx, half + a.y + (b.y - a.y) * t - cy, len / steps);
    }
  }
  let psf: Psf = { w: size, h: size, d };
  if (thickness > 1) {
    const disk = diskPsf((thickness - 1) / 2);
    const out = new Float32Array(size * size);
    const r = disk.w >> 1;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const v = d[y * size + x];
      if (!v) continue;
      for (let ky = 0; ky < disk.h; ky++) for (let kx = 0; kx < disk.w; kx++) {
        const yy = y + ky - r, xx = x + kx - r;
        if (yy >= 0 && xx >= 0 && yy < size && xx < size) out[yy * size + xx] += v * disk.d[ky * disk.w + kx];
      }
    }
    psf = { w: size, h: size, d: out };
  }
  return normalize(psf);
}

/** PSF for a deblurring filter configuration (used by both the engine and the UI preview). */
export function psfForFilter(type: string, p: Record<string, any>): Psf | null {
  switch (type) {
    case "motion_deblurring": return linePsf(p.length, p.angle);
    case "optical_deblurring": return diskPsf(p.radius);
    case "gaussian_deblurring": return gaussianPsf(p.sigma);
    case "nonlinear_deblurring": return p.points && p.points.length >= 2 ? pathPsf(p.points, p.thickness) : null;
    default: return null;
  }
}
