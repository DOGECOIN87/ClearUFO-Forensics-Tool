// Still image sources: single images, multi-page TIFF, animated GIF/WebP/APNG and image sequences.
// Pixels are decoded without color management or EXIF re-orientation (forensic "as stored").
//
// PNG and TIFF are decoded by LUCID itself, exactly: 16-bit and 32-bit float samples keep their full
// precision (browsers decode to 8 bits) and no canvas is involved. Other formats use the browser's
// decoder; their pixels are read through a WebCodecs VideoFrame when that is verified to be exact,
// otherwise through a canvas (see ../pixelcheck.ts).
import * as UTIF from "utif2";
import { decodePngExact, isPng, type DecodedPng } from "../../shared/codecs/pngdecode";
import type { FrameMeta, SourceInfo } from "../../shared/types";
import { fromRGBA8, type Frame } from "../frame";
import { videoFrameReadbackExact } from "../pixelcheck";
import { baseInfo, fmtBytes, SourceFrameCache, type SourceProvider } from "./types";

const ascii = (d: Uint8Array, o: number, n: number) => String.fromCharCode(...d.subarray(o, o + n));

export function sniffImage(head: Uint8Array): string | null {
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "PNG";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "JPEG";
  if (ascii(head, 0, 3) === "GIF") return "GIF";
  if (head[0] === 0x42 && head[1] === 0x4d) return "BMP";
  if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0) || (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a)) return "TIFF";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return "WebP";
  if (ascii(head, 4, 4) === "ftyp" && /avif|avis/.test(ascii(head, 8, 4))) return "AVIF";
  if (ascii(head, 4, 4) === "ftyp" && /heic|heix|mif1/.test(ascii(head, 8, 4))) return "HEIF";
  if (head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0) return "ICO";
  return null;
}

/** Pixels of a decoded image: through a VideoFrame when that reads back exactly, otherwise a canvas. */
async function bitmapToFrame(src: ImageBitmap | VideoFrame, w: number, h: number): Promise<Frame> {
  const VF = (globalThis as { VideoFrame?: typeof VideoFrame }).VideoFrame;
  if (VF && (await videoFrameReadbackExact())) {
    let vf: VideoFrame | null = null;
    try {
      vf = src instanceof VF ? src : new VF(src as ImageBitmap, { timestamp: 0 });
      const fmt = vf.format;
      if (fmt && /^(RGBA|RGBX|BGRA|BGRX)$/.test(fmt) && vf.visibleRect && vf.visibleRect.width === w && vf.visibleRect.height === h) {
        const buf = new Uint8Array(vf.allocationSize());
        const L = (await vf.copyTo(buf))[0];
        const bgr = fmt.startsWith("BGR"), alpha = fmt.endsWith("A");
        const d = new Float32Array(w * h * 4);
        for (let y = 0; y < h; y++) {
          for (let x = 0, s = L.offset + y * L.stride, o = y * w * 4; x < w; x++, s += 4, o += 4) {
            d[o] = buf[bgr ? s + 2 : s]; d[o + 1] = buf[s + 1]; d[o + 2] = buf[bgr ? s : s + 2]; d[o + 3] = alpha ? buf[s + 3] : 255;
          }
        }
        return { w, h, d };
      }
    } catch { /* the canvas below */ }
    finally { if (vf && vf !== src) vf.close(); }
  }
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src as CanvasImageSource, 0, 0);
  return fromRGBA8(ctx.getImageData(0, 0, w, h).data, w, h);
}

const pngFrame = (p: DecodedPng): Frame => ({ w: p.w, h: p.h, d: p.rgba });
const PNG_KIND: Record<number, string> = { 0: "gray", 2: "RGB", 3: "palette", 4: "gray + alpha", 6: "RGB + alpha" };

/**
 * 16-bit and 32-bit float TIFF samples at full precision (UTIF's own conversion keeps 8 bits and applies
 * a display gamma to float data). Gray and RGB(A) in chunky layout; anything else returns null.
 */
