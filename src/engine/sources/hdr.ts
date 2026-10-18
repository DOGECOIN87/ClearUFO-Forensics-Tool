// HDR (PQ / HLG) to SDR conversion of decoded video frames — what a phone or a TV does when it shows HDR video
// on a standard display. Shown without it, HDR code values look flat, grey and desaturated (the usual
// "my iPhone video looks washed out" effect): iPhones record HLG HDR by default, many Android phones HDR10.
//
// Standard, documented steps (ITU-R BT.2100, BT.2390, BT.2408, BT.2087):
//  1. signal → display light: PQ EOTF (absolute cd/m²), or HLG inverse OETF + OOTF (system gamma 1.2 at a
//     1000 cd/m² nominal peak, BT.2100 note 5e)
//  2. luminance tone mapping with the BT.2390 EETF (in the PQ domain) from the source peak to the SDR reference
//     white of 203 cd/m² (BT.2408); R, G and B are scaled by the same factor, so hues are kept
//  3. BT.2020 → BT.709 primaries in linear light (BT.2087 matrix); out-of-gamut colors are desaturated toward
//     their own luminance instead of being clipped channel by channel
//  4. display light → SDR signal with the inverse of the BT.1886 EOTF (gamma 2.4), 100 % = 203 cd/m²
// Lookup tables with linear interpolation keep it fast (≈ 6 table reads per pixel); hdr.test.ts checks them
// against the closed-form functions.
import type { Frame } from "../frame";

export type HdrTransfer = "pq" | "hlg";
/** SDR reference (graphics) white in HDR, cd/m² (BT.2408). */
export const SDR_WHITE = 203;

const M1 = 2610 / 16384, M2 = (2523 / 4096) * 128, C1 = 3424 / 4096, C2 = (2413 / 4096) * 32, C3 = (2392 / 4096) * 32;
/** PQ EOTF (SMPTE ST 2084): signal 0..1 → cd/m². */
export function pqEotf(e: number): number {
  const p = Math.pow(Math.max(e, 0), 1 / M2);
  return 10000 * Math.pow(Math.max(p - C1, 0) / (C2 - C3 * p), 1 / M1);
}
/** Inverse PQ EOTF: cd/m² → signal 0..1. */
export function pqInv(l: number): number {
  const y = Math.pow(Math.max(l, 0) / 10000, M1);
  return Math.pow((C1 + C2 * y) / (1 + C3 * y), M2);
}
const HA = 0.17883277, HB = 1 - 4 * HA, HC = 0.5 - HA * Math.log(4 * HA);
/** HLG inverse OETF (ARIB STD-B67 / BT.2100): signal 0..1 → normalized scene light 0..1. */
export function hlgInvOetf(e: number): number {
  e = Math.max(e, 0);
  return e <= 0.5 ? (e * e) / 3 : (Math.exp((e - HC) / HA) + HB) / 12;
}
/** HLG system gamma for a nominal peak luminance (BT.2100). */
export const hlgGamma = (peak: number) => 1.2 + 0.42 * Math.log10(peak / 1000);

/** BT.2390 EETF: display light (cd/m²) of content mastered up to `peak` → light on a display whose maximum is `target`. */
export function eetf(l: number, peak: number, target: number): number {
  if (peak <= target) return Math.min(Math.max(l, 0), target);
  const sMax = pqInv(peak), e1 = Math.min(pqInv(l) / sMax, 1);
  const maxLum = pqInv(target) / sMax, ks = Math.max(0, 1.5 * maxLum - 0.5);
  let e2 = e1;
  if (e1 > ks) {
    const t = (e1 - ks) / (1 - ks), t2 = t * t, t3 = t2 * t;
    e2 = (2 * t3 - 3 * t2 + 1) * ks + (t3 - 2 * t2 + t) * (1 - ks) + (-2 * t3 + 3 * t2) * maxLum;
  }
  return Math.min(pqEotf(e2 * sMax), target);
}

