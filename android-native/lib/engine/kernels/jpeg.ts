// Deterministic JPEG compression model (baseline JPEG, IJG quantization tables), used by Error Level
// Analysis. The browser's own JPEG encoder and decoder differ between browsers and platforms, so ELA run
// through them would not be reproducible. This model uses only +, -, *, / and rounding, with the DCT
// constants written out as literals: the result is bit-identical in every JavaScript engine.
//
// Stages, as in a libjpeg encode + decode: 8-bit RGB input -> YCbCr (JFIF) -> 4:2:0 chroma (2x2 average)
// -> level shift -> 8x8 DCT -> quantization with the IJG tables scaled for the quality (as libjpeg's
// jpeg_set_quality) -> dequantization -> inverse DCT -> 8-bit samples -> "fancy" (triangle) chroma
// upsampling with libjpeg's integer arithmetic -> RGB (JFIF).
import type { Frame } from "../frame";

/** Orthonormal 8x8 DCT-II basis, M[u * 8 + x] = a(u) cos((2x + 1) u pi / 16), exactly symmetric. */
const M = new Float64Array([
  0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.3535533905932738,
  0.4903926402016152, 0.4157348061512726, 0.2777851165098011, 0.09754516100806414, -0.09754516100806414, -0.2777851165098011, -0.4157348061512726, -0.4903926402016152,
  0.46193976625564337, 0.1913417161825449, -0.1913417161825449, -0.46193976625564337, -0.46193976625564337, -0.1913417161825449, 0.1913417161825449, 0.46193976625564337,
  0.4157348061512726, -0.09754516100806414, -0.4903926402016152, -0.2777851165098011, 0.2777851165098011, 0.4903926402016152, 0.09754516100806414, -0.4157348061512726,
  0.3535533905932738, -0.3535533905932738, -0.3535533905932738, 0.3535533905932738, 0.3535533905932738, -0.3535533905932738, -0.3535533905932738, 0.3535533905932738,
  0.2777851165098011, -0.4903926402016152, 0.09754516100806414, 0.4157348061512726, -0.4157348061512726, -0.09754516100806414, 0.4903926402016152, -0.2777851165098011,
  0.1913417161825449, -0.46193976625564337, 0.46193976625564337, -0.1913417161825449, -0.1913417161825449, 0.46193976625564337, -0.46193976625564337, 0.1913417161825449,
  0.09754516100806414, -0.2777851165098011, 0.4157348061512726, -0.4903926402016152, 0.4903926402016152, -0.4157348061512726, 0.2777851165098011, -0.09754516100806414,
]);

/** ITU-T T.81 Annex K example tables (the IJG defaults), natural (row-major) order. */
const LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/** Quantization table for a quality 1–100, exactly as libjpeg's jpeg_set_quality (baseline: max 255). */
export function quantTable(base: readonly number[], quality: number): Float64Array {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  return Float64Array.from(base, (b) => Math.min(255, Math.max(1, Math.floor((b * scale + 50) / 100))));
}
export const LUMA_TABLE = LUMA, CHROMA_TABLE = CHROMA;

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
/** Round half away from zero (libjpeg rounds magnitudes when quantizing). */
const roundHalfAway = (v: number) => (v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5));

/** Compresses and decompresses one 8-bit plane (values 0–255) block by block with the given table. */
export function roundTripPlane(src: Float64Array, w: number, h: number, Q: Float64Array): Float64Array {
  const out = new Float64Array(w * h);
  const blk = new Float64Array(64), tmp = new Float64Array(64), co = new Float64Array(64);
  for (let by = 0; by < h; by += 8) for (let bx = 0; bx < w; bx += 8) {
    // level shift; partial blocks are padded by replicating the last row/column (as libjpeg does)
    for (let y = 0; y < 8; y++) {
      const sy = Math.min(h - 1, by + y) * w;
      for (let x = 0; x < 8; x++) blk[y * 8 + x] = src[sy + Math.min(w - 1, bx + x)] - 128;
    }
    // forward DCT: rows, then columns
    for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) { let s = 0; for (let x = 0; x < 8; x++) s += M[u * 8 + x] * blk[y * 8 + x]; tmp[y * 8 + u] = s; }
    for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) { let s = 0; for (let y = 0; y < 8; y++) s += M[v * 8 + y] * tmp[y * 8 + u]; co[v * 8 + u] = s; }
    // quantization and dequantization
    for (let k = 0; k < 64; k++) co[k] = roundHalfAway(co[k] / Q[k]) * Q[k];
    // inverse DCT: columns, then rows
    for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) { let s = 0; for (let v = 0; v < 8; v++) s += M[v * 8 + y] * co[v * 8 + u]; tmp[y * 8 + u] = s; }
    for (let y = 0; y < 8 && by + y < h; y++) for (let x = 0; x < 8 && bx + x < w; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += M[u * 8 + x] * tmp[y * 8 + u];
      out[(by + y) * w + bx + x] = clamp8(Math.round(s + 128)); // decoders output 8-bit samples
    }
  }
  return out;
}