function tiffExact(ifd: UTIF.IFD): { frame: Frame; depth: string } | null {
  const t = ifd as unknown as Record<string, number[] | undefined> & { data?: Uint8Array; isLE?: boolean };
  const w = ifd.width, h = ifd.height, data = t.data;
  if (!data || !w || !h) return null;
  const photometric = t.t262?.[0] ?? 2, bps = t.t258?.[0] ?? 1, fmt = t.t339?.[0] ?? 1;
  const spp = t.t277?.[0] ?? t.t258?.length ?? 1, planar = t.t284?.[0] ?? 1;
  const color = photometric === 2;
  if (planar !== 1 || photometric > 2 || (color && spp < 3)) return null;
  const float = bps === 32 && fmt === 3;
  if (!float && !(bps === 16 && fmt === 1)) return null;
  const B = bps / 8;
  if (data.length < w * h * spp * B) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // UTIF stores 16-bit samples little-endian; float samples keep the byte order of the file
  const le = float ? !!t.isLE : true;
  const get = float ? (o: number) => dv.getFloat32(o, le) * 255 : (o: number) => dv.getUint16(o, true) / 257;
  const alphaAt = spp > (color ? 3 : 1) && (t.t338?.[0] ?? 0) !== 0 ? (color ? 3 : 1) * B : -1;
  const white = photometric === 0;
  const d = new Float32Array(w * h * 4);
  for (let i = 0, o = 0; i < w * h; i++, o += 4) {
    const s = i * spp * B;
    if (color) { d[o] = get(s); d[o + 1] = get(s + B); d[o + 2] = get(s + 2 * B); }
    else { const v = get(s); d[o] = d[o + 1] = d[o + 2] = white ? 255 - v : v; }
    d[o + 3] = alphaAt >= 0 ? get(s + alphaAt) : 255;
  }
  return { frame: { w, h, d }, depth: float ? "32-bit float" : "16-bit" };
}

/** Pages of a TIFF file; 16-bit and float samples at full precision. */
function decodeTiff(buf: Uint8Array, maxPages = 500): { frames: Frame[]; depth: string | null; pages: number } {
  const ab = buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength ? buf.buffer as ArrayBuffer : buf.slice().buffer;
  const ifds = UTIF.decode(ab);
  const frames: Frame[] = [];
  let depth: string | null = null;
  for (const ifd of ifds.slice(0, maxPages)) {
    UTIF.decodeImage(ab, ifd);
    if (!ifd.width || !ifd.height) continue;
    const ex = tiffExact(ifd);
    if (ex) depth = ex.depth;
    frames.push(ex ? ex.frame : fromRGBA8(UTIF.toRGBA8(ifd), ifd.width, ifd.height));
  }
  return { frames, depth, pages: ifds.length };
}

/** One image (sequences, Motion JPEG frames): PNG and TIFF exactly, other formats by the browser. */
export async function decodeImageBlob(blob: Blob): Promise<Frame> {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  if (isPng(head)) {
    try { return pngFrame(await decodePngExact(new Uint8Array(await blob.arrayBuffer()))); }
    catch { /* damaged or unusual: the browser's decoder below */ }
  } else if (sniffImage(head) === "TIFF") {
    const { frames } = decodeTiff(new Uint8Array(await blob.arrayBuffer()), 1);
    if (frames.length) return frames[0];
    throw new Error("The TIFF file does not contain a decodable image");
  }
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(blob, { imageOrientation: "none" as ImageOrientation, premultiplyAlpha: "none", colorSpaceConversion: "none" }); }
  catch { bmp = await createImageBitmap(blob); }
  try { return await bitmapToFrame(bmp, bmp.width, bmp.height); } finally { bmp.close(); }
}

// ---------------------------------------------------------------- EXIF / JPEG structure
const EXIF_TAGS: Record<number, string> = {
  0x010f: "Make", 0x0110: "Model", 0x0112: "Orientation", 0x0131: "Software", 0x0132: "DateTime", 0x013b: "Artist", 0x8298: "Copyright",
  0x010e: "ImageDescription", 0x9003: "DateTimeOriginal", 0x9004: "DateTimeDigitized", 0x9010: "OffsetTime", 0x9011: "OffsetTimeOriginal", 0x829a: "ExposureTime", 0x829d: "FNumber",
  0x8827: "ISO", 0x920a: "FocalLength", 0xa002: "PixelXDimension", 0xa003: "PixelYDimension", 0xa420: "ImageUniqueID", 0xa433: "LensMake", 0xa434: "LensModel",
  0xa431: "BodySerialNumber", 0x9290: "SubSecTime", 0x9291: "SubSecTimeOriginal", 0xa405: "FocalLengthIn35mm", 0x9209: "Flash", 0xa403: "WhiteBalance",
};
const GPS_TAGS: Record<number, string> = { 1: "GPSLatitudeRef", 2: "GPSLatitude", 3: "GPSLongitudeRef", 4: "GPSLongitude", 5: "GPSAltitudeRef", 6: "GPSAltitude", 7: "GPSTimeStamp", 29: "GPSDateStamp" };
const ORIENT = ["", "Normal", "Mirror horizontal", "Rotate 180", "Mirror vertical", "Mirror horizontal + rotate 270 CW", "Rotate 90 CW", "Mirror horizontal + rotate 90 CW", "Rotate 270 CW"];

