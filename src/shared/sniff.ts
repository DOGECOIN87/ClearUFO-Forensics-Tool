// Content based file identification ("magic bytes").
//
// File names and MIME types cannot be trusted for routing decisions: mobile file pickers
// often drop or rewrite extensions, `File.type` is empty for most forensic formats, and
// users pick the "wrong" command (e.g. a video in File › Open Project…). Every file that
// enters the application is therefore classified from its first bytes.

export type FileKind = "project" | "image" | "video" | "audio" | "other";

export interface Sniffed {
  kind: FileKind;
  /** Short format id, e.g. "webm", "jpeg", "dahua". */
  format: string;
  /** Human readable description, e.g. "WebM video". */
  label: string;
  /**
   * True when the identification is certain enough to refuse the file outright
   * (e.g. a ZIP archive offered as video). Unknown binary data is never "definite":
   * it may still be a proprietary DVR stream that Convert DVR can recover.
   */
  definite: boolean;
}

/** Number of leading bytes needed by {@link sniffBytes}. */
export const SNIFF_BYTES = 4096;

const asc = (d: Uint8Array, o: number, n: number) => {
  let s = "";
  for (let i = o; i < o + n && i < d.length; i++) s += String.fromCharCode(d[i]);
  return s;
};
const indexOfAscii = (d: Uint8Array, needle: string, limit = d.length) => {
  const n = needle.length, end = Math.min(d.length, limit) - n;
  outer: for (let i = 0; i <= end; i++) {
    for (let k = 0; k < n; k++) if (d[i + k] !== needle.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
};

const S = (kind: FileKind, format: string, label: string, definite = true): Sniffed => ({ kind, format, label, definite });

/** Identifies a file from its first bytes (`head`, ideally {@link SNIFF_BYTES} long) and total size. */
export function sniffBytes(head: Uint8Array, size = head.length): Sniffed {
  const d = head;
  if (size === 0 || d.length === 0) return S("other", "empty", "empty file");
  const a4 = asc(d, 0, 4), b4 = asc(d, 4, 4), c4 = asc(d, 8, 4);

  // ---------------------------------------------------------------- images
  if (d[0] === 0x89 && a4.slice(1) === "PNG") return S("image", "png", "PNG image");
  if (d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return S("image", "jpeg", "JPEG image");
  if (asc(d, 0, 6) === "GIF87a" || asc(d, 0, 6) === "GIF89a") return S("image", "gif", "GIF image");
  if ((a4 === "II*\0") || (a4 === "MM\0*")) return S("image", "tiff", "TIFF image");
  if (a4 === "RIFF" && c4 === "WEBP") return S("image", "webp", "WebP image");
  if (d[0] === 0x42 && d[1] === 0x4d && d.length >= 18) {
    const hdr = d[14] | (d[15] << 8) | (d[16] << 16) | (d[17] << 24);
    if ([12, 40, 52, 56, 64, 108, 124].includes(hdr)) return S("image", "bmp", "BMP image");
  }
  if (d[0] === 0 && d[1] === 0 && d[2] === 1 && d[3] === 0 && d[4] > 0 && d[5] === 0) return S("image", "ico", "ICO image");

  // ---------------------------------------------------------------- ISO BMFF / QuickTime
  if (b4 === "ftyp") {
    const brand = c4.toLowerCase();
    const compat = asc(d, 16, Math.max(0, Math.min(64, (d[0] << 24 | d[1] << 16 | d[2] << 8 | d[3]) - 16))).toLowerCase();
    if (/^(avif|avis)$/.test(brand)) return S("image", "avif", "AVIF image");
    if (/^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(brand) || (/^mif1/.test(brand) && /heic|avif/.test(compat))) return S("image", "heif", "HEIF image");
    if (/^m4[abp] $/.test(brand)) return S("audio", "m4a", "M4A audio");
    if (brand === "qt  ") return S("video", "mov", "QuickTime video");
    if (/^3g/.test(brand)) return S("video", "3gp", "3GP video");
    return S("video", "mp4", "MP4 video");
  }
  if (["moov", "mdat", "wide", "free", "skip", "pnot"].includes(b4) && d[0] === 0) return S("video", "mov", "QuickTime video");

  // ---------------------------------------------------------------- other containers
  if (d[0] === 0x1a && d[1] === 0x45 && d[2] === 0xdf && d[3] === 0xa3) {
    if (indexOfAscii(d, "webm", 64) >= 0) return S("video", "webm", "WebM video");
    if (indexOfAscii(d, "matroska", 64) >= 0) return S("video", "mkv", "Matroska (MKV) video");
    return S("video", "mkv", "Matroska/WebM video");
  }
  if (a4 === "RIFF" && c4 === "AVI ") return S("video", "avi", "AVI video");
  if (a4 === "RIFF" && c4 === "WAVE") return S("audio", "wav", "WAV audio");
  if (d[0] === 0x30 && d[1] === 0x26 && d[2] === 0xb2 && d[3] === 0x75 && d[4] === 0x8e && d[5] === 0x66) return S("video", "asf", "ASF/WMV video");
  if (asc(d, 0, 3) === "FLV" && d[3] === 1) return S("video", "flv", "FLV video");
  if (a4 === "IMKH") return S("video", "hikvision", "Hikvision DVR video");
  if (indexOfAscii(d, "DHAV", 1024) >= 0) return S("video", "dahua", "Dahua DAV (DVR) video");
  if (d[0] === 0 && d[1] === 0 && d[2] === 1 && d[3] === 0xba) return S("video", "mpeg-ps", "MPEG program stream");
  if (d[0] === 0 && d[1] === 0 && d[2] === 1 && d[3] === 0xb3) return S("video", "mpeg-es", "MPEG video stream");
  if (isTs(d, 0, 188)) return S("video", "mpeg-ts", "MPEG transport stream");
  if (isTs(d, 4, 192)) return S("video", "m2ts", "MPEG-2 transport stream (M2TS)");
  const es = annexB(d);
  if (es) return S("video", es, es === "h265" ? "H.265/HEVC elementary stream" : "H.264/AVC elementary stream");

  // ---------------------------------------------------------------- audio
  if (asc(d, 0, 3) === "ID3") return S("audio", "mp3", "MP3 audio");
  if (a4 === "fLaC") return S("audio", "flac", "FLAC audio");
  if (asc(d, 0, 5) === "#!AMR") return S("audio", "amr", "AMR audio");
  if (a4 === "OggS") return S("audio", "ogg", "Ogg media", false);
  if (d[0] === 0xff && (d[1] & 0xf6) === 0xf0 && ((d[2] >> 2) & 0xf) < 13) return S("audio", "aac", "AAC audio");
  if (d[0] === 0xff && (d[1] & 0xe0) === 0xe0 && ((d[1] >> 1) & 3) !== 0 && (d[2] >> 4) !== 15) return S("audio", "mpeg-audio", "MPEG audio", false);

  // ---------------------------------------------------------------- non media
  if (a4 === "PK\x03\x04" || a4 === "PK\x05\x06") return S("other", "zip", "ZIP archive (or Office document)");
  if (a4 === "%PDF") return S("other", "pdf", "PDF document");
  if (asc(d, 0, 6) === "7z\xbc\xaf\x27\x1c") return S("other", "7z", "7-Zip archive");
  if (a4 === "Rar!") return S("other", "rar", "RAR archive");
  if (d[0] === 0x1f && d[1] === 0x8b) return S("other", "gzip", "GZIP archive");
  if (d[0] === 0xd0 && d[1] === 0xcf && d[2] === 0x11 && d[3] === 0xe0) return S("other", "ole", "legacy Office document");
  if (asc(d, 0, 2) === "MZ") return S("other", "exe", "Windows executable");
  if (a4 === "\x7fELF") return S("other", "elf", "executable");

  // ---------------------------------------------------------------- text (projects are JSON)
  const t = textStart(d);
  if (t >= 0) {
    const c = String.fromCharCode(d[t]);
    if (c === "{") return S("project", "json", "JSON document");
    const lead = asc(d, t, 256).toLowerCase();
    if (c === "[") return S("other", "json", "JSON document");
    if (lead.startsWith("<svg") || (lead.startsWith("<?xml") && lead.includes("<svg"))) return S("other", "svg", "SVG drawing");
    if (lead.startsWith("<!doctype html") || lead.startsWith("<html")) return S("other", "html", "HTML page");
    if (lead.startsWith("<?xml")) return S("other", "xml", "XML document");
    if (isMostlyText(d)) return S("other", "text", "text file");
  }
  return S("other", "binary", "unrecognized binary file", false);
}

/** Reads the head of a file (or any Blob) and classifies it. */
export async function sniffFile(file: Blob): Promise<Sniffed> {
  try {
    const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    return sniffBytes(head, file.size);
  } catch {
    return S("other", "unreadable", "unreadable file", false);
  }
}

/** "a WebM video", "an MP4 video", "an unrecognized binary file". */
export function withArticle(label: string): string {
  const w = label.split(/[\s/]/)[0];
  // Initialisms are spelled out: "an MP4", "an H.264", "an SVG" — but "a FLAC", "a HEIF".
  const initialism = /^[A-Z0-9.-]+$/.test(w) && !/^(FLAC|HEIF|RAR|JPEG|GIF|PNG|TIFF|ZIP|GZIP|JSON|WAV)$/.test(w);
  const an = /^[aeio]/i.test(w) || /^un/i.test(w) || (initialism && /^[FHLMNRSX]/.test(w));
  return `${an ? "an" : "a"} ${label}`;
}

function isTs(d: Uint8Array, off: number, stride: number): boolean {
  if (d.length < off + stride * 2 + 1) return false;
  let n = 0;
  for (let p = off; p < d.length && n < 4; p += stride, n++) if (d[p] !== 0x47) return false;
  return n >= 3 || (n >= 2 && d.length < off + stride * 3 + 1);
}

/** Annex B elementary stream (leading zero bytes, then a start code and a plausible NAL header). */
function annexB(d: Uint8Array): "h264" | "h265" | null {
  let i = 0;
  while (i < d.length && i < 64 && d[i] === 0) i++;
  if (i < 2 || d[i] !== 1 || i + 2 >= d.length) return null;
  const b0 = d[i + 1], b1 = d[i + 2];
  if (b0 & 0x80) return null;
  const t5 = (b0 >> 1) & 0x3f;
  if ((b0 & 0x81) === 0 && b1 === 0x01 && [32, 33, 34, 35, 39, 19, 20, 21, 1].includes(t5)) return "h265";
  if ([1, 5, 6, 7, 8, 9].includes(b0 & 0x1f)) return "h264";
  return null;
}

/** Offset of the first non blank character when the data looks like UTF-8/ASCII text, else -1. */
function textStart(d: Uint8Array): number {
  let i = d[0] === 0xef && d[1] === 0xbb && d[2] === 0xbf ? 3 : 0;
  while (i < d.length && (d[i] === 0x20 || d[i] === 0x09 || d[i] === 0x0a || d[i] === 0x0d)) i++;
  return i < d.length && d[i] >= 0x20 && d[i] < 0x7f ? i : -1;
}

function isMostlyText(d: Uint8Array): boolean {
  const n = Math.min(d.length, 1024);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = d[i];
    if (c === 0) return false;
    if (c < 0x09 || (c > 0x0d && c < 0x20)) bad++;
  }
  return bad <= n * 0.01;
}
