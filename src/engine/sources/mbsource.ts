// Video source backed by Mediabunny (MP4, MOV, WebM, MKV, MPEG-TS, Ogg …) + WebCodecs.
// Frames are indexed in presentation order from the real packet timestamps, so frame
// numbers are exact (no time-based approximation), and a decoding cursor makes
// sequential access (playback, stepping) cheap.
import { ALL_FORMATS, BlobSource, BufferSource, EncodedPacketSink, Input, VideoSampleSink, type InputVideoTrack, type VideoSample } from "mediabunny";
import { BRAND } from "../../brand";
import type { FrameMeta, SourceInfo, SourceKind } from "../../shared/types";
import { fromRGBA8, type Frame } from "../frame";
import { FRAME_TYPE_CODE, FRAME_TYPE_FROM_CODE, frameTypeOf, makeFrameTypeContext, type H264Sps } from "./bitstream";
import { baseInfo, decodeKey, emptyTable, fmtBytes, Mutex, SourceFrameCache, type DecodeOpts, type SourceProvider } from "./types";
import { applyHdr } from "./hdr";
import { qualityNotes } from "./quality";
import { autoMatrix, MATRIX_LABEL, resolveYuv, rgbxToFrame, RGB_FORMATS, SITING_FROM_LOC, SITING_LABEL, YUV_FORMATS, yuvToFrame, yuvToFrameP, type Siting, type StreamColor } from "./yuv";

type HwPref = "prefer-software" | "no-preference";

/** The stream ended before the requested frame (not a decoder failure). */
class FrameMissing extends Error {}

/**
 * Software decoders hand out the decoded planes in CPU memory at full bit depth (exact YUV samples, our own
 * conversion) and conceal damaged CCTV streams the same way everywhere. Hardware decoders may only produce
 * GPU frames that the browser converts to 8-bit RGB. So software is preferred whenever the browser has one
 * for the codec (Chrome has none for HEVC, for example: then the browser chooses).
 */
async function softwareDecoding(track: InputVideoTrack): Promise<boolean> {
  try {
    if (typeof VideoDecoder === "undefined") return false;
    const cfg = await track.getDecoderConfig();
    if (!cfg) return false;
    const r = await VideoDecoder.isConfigSupported({ ...cfg, hardwareAcceleration: "prefer-software" });
    return !!r.supported;
  } catch { return false; }
}

const bytesOf = (d: AllowSharedBufferSource | undefined): Uint8Array | null =>
  !d ? null : d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) : null;

/**
 * Chroma siting explicitly signaled by the stream: H.264 SPS VUI (chroma_loc_info_present_flag) or AV1 av1C
 * (chroma_sample_position, 0 = unknown). Not the long VP9 codec string: its chroma field defaults to "01"
 * (co-sited) when the file says nothing, so a default cannot be told from a signaled value.
 */
function signaledSiting(codec: string, desc: Uint8Array | null, sps: { chromaLoc?: number } | undefined): { siting: Siting; where: string } | null {
  if (codec === "avc" && sps?.chromaLoc !== undefined) return { siting: SITING_FROM_LOC[sps.chromaLoc], where: "H.264 SPS (VUI)" };
  if (codec === "av1" && desc && desc.length >= 4 && (desc[0] & 0x80)) {
    const pos = desc[2] & 3; // chroma_sample_position: 1 vertical (= left), 2 colocated (= top-left)
    if (pos === 1) return { siting: "left", where: "AV1 configuration (av1C)" };
    if (pos === 2) return { siting: "topleft", where: "AV1 configuration (av1C)" };
  }
  return null;
}

export interface MbOpenOptions {
  kind?: SourceKind;
  fileSize?: number;
  containerLabel?: string;
  extraMeta?: [string, string][];
  /** Frame types already known (e.g. from DVR conversion). */
  types?: Uint8Array;
  converted?: { name: string; buffer: ArrayBuffer };
  warnings?: string[];
}

export class MediabunnySource implements SourceProvider {
  info: SourceInfo;
  table;
  converted?: { name: string; buffer: ArrayBuffer };
  private sink: VideoSampleSink;
  private iter: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private iterPos = -1; // presentation index of the next sample the iterator yields
  private mutex = new Mutex();
  private cache = new SourceFrameCache(192 * 1024 * 1024);
  decodable = true;
  /** How the last decoded frame was turned into RGB: own conversion of the YUV planes, RGB frames from the browser, or canvas drawing. */
  lastPath?: { kind: "yuv" | "rgb" | "canvas"; format: string | null };
  private analyzing: Promise<void> | null = null;
  private colorSpace: StreamColor | undefined;

