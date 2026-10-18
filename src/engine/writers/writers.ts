// Export. Lossless: uncompressed AVI (OpenDML, any length) and uncompressed image files or sequences
// (TIFF 8/16-bit or 32-bit float, PNG 8/16-bit, BMP; sequences in a stored ZIP). Lossy, only when
// allowed in Settings: MP4/WebM (WebCodecs via Mediabunny), AVI Motion JPEG, JPEG and WebP.
//
// Output streams to disk when the app passes a file handle (File System Access) or names a staging file in
// the browser's storage (engine/staging.ts), otherwise to a Blob.
// Lossless exports can be verified: the written file is read back (AVI through the same parser the app
// uses to load files) and every frame is compared with the processed frame by MD5.
import { BufferTarget, canEncodeVideo, Mp4OutputFormat, Output, Quality, VideoSample, VideoSampleSource, WebMOutputFormat } from "mediabunny";
import { AviWriter } from "../../shared/codecs/avi";
import { crc32, decodeBMP, decodePNG, decodeTIFF, dib24, dibStride, encodeBMP, encodePNG, encodeTIFF, rgbFromDib24, sampleBytesLE, type Samples } from "../../shared/codecs/image";
import { BlobSink, FileSink, type ByteSink } from "../../shared/codecs/sink";
import { readZipEntries, ZipWriter } from "../../shared/codecs/zip";
import { openStaged, removeStaged, type StagedFile } from "../staging";
import { FORMATS, isWriteFormat, outputFile, sequenceName, type WriteFormat } from "../../shared/formats";
import type { WriteRequest, WriteResult } from "../../shared/types";
import { toRGBA8, type Frame } from "../frame";
import { md5 } from "../hash";
import { parseAvi } from "../sources/avi";
import type { Stream } from "../stream";

// ---------------------------------------------------------------- frame → samples
/** 8-bit RGB, rounded exactly like the viewer and the frame hash (round half to even, clamp). */
export function rgb8(f: Frame): Uint8Array {
  const n = f.w * f.h * 3, d = f.d, c = new Uint8ClampedArray(n);
  for (let i = 0, k = 0; i < n; i += 3, k += 4) { c[i] = d[k]; c[i + 1] = d[k + 1]; c[i + 2] = d[k + 2]; }
  return new Uint8Array(c.buffer);
}

/** 16-bit RGB: 0..255 maps to 0..65535 (×257), so 8-bit levels stay exact and fractions are kept. */
export function rgb16(f: Frame): Uint16Array {
  const n = f.w * f.h * 3, d = f.d, s = new Uint16Array(n);
  for (let i = 0, k = 0; i < n; i += 3, k += 4) {
    for (let c = 0; c < 3; c++) { const v = d[k + c]; s[i + c] = v > 0 ? (v < 255 ? Math.round(v * 257) : 65535) : 0; }
  }
  return s;
}

/** 32-bit float RGB: 0..255 maps to 0.0..1.0; values outside the range are kept. */
export function rgbf32(f: Frame): Float32Array {
  const n = f.w * f.h * 3, d = f.d, s = new Float32Array(n);
  for (let i = 0, k = 0; i < n; i += 3, k += 4) {
    for (let c = 0; c < 3; c++) { const v = d[k + c]; s[i + c] = v === v ? v / 255 : 0; }
  }
  return s;
}

