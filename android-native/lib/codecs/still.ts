// Still image decoding: the file's stored samples are read on the device, without the platform's
// image decoders, so the evidence keeps the precision of the file (16-bit PNG and TIFF samples are
// not rounded to 8 bits) and the result does not depend on the phone's image pipeline.
import { decodeBMP, decodeTIFF, type Samples } from "./image";
import { decodeJpeg } from "./jpegdecode";
import { decodePngExactSync, isPng } from "./pngdecode";
import type { Frame } from "../engine/frame";

export interface StillDecode {
  frame: Frame;
  /** Format id: png, jpeg, bmp, tiff. */
  format: string;
  /** Bits per sample as stored (8, 16 or 32 for float TIFF). */
  depth: number;
  /** PNG colour type (0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA). */
  colorType?: number;
  /** Decoder used, for the provenance report. */
  engine: string;
  warnings: string[];
}

const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isBmp = (b: Uint8Array) => b.length > 26 && b[0] === 0x42 && b[1] === 0x4d;
const isTiff = (b: Uint8Array) => b.length > 8 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a));
const isWebp = (b: Uint8Array) => b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;

/** Samples (packed RGB) to a float frame on the 0..255 scale. */
export function samplesToFrame(w: number, h: number, s: Samples, scale16 = true): Frame {
  const d = new Float32Array(w * h * 4);
  const n = w * h;
  if (s instanceof Uint8Array) {
    for (let i = 0, k = 0; i < n; i++, k += 4) {
      d[k] = s[i * 3]; d[k + 1] = s[i * 3 + 1]; d[k + 2] = s[i * 3 + 2]; d[k + 3] = 255;
    }
  } else if (s instanceof Uint16Array) {
    const div = scale16 ? 257 : 1;
    for (let i = 0, k = 0; i < n; i++, k += 4) {
      d[k] = s[i * 3] / div; d[k + 1] = s[i * 3 + 1] / div; d[k + 2] = s[i * 3 + 2] / div; d[k + 3] = 255;
    }
  } else {
    for (let i = 0, k = 0; i < n; i++, k += 4) {
      d[k] = s[i * 3] * 255; d[k + 1] = s[i * 3 + 1] * 255; d[k + 2] = s[i * 3 + 2] * 255; d[k + 3] = 255;
    }
  }
  return { w, h, d };
}

/**
 * Decode a still image. Unsupported formats are refused with an explicit message: the app never
 * substitutes another decoder silently.
 */
export function decodeStill(bytes: Uint8Array): StillDecode {
  if (isPng(bytes)) {
    const png = decodePngExactSync(bytes);
    return { frame: { w: png.w, h: png.h, d: png.rgba }, format: "png", depth: png.depth, colorType: png.colorType, engine: "Native PNG decoder (exact samples)", warnings: png.animated ? ["The PNG file is animated: only its default image was decoded."] : [] };
  }
  if (isJpeg(bytes)) {
    const jpg = decodeJpeg(bytes);
    return { frame: { w: jpg.w, h: jpg.h, d: jpg.rgba }, format: "jpeg", depth: 8, engine: "Native JPEG decoder (baseline, sequential)", warnings: [] };
  }
  if (isBmp(bytes)) {
    const bmp = decodeBMP(bytes);
    return { frame: samplesToFrame(bmp.w, bmp.h, bmp.samples), format: "bmp", depth: 8, engine: "Native BMP decoder (24-bit)", warnings: [] };
  }
  if (isTiff(bytes)) {
    const tiff = decodeTIFF(bytes);
    const depth = tiff.samples instanceof Uint8Array ? 8 : tiff.samples instanceof Uint16Array ? 16 : 32;
    return { frame: samplesToFrame(tiff.w, tiff.h, tiff.samples), format: "tiff", depth, engine: "Native TIFF decoder (uncompressed RGB)", warnings: [] };
  }
  if (isWebp(bytes)) {
    throw new Error("WebP images are not supported by the native decoder yet; export the evidence as PNG or TIFF first.");
  }
  throw new Error("This file is not a still image format the native app can decode (PNG, JPEG, BMP and TIFF are supported).");
}
