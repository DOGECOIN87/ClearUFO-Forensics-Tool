// Source dispatcher: picks the right demuxer/decoder for the files given by the user.
import { BRAND } from "../../brand";
import type { DvrScanResult, FrameMeta, SourceInfo, SourceKind } from "../../shared/types";
import { fromRGBA8, type Frame } from "../frame";
import { decodeMjpeg, FrameListSource, openAvi } from "./avi";
import { convertDvr, type DvrOptions } from "./dvr";
import { openImage, SequenceSource, sniffImage } from "./image";
import { MediabunnySource } from "./mbsource";
import { applyHdr } from "./hdr";
import { baseInfo, decodeKey, fmtBytes, SourceFrameCache, type DecodeOpts, type SourceProvider } from "./types";
import { resolveYuv, yuvToFrame, yuvToFrameP, type Siting } from "./yuv";

export type Progress = (label: string, v: number) => void;
const asc = (d: Uint8Array, o: number, n: number) => String.fromCharCode(...d.subarray(o, o + n));
const baseName = (n: string) => n.replace(/\.[^.]+$/, "");

export async function openDvr(id: string, file: File, opts: DvrOptions, progress: Progress): Promise<{ provider: SourceProvider; scan: DvrScanResult }> {
  if (file.size > 1.8e9) throw new Error("File too large for in-browser conversion (limit 1.8 GB)");
  progress("Reading file", 0);
  const data = new Uint8Array(await file.arrayBuffer());
  const r = await convertDvr(data, opts, progress);
  if (r.mjpegFrames) {
    const frames = r.mjpegFrames;
    const first = await decodeMjpeg(frames[0]);
    const info = baseInfo(id, file.name, "dvr");
    Object.assign(info, { width: first.w, height: first.h, frameCount: frames.length, fps: r.scan.fps, duration: frames.length / r.scan.fps, fileSize: file.size, container: r.scan.container, codec: "MJPEG", engine: "Convert DVR + native JPEG decoder", videoStreams: 1, frameTypesReady: true });
    info.metadata = [["Container", r.scan.container], ...r.scan.notes.map((n) => ["Conversion", n] as [string, string]), ["Size", fmtBytes(file.size)]];
    const provider = new FrameListSource(id, info, async (rg) => frames[rg.off], frames.map((f, i) => ({ off: i, size: f.length, key: true })), decodeMjpeg);
    return { provider, scan: r.scan };
  }
  const provider = await MediabunnySource.open(id, r.mp4!, file.name, {
    kind: "dvr",
    fileSize: file.size,
    containerLabel: `${r.scan.container} → MP4 (lossless remux)`,
    types: r.types,
    converted: { name: `${baseName(file.name)}_converted.mp4`, buffer: r.mp4! },
    extraMeta: [["Original Container", r.scan.container], ["NAL Units", String(r.scan.nalCount)], ...r.scan.notes.map((n) => ["Conversion", n] as [string, string])],
  });
  provider.info.engine = "Convert DVR (stream copy) + WebCodecs";
  return { provider, scan: r.scan };
}

export async function openSource(id: string, files: File[], kind: SourceKind | "auto", options: Record<string, any>, progress: Progress): Promise<SourceProvider> {
  if (!files.length) throw new Error("No file");
  if (kind === "sequence" || files.length > 1) return SequenceSource.open(id, files, options.fps || 25);
  const file = files[0];
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  if (kind === "dvr") return (await openDvr(id, file, { codec: options.codec ?? "auto", fps: options.fps ?? 0, container: options.container ?? "auto" }, progress)).provider;
  if (kind === "image" || sniffImage(head)) return openImage(id, file);
  if (asc(head, 0, 4) === "RIFF" && asc(head, 8, 4) === "AVI ") {
    const r = await openAvi(id, file);
    if (r.kind === "frames") return r.provider;
    progress("Remuxing AVI bitstream", 0.1);
    const conv = await convertDvr(r.es, { codec: r.codec, fps: r.fps, container: "raw" }, progress);
    return MediabunnySource.open(id, conv.mp4!, file.name, {
      kind: "video", fileSize: file.size, containerLabel: `AVI (${r.codec.toUpperCase()}) → MP4 (lossless remux)`, types: conv.types,
      extraMeta: [["Stream Handler", r.parse.fourcc], ["Compression", r.parse.compression], ...conv.scan.notes.map((n) => ["Conversion", n] as [string, string])],
    });
  }
  let mbError: unknown = null;
  try { return await MediabunnySource.open(id, file, file.name, { fileSize: file.size }); } catch (e) { mbError = e; }
  try {
    const r = await openDvr(id, file, { codec: "auto", fps: 0, container: "auto" }, progress);
    r.provider.info.warnings.push(`Standard demuxing failed (${(mbError as Error)?.message}); the file was converted with Convert DVR.`);
    return r.provider;
  } catch (e2) {
    throw new Error(`${(mbError as Error)?.message ?? "Unsupported format"}. Convert DVR: ${(e2 as Error).message}`);
  }
}

