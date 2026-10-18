// Frame representation used by the processing engine.
// RGBA interleaved, 32-bit float, nominal range 0..255. Values are never clamped
// between filters, so no precision is lost along a chain; clamping happens only
// when converting to 8-bit for display or export.

import { convertToU8 } from "./wasm/px";

export interface Frame {
  w: number;
  h: number;
  d: Float32Array;
}

export function alloc(w: number, h: number, fillAlpha = true): Frame {
  const d = new Float32Array(w * h * 4);
  if (fillAlpha) for (let i = 3; i < d.length; i += 4) d[i] = 255;
  return { w, h, d };
}

export function clone(f: Frame): Frame {
  return { w: f.w, h: f.h, d: new Float32Array(f.d) };
}

export function fromRGBA8(src: Uint8ClampedArray | Uint8Array, w: number, h: number): Frame {
  const d = new Float32Array(w * h * 4);
  for (let i = 0; i < d.length; i++) d[i] = src[i];
  return { w, h, d };
}

export function toRGBA8(f: Frame, out?: Uint8ClampedArray): Uint8ClampedArray {
  const n = f.d.length;
  const o = out && out.length === n ? out : new Uint8ClampedArray(n);
  // Uint8ClampedArray semantics (round half to even, clamp); WebAssembly SIMD when available, same bytes
  convertToU8(f.d, o, false);
  return o;
}

export function solid(w: number, h: number, r: number, g: number, b: number, a = 255): Frame {
  const f = alloc(w, h, false);
  const d = f.d;
  for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; }
  return f;
}

/** BT.601 luma plane. */
export function luma(f: Frame): Float32Array {
  const n = f.w * f.h;
  const out = new Float32Array(n);
  const d = f.d;
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return out;
}

/** Split into planar channels R, G, B, A. */
export function split(f: Frame): Float32Array[] {
  const n = f.w * f.h;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), a = new Float32Array(n);
  const d = f.d;
  for (let i = 0, j = 0; i < n; i++, j += 4) { r[i] = d[j]; g[i] = d[j + 1]; b[i] = d[j + 2]; a[i] = d[j + 3]; }
  return [r, g, b, a];
}

export function merge(w: number, h: number, r: Float32Array, g: Float32Array, b: Float32Array, a?: Float32Array): Frame {
  const n = w * h;
  const d = new Float32Array(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) { d[j] = r[i]; d[j + 1] = g[i]; d[j + 2] = b[i]; d[j + 3] = a ? a[i] : 255; }
  return { w, h, d };
}

/** Apply a per-plane function to R, G and B, keeping alpha. */
export function mapPlanes(f: Frame, fn: (plane: Float32Array, c: number) => Float32Array): Frame {
  const [r, g, b, a] = split(f);
  return merge(f.w, f.h, fn(r, 0), fn(g, 1), fn(b, 2), a);
}

export function grayFrame(w: number, h: number, plane: Float32Array): Frame {
  const n = w * h;
  const d = new Float32Array(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) { const v = plane[i]; d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255; }
  return { w, h, d };
}

/** Copy a rectangular region (clipped). */
export function cropFrame(f: Frame, x: number, y: number, w: number, h: number): Frame {
  x = Math.round(x); y = Math.round(y); w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const out = alloc(w, h, false);
  const sd = f.d, od = out.d;
  for (let yy = 0; yy < h; yy++) {
    const sy = Math.min(f.h - 1, Math.max(0, y + yy));
    for (let xx = 0; xx < w; xx++) {
      const sx = Math.min(f.w - 1, Math.max(0, x + xx));
      const si = (sy * f.w + sx) * 4, oi = (yy * w + xx) * 4;
      od[oi] = sd[si]; od[oi + 1] = sd[si + 1]; od[oi + 2] = sd[si + 2]; od[oi + 3] = sd[si + 3];
    }
  }
  return out;
}

/** Paste src into dst at (x, y), alpha aware when `alpha` is true. Mutates dst. */
export function blit(dst: Frame, src: Frame, x: number, y: number, alpha = false, opacity = 1) {
  x = Math.round(x); y = Math.round(y);
  for (let yy = 0; yy < src.h; yy++) {
    const dy = y + yy;
    if (dy < 0 || dy >= dst.h) continue;
    for (let xx = 0; xx < src.w; xx++) {
      const dx = x + xx;
      if (dx < 0 || dx >= dst.w) continue;
      const si = (yy * src.w + xx) * 4, di = (dy * dst.w + dx) * 4;
      const a = (alpha ? src.d[si + 3] / 255 : 1) * opacity;
      if (a >= 1) { dst.d[di] = src.d[si]; dst.d[di + 1] = src.d[si + 1]; dst.d[di + 2] = src.d[si + 2]; }
      else if (a > 0) {
        dst.d[di] += (src.d[si] - dst.d[di]) * a;
        dst.d[di + 1] += (src.d[si + 1] - dst.d[di + 1]) * a;
        dst.d[di + 2] += (src.d[si + 2] - dst.d[di + 2]) * a;
      }
    }
  }
}

export function parseColor(hex: string): [number, number, number] {
  let s = (hex || "#000").trim().replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  const n = parseInt(s.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
