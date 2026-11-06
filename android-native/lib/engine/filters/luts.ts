// Lookup tables of the tone filters (Levels, Curves, Brightness/Contrast, Exposure/Gamma). Shared by the engine
// and the WebGPU preview, so both build the same tables from the same parameters.
import type { Pt } from "../../shared/types";
import { Lut } from "../kernels/color";

type P = Record<string, any>;

export const levelsLut = (p: P) => new Lut((v) => {
  const span = Math.max(1e-6, p.inWhite - p.inBlack);
  const t = Math.min(1, Math.max(0, (v - p.inBlack) / span));
  return p.outBlack + Math.pow(t, 1 / Math.max(0.01, p.gamma)) * (p.outWhite - p.outBlack);
});

/** Monotone cubic (Fritsch–Carlson) curve through control points. */
export function curveFunction(pts: Pt[]): (v: number) => number {
  const P = [...(pts || [])].sort((a, b) => a.x - b.x).filter((p, i, a) => i === 0 || p.x > a[i - 1].x + 1e-6);
  if (P.length < 2) return (v) => v;
  const n = P.length, dx: number[] = [], m: number[] = [], t: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { dx.push(P[i + 1].x - P[i].x); m.push((P[i + 1].y - P[i].y) / dx[i]); }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(m[i]) < 1e-12) { t[i] = t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  return (v) => {
    if (v <= P[0].x) return P[0].y;
    if (v >= P[n - 1].x) return P[n - 1].y;
    let i = 0;
    while (i < n - 2 && v > P[i + 1].x) i++;
    const h = dx[i], s = (v - P[i].x) / h, s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * P[i].y + (s3 - 2 * s2 + s) * h * t[i] + (-2 * s3 + 3 * s2) * P[i + 1].y + (s3 - s2) * h * t[i + 1];
  };
}

export function brightnessContrastLut(p: P): Lut {
  const k = Math.tan(((p.contrast / 100 + 1) * Math.PI) / 4);
  return new Lut((v) => (v - 127.5) * k + 127.5 + p.brightness);
}

export function exposureLut(p: P): Lut {
  const gain = Math.pow(2, p.exposure), ig = 1 / Math.max(0.01, p.gamma);
  return new Lut((v) => Math.pow(Math.max(0, (v / 255) * gain), ig) * 255 + p.offset);
}

/** The tables a tone filter applies to R, G and B (null = channel unchanged); null when not a tone filter. */
export function toneLuts(type: string, p: P): [Lut | null, Lut | null, Lut | null] | null {
  const per = (lut: Lut): [Lut | null, Lut | null, Lut | null] => {
    const pick = (c: string) => (p.channel === "all" || p.channel === c ? lut : null);
    return [pick("r"), pick("g"), pick("b")];
  };
  switch (type) {
    case "levels": return per(levelsLut(p));
    case "curves": return per(new Lut(curveFunction(p.curve)));
    case "brightness_contrast": { const l = brightnessContrastLut(p); return [l, l, l]; }
    case "exposure": { const l = exposureLut(p); return [l, l, l]; }
    default: return null;
  }
}