export function parseExif(tiff: Uint8Array): [string, string][] {
  const out: [string, string][] = [];
  if (tiff.length < 8) return out;
  const le = tiff[0] === 0x49;
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (o: number) => dv.getUint16(o, le), u32 = (o: number) => dv.getUint32(o, le);
  const sizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  const readVal = (type: number, count: number, off: number): string => {
    const sz = sizes[type] || 1;
    const p = sz * count > 4 ? u32(off) : off;
    if (p + sz * count > tiff.length) return "";
    if (type === 2) return ascii(tiff, p, count).replace(/\0+$/, "").trim();
    const vals: string[] = [];
    for (let i = 0; i < Math.min(count, 16); i++) {
      const q = p + i * sz;
      if (type === 3) vals.push(String(u16(q)));
      else if (type === 4) vals.push(String(u32(q)));
      else if (type === 9) vals.push(String(dv.getInt32(q, le)));
      else if (type === 5 || type === 10) {
        const a = type === 5 ? u32(q) : dv.getInt32(q, le), b = type === 5 ? u32(q + 4) : dv.getInt32(q + 4, le);
        vals.push(b ? (Math.abs(a / b) < 1 && a !== 0 ? `${a}/${b}` : String(+(a / b).toFixed(4))) : "0");
      } else vals.push(String(tiff[q]));
    }
    return vals.join(", ");
  };
  const walk = (ifd: number, names: Record<number, string>, prefix: string, depth: number) => {
    if (ifd <= 0 || ifd + 2 > tiff.length || depth > 3) return;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > tiff.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (tag === 0x8769) walk(u32(e + 8), EXIF_TAGS, "", depth + 1);
      else if (tag === 0x8825) walk(u32(e + 8), GPS_TAGS, "", depth + 1);
      else if (names[tag]) {
        let v = readVal(type, count, e + 8);
        if (tag === 0x0112) v = `${v} (${ORIENT[Number(v)] ?? "?"}) — not applied`;
        if (v) out.push([`${prefix}${names[tag]}`, v]);
      }
    }
  };
  walk(u32(4), EXIF_TAGS, "", 0);
  return out;
}

const STD_LUMA_Q = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];

export function analyzeJpeg(d: Uint8Array): [string, string][] {
  const out: [string, string][] = [];
  const segs: string[] = [];
  let p = 2;
  let quality: number | null = null;
  while (p + 4 <= d.length) {
    if (d[p] !== 0xff) { p++; continue; }
    const m = d[p + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { p += m === 0xff ? 1 : 2; continue; }
    if (m === 0xd9) { segs.push("EOI"); break; }
    const len = (d[p + 2] << 8) | d[p + 3];
    const body = d.subarray(p + 4, p + 2 + len);
    if (m >= 0xe0 && m <= 0xef) {
      const id = ascii(body, 0, Math.min(14, body.length)).replace(/\0.*$/s, "");
      segs.push(`APP${m - 0xe0}${id ? " " + id : ""}`);
      if (m === 0xe1 && id === "Exif") out.push(...parseExif(body.subarray(6)));
      if (m === 0xe0 && id === "JFIF") out.push(["JFIF Version", `${body[5]}.${String(body[6]).padStart(2, "0")}`]);
    } else if (m === 0xdb) {
      segs.push("DQT");
      let q = 0;
      while (q < body.length) {
        const pq = body[q] >> 4, tq = body[q] & 15;
        const vals: number[] = [];
        for (let i = 0; i < 64; i++) vals.push(pq ? (body[q + 1 + i * 2] << 8) | body[q + 2 + i * 2] : body[q + 1 + i]);
        if (tq === 0 && quality === null) {
          // zig-zag order ≈ the standard table order is irrelevant for the sum ratio
          const sum = vals.reduce((a, b) => a + b, 0), std = STD_LUMA_Q.reduce((a, b) => a + b, 0);
          const scale = (sum * 100) / std;
          quality = Math.max(1, Math.min(100, scale <= 100 ? (200 - scale) / 2 : 5000 / scale));
        }
        q += 1 + (pq ? 128 : 64);
      }
    } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const kind = m === 0xc0 ? "Baseline" : m === 0xc1 ? "Extended sequential" : m === 0xc2 ? "Progressive" : `SOF${m - 0xc0}`;
      segs.push(`SOF${m - 0xc0}`);
      out.push(["JPEG Encoding", kind]);
      out.push(["Bit Depth", String(body[0])]);
      const nc = body[5];
      if (nc === 3) {
        const h0 = body[7] >> 4, v0 = body[7] & 15, h1 = body[10] >> 4, v1 = body[10] & 15;
        const ss = h0 === 2 && v0 === 2 && h1 === 1 && v1 === 1 ? "4:2:0" : h0 === 2 && v0 === 1 && h1 === 1 ? "4:2:2" : h0 === v0 && h0 === h1 && v0 === v1 ? "4:4:4" : `${h0}x${v0},${h1}x${v1}`;
        out.push(["Chroma Subsampling", ss]);
      } else out.push(["Components", String(nc)]);
    } else if (m === 0xc4) segs.push("DHT");
    else if (m === 0xda) { segs.push("SOS"); p += 2 + len; while (p + 1 < d.length && !(d[p] === 0xff && d[p + 1] !== 0 && !(d[p + 1] >= 0xd0 && d[p + 1] <= 0xd7))) p++; continue; }
    else if (m === 0xfe) { segs.push("COM"); out.push(["JPEG Comment", ascii(body, 0, Math.min(200, body.length))]); }
    else segs.push(`0xFF${m.toString(16).toUpperCase()}`);
    p += 2 + len;
  }
  if (quality !== null) out.push(["Estimated JPEG Quality", `${Math.round(quality)} (from luminance quantization table)`]);
  out.push(["JPEG Structure", segs.join(", ")]);
  return out;
}