// ---------------------------------------------------------------- still images
export async function encodeCanvas(f: Frame, type: "image/jpeg" | "image/webp", quality: number): Promise<Uint8Array> {
  const c = new OffscreenCanvas(f.w, f.h);
  c.getContext("2d")!.putImageData(new ImageData(toRGBA8(f) as Uint8ClampedArray<ArrayBuffer>, f.w, f.h), 0, 0);
  const blob = await c.convertToBlob({ type, quality });
  // Browsers without an encoder for the type silently return PNG (Safari has no WebP encoder): never
  // write a file whose content does not match its format.
  if (blob.type !== type) throw new Error(`This browser cannot encode ${type === "image/webp" ? "WebP" : "JPEG"} images. Choose an uncompressed format.`);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Encodes one frame; `hash` is the MD5 of the stored samples (lossless formats only). */
export async function encodeStill(f: Frame, fmt: WriteFormat, quality: number, wantHash: boolean): Promise<{ bytes: Uint8Array; hash?: string }> {
  let s: Samples, bytes: Uint8Array;
  switch (fmt) {
    case "tiff16": s = rgb16(f); bytes = encodeTIFF(f.w, f.h, s); break;
    case "tiff32f": s = rgbf32(f); bytes = encodeTIFF(f.w, f.h, s); break;
    case "tiff": s = rgb8(f); bytes = encodeTIFF(f.w, f.h, s); break;
    case "png16": { const v = rgb16(f); s = v; bytes = encodePNG(f.w, f.h, v); break; }
    case "png": { const v = rgb8(f); s = v; bytes = encodePNG(f.w, f.h, v); break; }
    case "bmp": { const v = rgb8(f); s = v; bytes = encodeBMP(f.w, f.h, v); break; }
    case "jpeg": return { bytes: await encodeCanvas(f, "image/jpeg", quality) };
    case "webp": return { bytes: await encodeCanvas(f, "image/webp", quality) };
    default: throw new Error(`${FORMATS[fmt]?.short ?? fmt} is not an image format`);
  }
  return { bytes, hash: wantHash ? md5(sampleBytesLE(s)) : undefined };
}

export function decodeStill(fmt: WriteFormat, bytes: Uint8Array): Samples {
  if (fmt === "tiff" || fmt === "tiff16" || fmt === "tiff32f") return decodeTIFF(bytes).samples;
  if (fmt === "png" || fmt === "png16") return decodePNG(bytes).samples;
  if (fmt === "bmp") return decodeBMP(bytes).samples;
  throw new Error(`${fmt} files cannot be verified`);
}

function padEven(f: Frame): Frame {
  const W = f.w + (f.w & 1), H = f.h + (f.h & 1);
  if (W === f.w && H === f.h) return f;
  const d = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = (Math.min(y, f.h - 1) * f.w + Math.min(x, f.w - 1)) * 4, o = (y * W + x) * 4;
    d[o] = f.d[s]; d[o + 1] = f.d[s + 1]; d[o + 2] = f.d[s + 2]; d[o + 3] = 255;
  }
  return { w: W, h: H, d };
}

type Progress = (label: string, v: number) => void;

// ---------------------------------------------------------------- verification
async function verifyOutput(file: Blob, fmt: WriteFormat, zip: boolean, expected: string[], names: string[], w: number, h: number, progress: Progress, check: () => void): Promise<{ ok: boolean; message: string }> {
  const n = expected.length;
  const fail = (i: number, why: string) => ({ ok: false, message: `Frame ${i + 1} of ${n}: ${why}` });
  if (fmt === "avi-raw") {
    const a = await parseAvi(file);
    if (a.frames.length !== n) return { ok: false, message: `The file holds ${a.frames.length} frames instead of ${n}` };
    if (a.width !== w || a.height !== h || a.bitCount !== 24 || a.compression !== "BI_RGB") return { ok: false, message: "The file header does not describe uncompressed 24-bit RGB" };
    const size = dibStride(w) * h;
    for (let i = 0; i < n; i++) {
      check();
      const fr = a.frames[i];
      if (fr.size !== size) return fail(i, `stored size ${fr.size} bytes, expected ${size}`);
      const data = new Uint8Array(await file.slice(fr.off, fr.off + fr.size).arrayBuffer());
      if (md5(rgbFromDib24(data, w, h, a.bottomUp)) !== expected[i]) return fail(i, "the pixels read back differ from the processed frame");
      progress("Verifying", (i + 1) / n);
    }
    return { ok: true, message: `All ${n} frame${n === 1 ? "" : "s"} read back from the file are bit-identical to the processed frames` };
  }
  if (!zip) {
    const s = decodeStill(fmt, new Uint8Array(await file.arrayBuffer()));
    progress("Verifying", 1);
    return md5(sampleBytesLE(s)) === expected[0] ? { ok: true, message: "The image read back from the file is bit-identical to the processed frame" } : fail(0, "the pixels read back differ from the processed frame");
  }
  const entries = await readZipEntries(file);
  if (entries.length !== n) return { ok: false, message: `The archive holds ${entries.length} files instead of ${n}` };
  for (let i = 0; i < n; i++) {
    check();
    const e = entries[i];
    if (e.name !== names[i]) return fail(i, `unexpected file ${e.name}`);
    const bytes = new Uint8Array(await file.slice(e.offset, e.offset + e.size).arrayBuffer());
    if (crc32(bytes) !== e.crc) return fail(i, `${e.name} fails its ZIP checksum`);
    if (md5(sampleBytesLE(decodeStill(fmt, bytes))) !== expected[i]) return fail(i, `${e.name}: the pixels read back differ from the processed frame`);
    progress("Verifying", (i + 1) / n);
  }
  return { ok: true, message: `All ${n} images read back from the archive are bit-identical to the processed frames` };
}