  private constructor(public id: string, private input: Input, private track: InputVideoTrack, info: SourceInfo, private pts: Float64Array, private hw: HwPref) {
    this.info = info;
    this.table = emptyTable(id, pts.length);
    this.table.pts.set(pts);
    this.sink = this.makeSink();
    info.decoder = hw === "prefer-software" ? "software" : "default";
  }

  private makeSink() { return new VideoSampleSink(this.track, { optimizeForLatency: true, hardwareAcceleration: this.hw }); }

  static async open(id: string, data: Blob | ArrayBuffer, name: string, opts: MbOpenOptions = {}): Promise<MediabunnySource> {
    const input = new Input({ source: data instanceof Blob ? new BlobSource(data) : new BufferSource(data), formats: ALL_FORMATS });
    if (!(await input.canRead())) throw new Error("Unrecognized container format");
    const format = await input.getFormat();
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("The file does not contain a video track");
    const codec = (await track.getCodec()) ?? "unknown";
    const info = baseInfo(id, name, opts.kind ?? "video");
    info.fileSize = opts.fileSize ?? (data instanceof Blob ? data.size : data.byteLength);
    info.container = opts.containerLabel ?? format.name;
    info.codec = codec;
    info.engine = "WebCodecs (Mediabunny demuxer)";
    info.warnings = [...(opts.warnings ?? [])];
    try { info.mime = await input.getMimeType(); } catch { /* optional */ }
    try { info.codecString = (await track.getCodecParameterString()) ?? undefined; } catch { /* optional */ }

    // ---- frame table (presentation order)
    const pk = new EncodedPacketSink(track);
    const list: { ts: number; key: boolean; bytes: number }[] = [];
    for await (const p of pk.packets(undefined, undefined, { metadataOnly: true })) list.push({ ts: p.timestamp, key: p.type === "key", bytes: p.byteLength });
    if (!list.length) throw new Error("The video track has no frames");
    list.sort((a, b) => a.ts - b.ts);
    const pts = Float64Array.from(list, (e) => e.ts);
    const src = new MediabunnySource(id, input, track, info, pts, (await softwareDecoding(track)) ? "prefer-software" : "no-preference");
    list.forEach((e, i) => { src.table.bytes[i] = e.bytes; if (e.key) src.table.types[i] = FRAME_TYPE_CODE.I; });
    if (opts.types && opts.types.length === list.length) { src.table.types.set(opts.types); src.table.ready = true; info.frameTypesReady = true; }
    src.converted = opts.converted;

    info.frameCount = list.length;
    let duration = 0;
    try { duration = await track.computeDuration(); } catch { duration = pts[pts.length - 1] - pts[0]; }
    info.duration = duration;
    try {
      const m = await track.computeFrameRateMetrics();
      info.fps = m.bestGuessFrameRate || list.length / Math.max(duration, 1e-3);
      info.vfr = { min: m.minFrameRate, max: m.maxFrameRate, avg: m.averageFrameRate, variable: !m.frameRateIsConstant };
    } catch { info.fps = list.length / Math.max(duration, 1e-3); }
    if (!isFinite(info.fps) || info.fps <= 0) info.fps = 25;

    info.width = await track.getCodedWidth();
    info.height = await track.getCodedHeight();
    try { const par = await track.getPixelAspectRatio(); info.par = [par.num, par.den]; } catch { /* default */ }
    try { info.rotation = await track.getRotation(); } catch { /* none */ }
    // Color matrix/range: only explicit metadata (container or H.264 SPS VUI) is trusted;
    // otherwise the documented convention applies (BT.601 for SD, BT.709 for HD, limited range).
    let matrixSrc = "container", sitingSrc = "";
    try {
      const cs = await track.getColorSpace();
      let matrix: string | null = cs.matrix ?? null, full = cs.fullRange ?? null; // ("bt2020-ncl" is missing from the DOM typings)
      let desc: Uint8Array | null = null;
      try { desc = bytesOf((await track.getDecoderConfig())?.description); } catch { /* no description */ }
      let sps: H264Sps | undefined;
      if (codec === "avc" && desc) { try { sps = makeFrameTypeContext("avc", desc).h264Sps.values().next().value; } catch { /* unparsable SPS */ } }
      if (sps) {
        if (!matrix && sps.matrix !== undefined) { matrix = sps.matrix === 1 ? "bt709" : sps.matrix === 5 ? "bt470bg" : sps.matrix === 6 ? "smpte170m" : sps.matrix === 9 ? "bt2020-ncl" : null; if (matrix) matrixSrc = "H.264 SPS (VUI)"; }
        if (full === null && sps.fullRange !== undefined) full = sps.fullRange;
      }
      const sit = signaledSiting(codec, desc, sps);
      if (sit) sitingSrc = sit.where;
      info.chromaSiting = sit?.siting;
      src.colorSpace = { matrix, fullRange: full, siting: sit?.siting ?? null };
      info.colorMatrix = matrix ?? undefined;
      info.colorPrimaries = cs.primaries ?? undefined;
      info.transfer = cs.transfer ?? undefined;
      info.colorRange = full === true ? "Full" : full === false ? "Limited" : undefined;
      if (!matrix) matrixSrc = "";
    } catch { matrixSrc = ""; }
    try { const st = await track.computePacketStats(); info.bitrate = st.averageBitrate; } catch { /* optional */ }

    const videoTracks = await input.getVideoTracks();
    const audioTracks = await input.getAudioTracks();
    info.videoStreams = videoTracks.length;
    info.audioStreams = audioTracks.length;
    try { info.subtitleStreams = (await input.getTracks()).filter((t) => t.type === "subtitle").length; } catch { /* none */ }
    const at = await input.getPrimaryAudioTrack();
    if (at) {
      info.hasAudio = true;
      info.audio = { codec: (await at.getCodec()) ?? "unknown", sampleRate: await at.getSampleRate(), channels: await at.getNumberOfChannels() };
    }

    try { src.decodable = await track.canDecode(); } catch { src.decodable = false; }
    if (!src.decodable) info.warnings.push(`The ${codec.toUpperCase()} codec cannot be decoded through WebCodecs in this browser: the browser media element is used instead (time based seeking).`);

    // exact visible size from the first decoded frame
    if (src.decodable) {
      const cw = info.width, ch = info.height;
      info.width = 0; info.height = 0; // let the first frame define the visible size
      try {
        const f = await src.getFrame(0);
        info.width = f.w;
        info.height = f.h;
      } catch (e) {
        info.width = cw; info.height = ch;
        src.decodable = false;
        info.warnings.push(`Decoding failed: ${(e as Error).message}`);
      }
    }

    // ---- metadata list for the File Info tool
    const md: [string, string][] = [];
    md.push(["Container", info.container ?? ""]);
    if (info.mime) md.push(["MIME Type", info.mime]);
    md.push(["Codec", `${codec}${info.codecString ? ` (${info.codecString})` : ""}`]);
    const keyCount = list.filter((e) => e.key).length;
    md.push(["Key Frames", `${keyCount} (average GOP ${(list.length / Math.max(1, keyCount)).toFixed(1)} frames)`]);
    if (info.vfr) md.push(["Frame Rate (min/avg/max)", `${info.vfr.min.toFixed(3)} / ${info.vfr.avg.toFixed(3)} / ${info.vfr.max.toFixed(3)}${info.vfr.variable ? "  — VARIABLE" : "  — constant"}`]);
    md.push(["First Timestamp", `${pts[0].toFixed(6)} s`]);
    if (info.bitrate) md.push(["Average Bitrate", `${(info.bitrate / 1000).toFixed(0)} kb/s`]);
    {
      const m = src.colorSpace?.matrix, h = info.height;
      const name = MATRIX_LABEL[autoMatrix(m, h)];
      const known = m === "bt709" || m === "bt470bg" || m === "smpte170m" || m === "bt2020-ncl";
      const range = src.colorSpace?.fullRange === true ? "full range" : "limited range";
      const why = matrixSrc && known ? `signaled in ${matrixSrc}` : m ? `signaled as "${m}", which is not supported: ${h >= 720 ? "HD" : "SD"} default` : `not signaled: ${h >= 720 ? "HD" : "SD"} default`;
      const auto = `${name}, ${range} — ${why}`;
      const sit = src.colorSpace?.siting ?? "left";
      // Who converts YUV to RGB depends on the browser: some decoders hand out the YUV planes (converted
      // here, exactly and with the loader settings), others only RGB frames converted by the browser.
      const lp = src.decodable ? src.lastPath : undefined;
      info.browserConversion = !lp || lp.kind !== "yuv";
      const na = "the Video Loader Color Matrix, Range and Chroma Filter do not apply";
      info.conversion = lp?.kind === "yuv" ? `${BRAND.name}, from the ${lp.format} planes of the decoder (Color Matrix, Range and Chroma Filter of the Video Loader; automatic: ${name}, ${range}, ${sit} chroma siting)`
        : lp?.kind === "rgb" ? `Browser: its decoder delivers ${lp.format} frames already converted to RGB (${na})`
        : lp ? `Browser: frames drawn through a canvas${lp.format ? ` (${lp.format})` : ""} (${na})`
        : `Browser: media element frames drawn through a canvas (${na})`;
      if (info.browserConversion) md.push(["YUV to RGB", `by the browser; signaled/default: ${auto}`]);
      else {
        md.push(["YUV to RGB (auto)", auto]);
        md.push(["Chroma Siting (auto)", `${SITING_LABEL[sit]} — ${sitingSrc ? `signaled in ${sitingSrc}` : "not signaled: MPEG default"}`]);
      }
      if (src.decodable) md.push(["Decoder", info.decoder === "software" ? "WebCodecs software decoder (exact decoded planes, full bit depth)" : "WebCodecs, chosen by the browser (no software decoder for this codec: may be hardware)"]);
      if (info.transfer === "pq" || info.transfer === "hlg")
        md.push(["HDR", `${info.transfer === "pq" ? "PQ (SMPTE ST 2084)" : "HLG (ARIB STD-B67)"} transfer, ${info.colorPrimaries ?? "unknown"} primaries: ${info.browserConversion ? "converted by the browser (its own HDR handling applies)" : "tone mapped to SDR BT.709 unless Video Loader › HDR Video says otherwise"}`]);
    }
    if (info.rotation) md.push(["Rotation Metadata", `${info.rotation}° (not applied — frames are shown as stored)`]);
    try {
      const tags = await input.getMetadataTags();
      for (const k of ["title", "description", "artist", "comment", "genre"] as const) if (tags[k]) md.push([`Tag: ${k}`, String(tags[k])]);
      if (tags.date) md.push(["Tag: date", tags.date.toISOString()]);
      if (tags.raw) for (const [k, v] of Object.entries(tags.raw).slice(0, 30)) if (typeof v === "string") md.push([`Tag: ${k}`, v]);
    } catch { /* optional */ }
    md.push(...(opts.extraMeta ?? []));
    md.push(["Size", fmtBytes(info.fileSize)]);
    const notes = qualityNotes(info);
    notes.forEach((q, i) => md.push([i ? "" : "Quality Check", q.text]));
    for (const q of notes) if (q.level === "warn") info.warnings.push(q.text);
    info.metadata = md;
    return src;
  }