export interface HdrConvert {
  transfer: HdrTransfer;
  /** BT.2020 primaries (convert to BT.709); otherwise the primaries are kept. */
  bt2020: boolean;
  /** Source peak luminance, cd/m² (PQ: mastering peak; HLG: nominal display peak). */
  peak: number;
}

// ------------------------------------------------------------------------------------------------- tables
interface Tables { dec: Float32Array; ootf: Float32Array | null; tone: Float32Array; enc: Float32Array; ypk: number }
const cache = new Map<string, Tables>();

function table(n: number, fn: (x: number) => number): Float32Array {
  const t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = fn(i / n);
  return t;
}
/** Linear interpolation in a table sampled at x = i / n (x clamped to 0..1). */
function at(t: Float32Array, x: number): number {
  const n = t.length - 1;
  if (!(x > 0)) return t[0];
  if (x >= 1) return t[n];
  const f = x * n, i = f | 0;
  return t[i] + (t[i + 1] - t[i]) * (f - i);
}

function tables(transfer: HdrTransfer, bt2020: boolean, peak: number): Tables {
  const k = `${transfer}|${bt2020}|${peak}`;
  let t = cache.get(k);
  if (t) return t;
  const ypk = peak / SDR_WHITE; // source peak relative to SDR white
  const g = hlgGamma(peak);
  t = {
    // signal → light relative to SDR white (PQ: display light; HLG: scene light 0..1, the OOTF follows)
    dec: transfer === "pq" ? table(16384, (e) => pqEotf(e) / SDR_WHITE) : table(8192, hlgInvOetf),
    // HLG: OOTF gain Lw·Ys^(γ−1) / SDR white times the tone mapping gain of the resulting display luminance
    // Lw·Ys^γ, both functions of the scene luminance Ys alone: one table indexed by sqrt(Ys)
    ootf: transfer === "hlg" ? table(8192, (u) => {
      const ys = u * u, k = ypk * Math.pow(ys, g - 1), yd = k * ys * SDR_WHITE; // cd/m²
      return yd <= 0 ? k : k * (yd >= peak ? SDR_WHITE : eetf(yd, peak, SDR_WHITE)) / yd;
    }) : null,
    // tone mapping gain Y'/Y indexed by sqrt(Y / peak); 1 at black (the EETF is the identity below its knee)
    tone: table(8192, (u) => { const y = u * u * peak; return y <= 0 ? 1 : eetf(y, peak, SDR_WHITE) / y; }),
    // inverse BT.1886 (gamma 2.4) indexed by sqrt(light)
    enc: table(8192, (u) => Math.pow(u * u, 1 / 2.4)),
    ypk,
  };
  cache.set(k, t);
  return t;
}

/**
 * Convert a decoded HDR frame (R'G'B' signal values 0..255, from the YUV → RGB step) in place to SDR BT.709
 * (0..255). Alpha is kept.
 */