// ---------------------------------------------------------------- providers
function infoFor(id: string, name: string, w: number, h: number, frames: number, fps: number, size: number, fmt: string, engine: string, kind: SourceInfo["kind"] = "image"): SourceInfo {
  const info = baseInfo(id, name, kind);
  Object.assign(info, { width: w, height: h, frameCount: frames, fps, duration: frames / fps, fileSize: size, container: fmt, codec: fmt, engine, videoStreams: 1, frameTypesReady: true });
  return info;
}

export class StillSource implements SourceProvider {
  constructor(public id: string, public info: SourceInfo, private frames: Frame[], private delays?: number[]) {}
  getFrame(i: number) { return Promise.resolve(this.frames[Math.max(0, Math.min(this.frames.length - 1, i | 0))]); }
  meta(i: number): FrameMeta {
    let pts = 0;
    if (this.delays) for (let k = 0; k < i; k++) pts += this.delays[k] || 0; else pts = i / this.info.fps;
    return { type: "I", key: true, pts, src: i };
  }
  dispose() { this.frames = []; }
}

export async function openImage(id: string, file: File): Promise<SourceProvider> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const fmt = sniffImage(buf) ?? (file.type.split("/")[1] || "image").toUpperCase();
  const md: [string, string][] = [["Format", fmt], ["Size", fmtBytes(file.size)]];
  if (file.lastModified) md.push(["Last Modified (file system)", new Date(file.lastModified).toISOString()]);
  let frames: Frame[] = [];
  let delays: number[] | undefined;
  let engine = "Native browser decoder (no color management)";

  if (fmt === "TIFF") {
    const t = decodeTiff(buf);
    frames = t.frames;
    engine = t.depth ? `UTIF TIFF decoder (${t.depth} samples at full precision)` : "UTIF TIFF decoder";
    md.push(["TIFF Pages", String(t.pages)]);
    if (t.depth) md.push(["Sample Precision", `${t.depth} per channel, kept at full precision`]);
    try { md.push(...parseExif(buf)); } catch { /* optional */ }
    if (!frames.length) throw new Error("The TIFF file does not contain a decodable image");
    const w = frames[0].w, h = frames[0].h;
    frames = frames.filter((f) => f.w === w && f.h === h);
  } else {
    if (fmt === "JPEG") { try { md.push(...analyzeJpeg(buf)); } catch { /* optional */ } }
    let png: DecodedPng | null = null;
    if (fmt === "PNG") {
      try {
        png = await decodePngExact(buf);
        md.push(["PNG Samples", `${png.depth}-bit ${PNG_KIND[png.colorType] ?? png.colorType}${png.interlaced ? ", interlaced" : ""}${png.depth === 16 ? ", kept at full precision" : ""}`]);
        if (!png.animated) { frames = [pngFrame(png)]; engine = "LUCID PNG decoder (exact, no canvas)"; }
      } catch (e) { md.push(["PNG Decoder", `${(e as Error).message}; the browser's decoder was used`]); }
    }
    const ImageDecoderCtor = (self as any).ImageDecoder;
    const mime = fmt === "GIF" ? "image/gif" : fmt === "WebP" ? "image/webp" : fmt === "PNG" ? "image/png" : fmt === "AVIF" ? "image/avif" : null;
    if (!frames.length && ImageDecoderCtor && mime && (await ImageDecoderCtor.isTypeSupported?.(mime))) {
      try {
        const dec = new ImageDecoderCtor({ data: buf, type: mime, preferAnimation: true, colorSpaceConversion: "none" });
        await dec.tracks.ready;
        const n = Math.min(dec.tracks.selectedTrack?.frameCount ?? 1, 5000);
        if (n > 1) {
          engine = "WebCodecs ImageDecoder (animated)";
          delays = [];
          for (let i = 0; i < n; i++) {
            const r = await dec.decode({ frameIndex: i });
            const vf: VideoFrame = r.image;
            frames.push(await bitmapToFrame(vf, vf.displayWidth, vf.displayHeight));
            delays.push((vf.duration ?? 100000) / 1e6);
            vf.close();
          }
          md.push(["Animation Frames", String(n)]);
        }
        dec.close();
      } catch { frames = []; delays = undefined; }
    }
    if (!frames.length && png) { frames = [pngFrame(png)]; engine = "LUCID PNG decoder (exact, no canvas; first image of the animation)"; }
    if (!frames.length) frames = [await decodeImageBlob(file)];
  }
  const avgDelay = delays && delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : 0;
  const fps = avgDelay > 0 ? 1 / avgDelay : 25;
  const info = infoFor(id, file.name, frames[0].w, frames[0].h, frames.length, fps, file.size, fmt, engine);
  info.mime = file.type;
  info.metadata = md;
  return new StillSource(id, info, frames, delays);
}