  meta(i: number): FrameMeta {
    const t = this.table;
    return { type: FRAME_TYPE_FROM_CODE[t.types[i]] ?? "?", pts: t.pts[i], key: t.types[i] === 1, bytes: t.bytes[i], src: i };
  }

  private indexOf(ts: number): number {
    const p = this.pts;
    let lo = 0, hi = p.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (p[mid] <= ts + 1e-7) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  private async closeIter() {
    const it = this.iter;
    this.iter = null;
    this.iterPos = -1;
    if (it) { try { await it.return(undefined); } catch { /* ignore */ } }
  }

  getFrame(i: number, opts?: DecodeOpts): Promise<Frame> {
    if (!this.decodable && this.info.width) return Promise.reject(new Error(this.info.warnings[this.info.warnings.length - 1] || "Codec not supported"));
    i = Math.max(0, Math.min(this.pts.length - 1, i | 0));
    const dk = decodeKey(opts), ck = `${i}|${dk}`;
    const hit = this.cache.get(ck);
    if (hit) return Promise.resolve(hit);
    return this.mutex.run(async () => {
      const again = this.cache.get(ck);
      if (again) return again;
      try { return await this.decodeAt(i, opts, dk); }
      catch (e) {
        if (this.hw !== "prefer-software" || e instanceof FrameMissing) throw e;
        // the software decoder rejected this stream: let the browser choose its decoder and retry once
        this.hw = "no-preference";
        this.info.decoder = "default";
        this.info.warnings.push(`The software decoder failed (${(e as Error).message}); the browser's default decoder is used instead.`);
        await this.closeIter();
        this.sink = this.makeSink();
        return await this.decodeAt(i, opts, dk);
      }
    });
  }

  private async decodeAt(i: number, opts: DecodeOpts | undefined, dk: string): Promise<Frame> {
    const backward = this.iter !== null && i < this.iterPos;
    if (!this.iter || i < this.iterPos || i - this.iterPos > 60) {
      await this.closeIter();
      // when stepping backwards, also convert a few frames before the target so further steps are instant
      const start = backward ? Math.max(0, i - 10) : i;
      this.iter = this.sink.samples(this.pts[start]);
      this.iterPos = start;
    }
    for (;;) {
      let r: IteratorResult<VideoSample, void>;
      try { r = await this.iter!.next(); }
      catch (e) { await this.closeIter(); throw e; }
      if (r.done || !r.value) { await this.closeIter(); throw new FrameMissing(`Frame ${i} could not be decoded`); }
      const sample = r.value;
      const idx = this.indexOf(sample.timestamp);
      this.iterPos = idx + 1;
      try {
        if (idx >= i) {
          const f = await this.convert(sample, opts);
          this.cache.set(`${idx}|${dk}`, f);
          return f;
        }
        if (i - idx <= 10) this.cache.set(`${idx}|${dk}`, await this.convert(sample, opts));
      } finally { sample.close(); }
    }
  }

  private async convert(sample: VideoSample, opts?: DecodeOpts): Promise<Frame> {
    const vr = sample.visibleRect;
    const w = Math.round(vr.width), h = Math.round(vr.height);
    const fmt = sample.format;
    if (fmt && (YUV_FORMATS.has(fmt) || RGB_FORMATS.has(fmt))) {
      try {
        const buf = new Uint8Array(sample.allocationSize());
        const layout = await sample.copyTo(buf);
        let f: Frame;
        if (RGB_FORMATS.has(fmt)) f = rgbxToFrame(buf, layout, fmt, w, h);
        else f = applyHdr(await yuvToFrameP(buf, layout, fmt, w, h, resolveYuv(opts, this.colorSpace, h)), this.info, opts);
        this.lastPath = { kind: RGB_FORMATS.has(fmt) ? "rgb" : "yuv", format: fmt };
        return this.fit(f);
      } catch { /* fall back to canvas conversion */ }
    }
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const vf = sample.toVideoFrame();
    try { ctx.drawImage(vf, 0, 0, w, h); } finally { vf.close(); }
    this.lastPath = { kind: "canvas", format: fmt ?? null };
    return this.fit(fromRGBA8(ctx.getImageData(0, 0, w, h).data, w, h));
  }

  /** Keep the stream size constant even if a frame reports a different visible size. */
  private fit(f: Frame): Frame {
    const W = this.info.width, H = this.info.height;
    if (!W || !H || (f.w === W && f.h === H)) return f;
    if (this.info.frameCount && f.w && f.h && this.info.width === 0) return f;
    const out = new Float32Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = Math.min(f.w - 1, x), sy = Math.min(f.h - 1, y);
      const s = (sy * f.w + sx) * 4, o = (y * W + x) * 4;
      out[o] = f.d[s]; out[o + 1] = f.d[s + 1]; out[o + 2] = f.d[s + 2]; out[o + 3] = 255;
    }
    return { w: W, h: H, d: out };
  }