export function hdrToSdr(f: Frame, o: HdrConvert): Frame {
  const peak = Math.max(100, Math.min(10000, o.peak || 1000));
  const T = tables(o.transfer, o.bt2020, peak);
  const hlg = T.ootf !== null, ypk = T.ypk;
  const [kr, kg, kb] = o.bt2020 ? [0.2627, 0.678, 0.0593] : [0.2126, 0.7152, 0.0722];
  const d = f.d, n = f.w * f.h * 4, s = 1 / 255;
  for (let i = 0; i < n; i += 4) {
    let r = at(T.dec, d[i] * s), g = at(T.dec, d[i + 1] * s), b = at(T.dec, d[i + 2] * s);
    const y = kr * r + kg * g + kb * b;
    if (hlg) {
      const k = at(T.ootf!, Math.sqrt(y)); // OOTF and tone mapping in one
      r *= k; g *= k; b *= k;
    } else if (y > 0) {
      const k = y >= ypk ? 1 / y : at(T.tone, Math.sqrt(y / ypk));
      r *= k; g *= k; b *= k;
    }
    if (o.bt2020) {
      const R = 1.660491 * r - 0.587641 * g - 0.07285 * b;
      const G = -0.12455 * r + 1.1329 * g - 0.008349 * b;
      const B = -0.018151 * r - 0.100579 * g + 1.11873 * b;
      r = R; g = G; b = B;
    }
    // into the SDR gamut and range, keeping the luminance
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (Y <= 0) r = g = b = 0;
    else if (Y >= 1) r = g = b = 1;
    else {
      let lo = r < g ? (r < b ? r : b) : g < b ? g : b, hi = r > g ? (r > b ? r : b) : g > b ? g : b;
      if (lo < 0) { const k = Y / (Y - lo); r = Y + (r - Y) * k; g = Y + (g - Y) * k; b = Y + (b - Y) * k; hi = Y + (hi - Y) * k; lo = 0; }
      if (hi > 1) { const k = (1 - Y) / (hi - Y); r = Y + (r - Y) * k; g = Y + (g - Y) * k; b = Y + (b - Y) * k; }
    }
    d[i] = 255 * at(T.enc, Math.sqrt(r > 0 ? r : 0));
    d[i + 1] = 255 * at(T.enc, Math.sqrt(g > 0 ? g : 0));
    d[i + 2] = 255 * at(T.enc, Math.sqrt(b > 0 ? b : 0));
  }
  return f;
}

/** Reference implementation without tables (tests). One pixel, signal 0..1 → SDR signal 0..1. */
export function hdrToSdrPixel(rgb: [number, number, number], o: HdrConvert): [number, number, number] {
  const peak = Math.max(100, Math.min(10000, o.peak || 1000));
  const [kr, kg, kb] = o.bt2020 ? [0.2627, 0.678, 0.0593] : [0.2126, 0.7152, 0.0722];
  let [r, g, b] = rgb.map((e) => Math.min(1, Math.max(0, e)));
  if (o.transfer === "pq") { r = pqEotf(r); g = pqEotf(g); b = pqEotf(b); }
  else {
    r = hlgInvOetf(r); g = hlgInvOetf(g); b = hlgInvOetf(b);
    const ys = kr * r + kg * g + kb * b, k = peak * Math.pow(ys, hlgGamma(peak) - 1);
    r *= k; g *= k; b *= k;
  }
  const y = kr * r + kg * g + kb * b; // cd/m²
  if (y > 0) { const k = (y >= peak ? SDR_WHITE : eetf(y, peak, SDR_WHITE)) / y; r *= k; g *= k; b *= k; }
  r /= SDR_WHITE; g /= SDR_WHITE; b /= SDR_WHITE;
  if (o.bt2020) [r, g, b] = [1.660491 * r - 0.587641 * g - 0.07285 * b, -0.12455 * r + 1.1329 * g - 0.008349 * b, -0.018151 * r - 0.100579 * g + 1.11873 * b];
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (Y <= 0) return [0, 0, 0];
  if (Y >= 1) return [1, 1, 1];
  let lo = Math.min(r, g, b), hi = Math.max(r, g, b);
  if (lo < 0) { const k = Y / (Y - lo); [r, g, b] = [r, g, b].map((c) => Y + (c - Y) * k); hi = Y + (hi - Y) * k; lo = 0; }
  if (hi > 1) { const k = (1 - Y) / (hi - Y); [r, g, b] = [r, g, b].map((c) => Y + (c - Y) * k); }
  return [r, g, b].map((c) => Math.pow(Math.max(0, c), 1 / 2.4)) as [number, number, number];
}

/** Tone map a frame converted from decoded planes when the stream is HDR and the Video Loader asks for it. */
export function applyHdr(f: Frame, info: { transfer?: string; colorPrimaries?: string }, opts?: { hdr?: string; hdrPeak?: number }): Frame {
  const t = info.transfer;
  if (opts?.hdr !== "tonemap" || (t !== "pq" && t !== "hlg")) return f;
  return hdrToSdr(f, { transfer: t, bt2020: info.colorPrimaries === "bt2020", peak: opts.hdrPeak ?? 1000 });
}