/** 2x2 average (4:2:0) as libjpeg's h2v2_downsample: rounding bias alternating 1, 2; edges replicated. */
function downsample(p: Float64Array, w: number, h: number): { d: Float64Array; w: number; h: number } {
  const cw = (w + 1) >> 1, ch = (h + 1) >> 1, d = new Float64Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    let bias = 1;
    for (let x = 0; x < cw; x++) {
      const x0 = 2 * x, y0 = 2 * y, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      d[y * cw + x] = (p[y0 * w + x0] + p[y0 * w + x1] + p[y1 * w + x0] + p[y1 * w + x1] + bias) >> 2;
      bias ^= 3;
    }
  }
  return { d, w: cw, h: ch };
}

/** libjpeg h2v2_fancy_upsample (triangle filter, integer arithmetic), cropped to w x h. */
function upsampleFancy(c: Float64Array, cw: number, ch: number, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  const row = new Float64Array(2 * cw);
  for (let y = 0; y < ch; y++) {
    for (let v = 0; v < 2; v++) {
      const oy = 2 * y + v;
      if (oy >= h) break;
      const near = y * cw, far = Math.min(ch - 1, Math.max(0, v === 0 ? y - 1 : y + 1)) * cw;
      const col = (x: number) => c[near + x] * 3 + c[far + x];
      if (cw === 1) { const t = col(0); row[0] = (t * 4 + 8) >> 4; row[1] = (t * 4 + 7) >> 4; }
      else {
        let last = col(0), cur = col(0), next = col(1);
        row[0] = (cur * 4 + 8) >> 4; row[1] = (cur * 3 + next + 7) >> 4;
        for (let x = 1; x < cw - 1; x++) {
          last = cur; cur = next; next = col(x + 1);
          row[2 * x] = (cur * 3 + last + 8) >> 4; row[2 * x + 1] = (cur * 3 + next + 7) >> 4;
        }
        last = cur; cur = next;
        row[2 * (cw - 1)] = (cur * 3 + last + 8) >> 4; row[2 * (cw - 1) + 1] = (cur * 4 + 7) >> 4;
      }
      for (let x = 0; x < w; x++) out[oy * w + x] = row[x];
    }
  }
  return out;
}

/**
 * The frame after a JPEG compression at `quality` (1–100) and decompression, with 4:2:0 chroma
 * (the default of cameras and common encoders) or 4:4:4. Input values are taken as 8-bit.
 */
export function jpegRoundTrip(f: Frame, quality: number, chroma: "420" | "444" = "420"): Frame {
  const { w, h, d } = f, n = w * h;
  const Y = new Float64Array(n), Cb = new Float64Array(n), Cr = new Float64Array(n);
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    const r = clamp8(Math.round(d[k])), g = clamp8(Math.round(d[k + 1])), b = clamp8(Math.round(d[k + 2]));
    Y[i] = clamp8(Math.round(0.299 * r + 0.587 * g + 0.114 * b));
    Cb[i] = clamp8(Math.round(-0.168736 * r - 0.331264 * g + 0.5 * b + 128));
    Cr[i] = clamp8(Math.round(0.5 * r - 0.418688 * g - 0.081312 * b + 128));
  }
  const ql = quantTable(LUMA, quality), qc = quantTable(CHROMA, quality);
  const y2 = roundTripPlane(Y, w, h, ql);
  let cb2: Float64Array, cr2: Float64Array;
  if (chroma === "420") {
    const b = downsample(Cb, w, h), r = downsample(Cr, w, h);
    cb2 = upsampleFancy(roundTripPlane(b.d, b.w, b.h, qc), b.w, b.h, w, h);
    cr2 = upsampleFancy(roundTripPlane(r.d, r.w, r.h, qc), r.w, r.h, w, h);
  } else {
    cb2 = roundTripPlane(Cb, w, h, qc);
    cr2 = roundTripPlane(Cr, w, h, qc);
  }
  const out = new Float32Array(n * 4);
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    const yy = y2[i], cb = cb2[i] - 128, cr = cr2[i] - 128;
    out[k] = clamp8(Math.round(yy + 1.402 * cr));
    out[k + 1] = clamp8(Math.round(yy - 0.344136 * cb - 0.714136 * cr));
    out[k + 2] = clamp8(Math.round(yy + 1.772 * cb));
    out[k + 3] = 255;
  }
  return { w, h, d: out };
}