  analyze(onProgress: (v: number) => void): Promise<void> {
    if (this.table.ready) return Promise.resolve();
    if (this.analyzing) return this.analyzing;
    this.analyzing = (async () => {
      const codec = this.info.codec ?? "";
      const n = this.pts.length;
      if (codec !== "avc" && codec !== "hevc") {
        // key / delta only (VP8/VP9/AV1): delta frames are predicted (P)
        for (let i = 0; i < n; i++) if (!this.table.types[i]) this.table.types[i] = FRAME_TYPE_CODE.P;
      } else {
        const cfg = await this.track.getDecoderConfig();
        const desc = cfg?.description ? new Uint8Array(cfg.description instanceof ArrayBuffer ? cfg.description : (cfg.description as ArrayBufferView).buffer.slice((cfg.description as ArrayBufferView).byteOffset, (cfg.description as ArrayBufferView).byteOffset + (cfg.description as ArrayBufferView).byteLength)) : null;
        const ctx = makeFrameTypeContext(codec, desc);
        const sink = new EncodedPacketSink(this.track);
        let k = 0;
        for await (const p of sink.packets()) {
          const idx = this.indexOf(p.timestamp);
          const t = frameTypeOf(p.data, ctx);
          this.table.types[idx] = t === "?" ? (p.type === "key" ? FRAME_TYPE_CODE.I : FRAME_TYPE_CODE.P) : FRAME_TYPE_CODE[t];
          this.table.bytes[idx] = p.byteLength;
          if (++k % 250 === 0) onProgress(k / n);
        }
      }
      this.table.ready = true;
      this.info.frameTypesReady = true;
      const counts = [0, 0, 0, 0];
      for (let i = 0; i < n; i++) counts[this.table.types[i]]++;
      this.info.metadata.push(["Frame Types", `I: ${counts[1]}, P: ${counts[2]}, B: ${counts[3]}`]);
      onProgress(1);
    })();
    return this.analyzing;
  }

  dispose() {
    void this.closeIter();
    this.cache.clear();
    try { this.input.dispose(); } catch { /* ignore */ }
  }
}
