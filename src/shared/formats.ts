// Export formats: one catalogue for the Write dialogs, the writer filters, the engine and the tests.
import { AviWriter } from "./codecs/avi";
import { bmpSize, pngSize, tiffSize } from "./codecs/image";
import { ZipWriter } from "./codecs/zip";

export type WriteFormat =
  | "avi-raw" | "tiff16" | "tiff" | "tiff32f" | "png16" | "png" | "bmp"
  | "avi-mjpeg" | "mp4" | "webm" | "jpeg" | "webp";

export interface FormatInfo {
  /** Label in the Write dialogs. */
  label: string;
  /** Short label (writer filters, messages). */
  short: string;
  /** Lossy formats discard detail; they are hidden while "Lossless exports only" is on. */
  lossy: boolean;
  /** Video containers write one file; image formats write one file per frame (a ZIP for several). */
  video: boolean;
  ext: string;
  mime: string;
  /** Bits per channel as written ("" when the encoder decides). */
  depth: string;
  /** Bytes per pixel of the stored samples (uncompressed formats). */
  bpp?: 3 | 6 | 12;
}

export const FORMATS: Record<WriteFormat, FormatInfo> = {
  "avi-raw": { label: "AVI — uncompressed RGB, 8-bit", short: "AVI (uncompressed)", lossy: false, video: true, ext: "avi", mime: "video/x-msvideo", depth: "8-bit", bpp: 3 },
  tiff16: { label: "TIFF — uncompressed, 16-bit", short: "TIFF 16-bit (uncompressed)", lossy: false, video: false, ext: "tif", mime: "image/tiff", depth: "16-bit", bpp: 6 },
  tiff: { label: "TIFF — uncompressed, 8-bit", short: "TIFF 8-bit (uncompressed)", lossy: false, video: false, ext: "tif", mime: "image/tiff", depth: "8-bit", bpp: 3 },
  tiff32f: { label: "TIFF — uncompressed, 32-bit float", short: "TIFF 32-bit float (uncompressed)", lossy: false, video: false, ext: "tif", mime: "image/tiff", depth: "32-bit float", bpp: 12 },
  png16: { label: "PNG — uncompressed, 16-bit", short: "PNG 16-bit (uncompressed)", lossy: false, video: false, ext: "png", mime: "image/png", depth: "16-bit", bpp: 6 },
  png: { label: "PNG — uncompressed, 8-bit", short: "PNG 8-bit (uncompressed)", lossy: false, video: false, ext: "png", mime: "image/png", depth: "8-bit", bpp: 3 },
  bmp: { label: "BMP — uncompressed, 8-bit", short: "BMP (uncompressed)", lossy: false, video: false, ext: "bmp", mime: "image/bmp", depth: "8-bit", bpp: 3 },
  "avi-mjpeg": { label: "AVI — Motion JPEG (lossy)", short: "AVI Motion JPEG (lossy)", lossy: true, video: true, ext: "avi", mime: "video/x-msvideo", depth: "" },
  mp4: { label: "MP4 — H.264, HEVC or AV1 (lossy)", short: "MP4 (lossy)", lossy: true, video: true, ext: "mp4", mime: "video/mp4", depth: "" },
  webm: { label: "WebM — VP9, VP8 or AV1 (lossy)", short: "WebM (lossy)", lossy: true, video: true, ext: "webm", mime: "video/webm", depth: "" },
  jpeg: { label: "JPEG (lossy)", short: "JPEG (lossy)", lossy: true, video: false, ext: "jpg", mime: "image/jpeg", depth: "8-bit" },
  webp: { label: "WebP (lossy)", short: "WebP (lossy)", lossy: true, video: false, ext: "webp", mime: "image/webp", depth: "8-bit" },
};

export const isWriteFormat = (f: unknown): f is WriteFormat => typeof f === "string" && f in FORMATS;
/** Unknown formats count as lossy (refused while lossless-only is on). */
export const isLossy = (f: string) => (isWriteFormat(f) ? FORMATS[f].lossy : true);

/** Formats offered for video export, lossless first. Image formats write a numbered sequence (ZIP). */
export const VIDEO_EXPORT: WriteFormat[] = ["avi-raw", "tiff16", "tiff32f", "png16", "tiff", "png", "avi-mjpeg", "mp4", "webm"];
export const IMAGE_EXPORT: WriteFormat[] = ["tiff16", "tiff", "tiff32f", "png16", "png", "bmp", "jpeg", "webp"];

/** Label for a format in a list; image formats in the video list are sequences (one ZIP archive, stored). */
export function formatLabel(f: WriteFormat, sequence = false): string {
  // compact labels (they must fit a phone screen); the dialog note gives the details
  const fi = FORMATS[f];
  return sequence && !fi.video ? fi.label.replace(/^(\w+) —/, "$1 sequence —") : fi.label;
}

/** Names of the files inside a sequence archive (also used by the writer). */
export function sequenceName(base: string, frame: number, last: number, ext: string) {
  return `${base}_${String(frame).padStart(Math.max(4, String(last).length), "0")}.${ext}`;
}

export function sanitizeName(name: string) { return (name || "output").replace(/[\\/:*?"<>|]+/g, "_").trim() || "output"; }

/** File name and type of an export of `count` frames. */
export function outputFile(f: WriteFormat, name: string, count: number): { name: string; ext: string; mime: string; zip: boolean } {
  const fi = FORMATS[f], zip = !fi.video && count > 1;
  const ext = zip ? "zip" : fi.ext;
  return { name: `${sanitizeName(name)}.${ext}`, ext, mime: zip ? "application/zip" : fi.mime, zip };
}

/** Exact size of an uncompressed export (bytes), or null when it depends on the content (lossy formats). */
export function estimateBytes(f: WriteFormat, w: number, h: number, start: number, end: number, name = "output"): number | null {
  const count = Math.max(1, end - start + 1);
  const one = f === "tiff16" ? tiffSize(w, h, 2) : f === "tiff" ? tiffSize(w, h, 1) : f === "tiff32f" ? tiffSize(w, h, 4)
    : f === "png16" ? pngSize(w, h, 2) : f === "png" ? pngSize(w, h, 1) : f === "bmp" ? bmpSize(w, h) : null;
  if (f === "avi-raw") return AviWriter.rawFileSize(w, h, count);
  if (one === null) return null;
  if (count === 1) return one;
  const base = sanitizeName(name), ext = FORMATS[f].ext;
  // names only affect a few bytes per entry: sample them instead of building a huge list
  const nameLen = new TextEncoder().encode(sequenceName(base, end, end, ext)).length;
  const sample = ZipWriter.size([{ name: "x".repeat(nameLen), size: one }]) - 22;
  const total = sample * count + 22;
  return total >= 0xffffffff || count >= 0xffff ? total + 76 + (total >= 0xffffffff ? 12 * count : 0) : total;
}

/** Bytes of one uncompressed frame in a format (for messages), or null. */
export function frameBytes(f: WriteFormat, w: number, h: number): number | null {
  const fi = FORMATS[f];
  return fi.bpp ? w * h * fi.bpp : null;
}