// ---------------------------------------------------------------- write entry point
export async function writeStream(stream: Stream, req: WriteRequest, progress: Progress, cancelled: () => boolean): Promise<WriteResult> {
  if (!isWriteFormat(req.format)) throw new Error(`Unknown output format "${req.format}"`);
  const fmt = req.format, fi = FORMATS[fmt];
  const n = stream.info.frameCount;
  const a = Math.max(0, Math.min(n - 1, req.start)), b = Math.max(a, Math.min(n - 1, req.end));
  const count = b - a + 1;
  const fps = req.fps && req.fps > 0 ? req.fps : stream.info.fps || 25;
  const out = outputFile(fmt, req.name, count);
  const base = out.name.slice(0, -(out.ext.length + 1));
  const verify = !!req.verify && !fi.lossy;
  const check = () => { if (cancelled()) throw new Error("Cancelled"); };
  if (req.handle && !FileSink.supported()) throw new Error("This browser cannot write directly to a file");
  const staged: StagedFile | null = !req.handle && req.stage ? await openStaged(req.stage) : null;
  const sink: ByteSink = req.handle ? await FileSink.open(req.handle) : staged ? staged.sink : new BlobSink();
  const discard = async () => { await sink.abort(); if (staged) await removeStaged([staged.entry]); };
  const hashes: string[] = [], names: string[] = [];
  let codec: string | undefined, w = 0, h = 0;
  try {
    if (!fi.video) {
      // ---- still images: one file, or a stored ZIP of numbered files
      const zip = out.zip ? new ZipWriter(sink, { forceZip64: req.forceZip64 }) : null;
      for (let i = a; i <= b; i++) {
        check();
        const f = await stream.getFrame(i);
        w = f.w; h = f.h;
        const e = await encodeStill(f, fmt, req.quality, verify);
        if (e.hash) hashes.push(e.hash);
        if (zip) { const nm = sequenceName(base, i, b, fi.ext); names.push(nm); await zip.add(nm, e.bytes); }
        else await sink.write(e.bytes);
        progress("Writing", (i - a + 1) / count);
      }
      if (zip) await zip.finish();
    } else if (fmt === "avi-raw" || fmt === "avi-mjpeg") {
      // ---- AVI: uncompressed DIB frames (or Motion JPEG), OpenDML for files above 1 GB
      const first = await stream.getFrame(a);
      w = first.w; h = first.h;
      const avi = new AviWriter(sink, { width: w, height: h, fps, codec: fmt === "avi-raw" ? "raw24" : "mjpeg", segmentBytes: req.segmentBytes });
      await avi.begin();
      for (let i = a; i <= b; i++) {
        check();
        const f = i === a ? first : await stream.getFrame(i);
        if (f.w !== w || f.h !== h) throw new Error(`Frame ${i + 1} is ${f.w}×${f.h} but the video is ${w}×${h}. An AVI file has one frame size: add a Resize or Crop filter, or export an image sequence.`);
        if (fmt === "avi-raw") {
          const rgb = rgb8(f);
          if (verify) hashes.push(md5(rgb));
          await avi.add(dib24(w, h, rgb));
        } else await avi.add(await encodeCanvas(f, "image/jpeg", req.quality));
        progress("Writing", (i - a + 1) / count);
      }
      await avi.finish();
      codec = fmt === "avi-raw" ? "uncompressed RGB 24-bit" : "Motion JPEG";
    } else {
      // ---- MP4 / WebM through WebCodecs (lossy)
      if (typeof VideoEncoder === "undefined") throw new Error("This browser has no WebCodecs video encoder. Use AVI (uncompressed) instead.");
      const first = padEven(await stream.getFrame(a));
      w = first.w; h = first.h;
      const candidates = fmt === "mp4" ? (["avc", "hevc", "av1"] as const) : (["vp9", "vp8", "av1"] as const);
      let c: (typeof candidates)[number] | null = null;
      for (const x of candidates) { if (await canEncodeVideo(x, { width: first.w, height: first.h })) { c = x; break; } }
      if (!c) throw new Error(`No ${fmt.toUpperCase()} encoder available for ${first.w}x${first.h} in this browser. Use AVI (uncompressed) instead.`);
      const output = new Output({ format: fmt === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(), target: new BufferTarget() });
      const bitrate = Math.round(first.w * first.h * fps * (0.05 + req.quality * 0.35));
      const source = new VideoSampleSource({ codec: c, quality: new Quality({ bitrate }), keyFrameInterval: 1, sizeChangeBehavior: "fill" });
      output.addVideoTrack(source, { frameRate: fps });
      await output.start();
      for (let i = a; i <= b; i++) {
        check();
        const f = i === a ? first : padEven(await stream.getFrame(i));
        const sample = new VideoSample(toRGBA8(f), { format: "RGBA", codedWidth: f.w, codedHeight: f.h, timestamp: (i - a) / fps, duration: 1 / fps });
        await source.add(sample);
        sample.close();
        progress("Writing", (i - a + 1) / count);
      }
      await output.finalize();
      await sink.write(new Uint8Array((output.target as BufferTarget).buffer!));
      codec = { avc: "H.264", hevc: "HEVC", av1: "AV1", vp9: "VP9", vp8: "VP8" }[c];
    }
  } catch (e) {
    await discard();
    throw e;
  }
  const bytes = sink.pos;
  let blob: Blob | null;
  try { blob = await sink.close(out.mime); } catch (e) { await discard(); throw e; }
  const result: WriteResult = { name: req.handle?.name ?? out.name, mime: out.mime, bytes, frames: count, codec, savedToDisk: !!req.handle, width: w, height: h };
  if (blob) result.blob = blob;
  if (staged) {
    result.file = await staged.handle.getFile();
    result.staged = staged.entry;
    if (result.file.size !== bytes) { await removeStaged([staged.entry]); throw new Error(`The staging file holds ${result.file.size} bytes instead of ${bytes}`); }
  }
  if (verify) {
    // The file is complete at this point: a failed or cancelled check is reported, the file is kept.
    result.hashes = hashes;
    try {
      const file = blob ?? result.file ?? (await req.handle!.getFile());
      result.verified = await verifyOutput(file, fmt, out.zip, hashes, names, w, h, progress, check);
    } catch (e) {
      const m = (e as Error)?.message ?? String(e);
      result.verified = { ok: false, cancelled: m === "Cancelled", message: m === "Cancelled" ? "Verification was cancelled" : `The file could not be read back: ${m}` };
    }
  }
  return result;
}