/** A frame grabbed from a media element: the decoded planes when the browser exposes them, else canvas RGBA. */
export interface GrabbedFrame {
  w: number; h: number;
  data?: Uint8ClampedArray;
  yuv?: { buf: Uint8Array; layout: { offset: number; stride: number }[]; format: string; matrix: string | null; fullRange: boolean | null };
}

/** Decoding through an HTMLVideoElement on the main thread (fallback engine). */
export class MediaElementSource implements SourceProvider {
  info: SourceInfo;
  private cache = new SourceFrameCache(128 * 1024 * 1024);
  private reported = "";
  constructor(public id: string, meta: { width: number; height: number; duration: number }, private base: SourceProvider | undefined, private grab: (time: number) => Promise<GrabbedFrame>,
    private onInfo?: (patch: Partial<SourceInfo>) => void) {
    const fps = base?.info.fps || 25;
    this.info = { ...(base?.info ?? baseInfo(id, id, "video")), width: meta.width, height: meta.height, engine: "Browser media element (seek based, approximate)",
      conversion: "Browser: media element frames drawn through a canvas (the Video Loader Color Matrix, Range and Chroma Filter do not apply)", browserConversion: true };
    if (!base) { this.info.fps = fps; this.info.frameCount = Math.max(1, Math.round(meta.duration * fps)); this.info.duration = meta.duration; }
    this.info.warnings = [...(this.info.warnings ?? []), "Media element decoding is time based: frame accuracy depends on the browser."];
  }
  async getFrame(i: number, opts?: DecodeOpts): Promise<Frame> {
    i = Math.max(0, Math.min(this.info.frameCount - 1, i | 0));
    const ck = `${i}|${decodeKey(opts)}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;
    const pts = this.base?.table?.pts[i];
    const t = (pts !== undefined ? pts - (this.base!.table!.pts[0] || 0) : i / this.info.fps) + 0.5 / this.info.fps;
    const r = await this.grab(t);
    let f: Frame;
    if (r.yuv) {
      // exact samples from the decoder: same conversion (and loader settings) as the WebCodecs engine
      const cs = { matrix: r.yuv.matrix, fullRange: r.yuv.fullRange, siting: (this.base?.info.chromaSiting as Siting | undefined) ?? null };
      f = applyHdr(await yuvToFrameP(r.yuv.buf, r.yuv.layout, r.yuv.format, r.w, r.h, resolveYuv(opts, cs, r.h)), this.info, opts);
      this.report(`${BRAND.name}, from the ${r.yuv.format} planes of the media element frames (Color Matrix, Range and Chroma Filter of the Video Loader)`, false);
    } else {
      f = fromRGBA8(r.data!, r.w, r.h);
      this.report("Browser: media element frames drawn through a canvas (the Video Loader Color Matrix, Range and Chroma Filter do not apply)", true);
    }
    this.cache.set(ck, f);
    return f;
  }
  /** Tell File Info and the report how the frames were really converted (known after the first frame). */
  private report(conversion: string, browserConversion: boolean) {
    if (this.reported === conversion) return;
    this.reported = conversion;
    Object.assign(this.info, { conversion, browserConversion });
    this.onInfo?.({ conversion, browserConversion });
  }
  meta(i: number): FrameMeta { return this.base ? this.base.meta(i) : { type: "?", pts: i / this.info.fps, src: i }; }
  dispose() { this.cache.clear(); }
}