/** Natural sort ("img2" < "img10"). */
export function naturalSort<T extends { name: string }>(files: T[]): T[] {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...files].sort((a, b) => coll.compare(a.name, b.name));
}

export class SequenceSource implements SourceProvider {
  info: SourceInfo;
  private cache = new SourceFrameCache(256 * 1024 * 1024);
  constructor(public id: string, private files: File[], first: Frame, fps: number) {
    const size = files.reduce((a, f) => a + f.size, 0);
    this.info = infoFor(id, files[0].name, first.w, first.h, files.length, fps, size, "Image Sequence", "Native browser decoder", "sequence");
    this.info.fileCount = files.length;
    this.info.metadata = [["First File", files[0].name], ["Last File", files[files.length - 1].name], ["Images", String(files.length)], ["Total Size", fmtBytes(size)]];
    this.cache.set("0", first);
  }
  static async open(id: string, files: File[], fps: number): Promise<SequenceSource> {
    const sorted = naturalSort(files);
    const first = await decodeImageBlob(sorted[0]);
    return new SequenceSource(id, sorted, first, fps);
  }
  async getFrame(i: number): Promise<Frame> {
    i = Math.max(0, Math.min(this.files.length - 1, i | 0));
    const hit = this.cache.get(String(i));
    if (hit) return hit;
    let f = await decodeImageBlob(this.files[i]);
    if (f.w !== this.info.width || f.h !== this.info.height) {
      // keep a constant size: place the image top-left on a black canvas
      const W = this.info.width, H = this.info.height;
      const out = new Float32Array(W * H * 4);
      for (let k = 3; k < out.length; k += 4) out[k] = 255;
      for (let y = 0; y < Math.min(H, f.h); y++) for (let x = 0; x < Math.min(W, f.w); x++) {
        const s = (y * f.w + x) * 4, o = (y * W + x) * 4;
        out[o] = f.d[s]; out[o + 1] = f.d[s + 1]; out[o + 2] = f.d[s + 2];
      }
      f = { w: W, h: H, d: out };
      if (!this.info.warnings.includes("size")) this.info.warnings.push(`Image ${this.files[i].name} has a different size and was padded.`);
    }
    this.cache.set(String(i), f);
    return f;
  }
  meta(i: number): FrameMeta { return { type: "I", key: true, pts: i / this.info.fps, src: i }; }
  fileName(i: number) { return this.files[i]?.name; }
  dispose() { this.cache.clear(); }
}
