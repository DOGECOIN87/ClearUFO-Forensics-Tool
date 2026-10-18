// Lossless video capture (camera or screen). MediaRecorder only offers lossy codecs, so every frame of
// the live stream is grabbed instead and stored uncompressed (AVI, RGB 8 bits per channel), exactly as
// the browser delivers it: frames are drawn 1:1, never scaled.
//
// Frames come from MediaStreamTrackProcessor where available (Chromium: every frame, even while the
// window is covered), otherwise from requestVideoFrameCallback (Firefox, Safari) or animation frames.
// Chrome and Edge on computers stream the recording straight to a file the user picks. Other browsers
// stream it to disk in the browser's storage (staging, see staging.ts) and download it when it stops, up
// to the site's storage quota; without that storage the recording is kept in memory and stops
// automatically at a safe size.
import { AviWriter } from "../shared/codecs/avi";
import { dib24FromRGBA } from "../shared/codecs/image";
import { BlobSink, FileSink, RemoteSink, type ByteSink } from "../shared/codecs/sink";
import { dialog, progressDialog, toast } from "../ui/dialog";
import { download, fmtBytes, fmtTime, h } from "../ui/dom";
import type { Staging } from "./staging";

export interface CaptureHost {
  canSaveToDisk(): boolean;
  pickSaveFile(name: string, mime: string, ext: string, description: string): Promise<FileSystemFileHandle | null | undefined>;
  loadFile(file: File): Promise<void>;
  /** Staging on disk in the browser's storage, for browsers that cannot write to a picked file. */
  staging?: Staging;
}

/** Bytes a recording staged in the browser's storage may use (room reported by the browser). */
export function captureStagingLimit(room: number | null): number {
  return room !== null ? Math.max(0, room - 64 * 1048576) : 2 * 1073741824;
}

type Target = { kind: "picker" } | { kind: "staging"; room: number | null } | { kind: "memory" } | { kind: "pending" };

const STD_FPS = [5, 7.5, 10, 12, 12.5, 15, 20, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];

/** Measured frame rate, snapped to the nearest standard rate when within 1%. */
export function snapFps(f: number): number {
  if (!(f > 0) || !Number.isFinite(f)) return 30;
  let best = 30, err = Infinity;
  for (const s of STD_FPS) { const e = Math.abs(f - s) / s; if (e < err) { err = e; best = s; } }
  return err < 0.01 ? best : Math.round(f * 1000) / 1000;
}

/** Bytes a recording may use when it has to be kept in memory. */
export function captureMemoryLimit(): number {
  const dm = (navigator as { deviceMemory?: number }).deviceMemory;
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const chromium = !!(navigator as { userAgentData?: unknown }).userAgentData; // pages Blob data out to disk
  const gb = coarse ? 0.4 : chromium ? 2 : 1;
  return (dm ? Math.min(gb, dm / 4) : gb) * 1073741824;
}

interface FrameSource { close(): void }

export async function captureLossless(host: CaptureHost, stream: MediaStream): Promise<void> {
  const track = stream.getVideoTracks()[0];
  const video = h("video", { autoplay: true, muted: true, playsinline: true, style: { width: "100%", maxHeight: "50vh", background: "#000", display: "block" } }) as HTMLVideoElement;
  video.srcObject = stream;
  void video.play().catch(() => { /* autoplay of a muted stream is allowed */ });
  const status = h("div", { class: "muted small capture-status" }, "Preview. Press Start Recording when ready.");
  const note = h("div", { class: "export-note" });

  let state: "preview" | "recording" | "done" = "preview";
  // where the recording goes: decided before it starts (the note tells the user)
  let target: Target = host.canSaveToDisk() ? { kind: "picker" } : host.staging ? { kind: "pending" } : { kind: "memory" };
  const resolveTarget = async () => {
    const st = await host.staging?.status().catch(() => null);
    // staging only when it allows a longer recording than memory (private windows have little storage)
    target = st?.ok && (st.room === null || captureStagingLimit(st.room) > captureMemoryLimit()) ? { kind: "staging", room: st.room } : { kind: "memory" };
  };
  let sink: ByteSink | null = null, handle: FileSystemFileHandle | null = null, avi: AviWriter | null = null;
  let w = 0, ht = 0, frames = 0, skipped = 0, pending = 0, t0 = 0, t1 = 0, sizeChanged = false, limit = Infinity, recStart = 0, hitLimit = false;
  let failure: Error | null = null, queue: Promise<void> = Promise.resolve(), source: FrameSource | null = null;
  let ctx2d: CanvasRenderingContext2D | null = null, timer = 0;
  const name = `Capture ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.avi`;

  const nominalFps = () => track?.getSettings?.().frameRate || 30;
  const describe = () => {
    const vw = video.videoWidth, vh = video.videoHeight, fps = nominalFps();
    const per = vw ? AviWriter.rawFrameBytes(vw, vh) : 0;
    const span = (bytes: number) => `${fmtBytes(bytes)}${per ? ` (about ${fmtTime(bytes / (per * fps))})` : ""}`;
    const t = target;
    note.replaceChildren(
      h("b", null, "Lossless: "),
      `every frame is stored uncompressed (AVI, RGB 8 bits per channel)${vw ? `: ${vw}×${vh}, ${fmtBytes(per)} per frame, about ${fmtBytes(per * fps)} per second at ${Math.round(fps)} fps` : ""}. Audio is not recorded.`,
      h("br"),
      t.kind === "picker" ? "You choose where to save; frames are written straight to disk, so the length is limited only by the disk."
        : t.kind === "staging" ? `Frames are written to disk in the browser's storage (not memory), with room for ${span(captureStagingLimit(t.room))}. When you stop, the recording is downloaded and loaded as a new chain.`
        : t.kind === "pending" ? "Checking where the recording can be stored…"
        : `This browser keeps the recording in memory: it stops automatically at ${span(captureMemoryLimit())}. When you stop, the recording is downloaded and loaded as a new chain.`);
  };
  video.addEventListener("loadedmetadata", describe);
  video.addEventListener("resize", describe);
  describe();
  if (target.kind === "pending") void resolveTarget().then(describe);

  /**
   * Stores one frame: a decoded image to draw, or RGBA pixels already read from a VideoFrame (no canvas:
   * exact, and immune to fingerprinting protections that perturb canvas readback). `t` is its capture
   * time in seconds.
   */
  const grab = (img: CanvasImageSource | Uint8Array, iw: number, ih: number, t: number) => {
    if (state !== "recording" || failure || !iw || !ih || !sink) return;
    if (!avi) {
      w = iw; ht = ih;
      avi = new AviWriter(sink, { width: w, height: ht, fps: nominalFps(), codec: "raw24" });
      t0 = t;
    }
    if (pending > 24) { skipped++; return; } // the disk cannot keep up: skip rather than exhaust memory
    let rgba: Uint8Array | Uint8ClampedArray;
    if (img instanceof Uint8Array && iw === w && ih === ht) rgba = img;
    else {
      if (!ctx2d) {
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = ht;
        ctx2d = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
      }
      const c = ctx2d!;
      // 1:1: larger frames are cropped, smaller ones padded with black, never scaled
      if (iw !== w || ih !== ht) { sizeChanged = true; c.fillStyle = "#000"; c.fillRect(0, 0, w, ht); }
      if (img instanceof Uint8Array) c.putImageData(new ImageData(new Uint8ClampedArray(img.buffer as ArrayBuffer, img.byteOffset, img.byteLength), iw, ih), 0, 0);
      else c.drawImage(img, 0, 0);
      rgba = c.getImageData(0, 0, w, ht).data;
    }
    const dib = dib24FromRGBA(rgba, w, ht);
    frames++; t1 = t; pending++;
    const writer = avi;
    queue = queue.then(() => writer.add(dib)).then(() => { pending--; }, (e) => { failure = e as Error; });
    if (sink.pos + (pending + 1) * (dib.length + 8) > limit) { hitLimit = true; d.close(); }
  };

  /** RGBA pixels of a VideoFrame converted by the browser (WebCodecs), or null where it cannot convert. */
  let rgbaCopy: boolean | null = null;
  const frameRGBA = async (vf: VideoFrame): Promise<Uint8Array | null> => {
    const r = vf.visibleRect;
    // frames with non-square pixels are drawn at their display size by the canvas path
    if (rgbaCopy === false || !r || r.width !== vf.displayWidth || r.height !== vf.displayHeight) return null;
    try {
      const buf = new Uint8Array(r.width * r.height * 4);
      await vf.copyTo(buf, { format: "RGBA", colorSpace: "srgb", layout: [{ offset: 0, stride: r.width * 4 }] } as VideoFrameCopyToOptions);
      rgbaCopy = true;
      return buf;
    } catch { rgbaCopy = false; return null; }
  };

  const startSource = (): FrameSource => {
    const MSTP = (globalThis as { MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor;
    if (MSTP && track) {
      const reader = new MSTP({ track }).readable.getReader();
      let open = true;
      void (async () => {
        while (open && state === "recording") {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done || !value) break;
          try {
            const rgba = await frameRGBA(value);
            if (rgba) grab(rgba, value.displayWidth, value.displayHeight, value.timestamp / 1e6);
            else grab(value, value.displayWidth, value.displayHeight, value.timestamp / 1e6);
          } finally { value.close(); }
        }
      })();
      return { close: () => { open = false; void reader.cancel().catch(() => {}); } };
    }
    let open = true;
    if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
      let last = -1;
      const cb = (now: number, meta: VideoFrameCallbackMetadata) => {
        if (!open) return;
        if (last >= 0 && meta.presentedFrames > last + 1) skipped += meta.presentedFrames - last - 1;
        last = meta.presentedFrames;
        grab(video, video.videoWidth, video.videoHeight, (meta.captureTime ?? meta.presentationTime ?? now) / 1000);
        video.requestVideoFrameCallback(cb);
      };
      video.requestVideoFrameCallback(cb);
    } else {
      let lastTotal = -1;
      const tick = (now: number) => {
        if (!open) return;
        const total = video.getVideoPlaybackQuality?.().totalVideoFrames ?? -2;
        if (total !== lastTotal || total === -2) { lastTotal = total; grab(video, video.videoWidth, video.videoHeight, now / 1000); }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    return { close: () => { open = false; } };
  };

  const updateStatus = () => {
    const parts = [`Recording ${fmtTime((performance.now() - recStart) / 1000)}`, `${frames} frames`, `${fmtBytes(sink?.pos ?? 0)}${limit < Infinity ? ` of ${fmtBytes(limit)}` : ""}`];
    if (skipped) parts.push(`${skipped} frame${skipped === 1 ? "" : "s"} not captured in time`);
    if (sizeChanged) parts.push("the stream changed size: frames are kept 1:1 (cropped or padded)");
    status.textContent = parts.join(" · ");
  };

  const start = async () => {
    if (state !== "preview") return;
    if (!video.videoWidth) { toast("Waiting for the first frame of the stream…", "info"); return; }
    const hd = await host.pickSaveFile(name, "video/x-msvideo", "avi", "AVI video (uncompressed)");
    if (hd === null) return; // save dialog closed: stay in preview
    handle = hd ?? null;
    try {
      if (handle) { sink = await FileSink.open(handle); limit = Infinity; }
      else {
        if (target.kind === "pending" || target.kind === "picker") await resolveTarget();
        if (target.kind === "staging") {
          try { sink = await host.staging!.openSink(name, "recording"); limit = captureStagingLimit(target.room); }
          catch { target = { kind: "memory" }; }
        }
        if (!sink) { sink = new BlobSink(); limit = captureMemoryLimit(); }
        describe();
      }
    } catch (e) { toast(`The file could not be opened for writing: ${(e as Error).message}`, "error"); return; }
    state = "recording";
    recStart = performance.now();
    d.setButtons([{ label: "Stop and Load", primary: true }]);
    timer = window.setInterval(updateStatus, 250);
    updateStatus();
    source = startSource();
  };

  const finish = async () => {
    const wasRecording = state === "recording";
    state = "done";
    source?.close();
    clearInterval(timer);
    track?.removeEventListener("ended", onEnded);
    if (!wasRecording || !sink) { stream.getTracks().forEach((t) => t.stop()); return; }
    await queue;
    stream.getTracks().forEach((t) => t.stop());
    const staged = sink instanceof RemoteSink ? sink : null;
    const drop = async () => { await sink!.abort(); if (staged) await host.staging!.discard(staged.entry); };
    if (failure || !avi || !frames) {
      await drop();
      toast(failure ? `The recording failed: ${failure.message}` : "No frames were captured.", failure ? "error" : "info", 6000);
      return;
    }
    const secs = t1 - t0;
    const fps = frames > 1 && secs > 0 ? snapFps((frames - 1) / secs) : nominalFps();
    avi.setFps(fps);
    const pd = progressDialog("Finishing the recording");
    try {
      await avi.finish();
      const bytes = sink.pos;
      const blob = await sink.close("video/x-msvideo");
      let file: File;
      if (blob) file = new File([blob], name, { type: "video/x-msvideo" });
      // (the staging file is named after its entry: give the recording its own name, without copying it)
      else if (staged) { file = new File([staged.file!], name, { type: "video/x-msvideo" }); host.staging!.done(staged.entry, file, bytes); }
      else file = await handle!.getFile();
      pd.close();
      // the recording is evidence: save it (a picked file already is)
      if (staged) host.staging!.download(staged.entry);
      else if (!handle) download(file, name, "video/x-msvideo");
      await host.loadFile(file);
      const saved = handle ? `, saved as ${handle.name}` : staged ? ", downloaded (staged on disk in the browser's storage)" : ", downloaded";
      const stop = hitLimit ? ` Recording stopped at the ${staged ? "storage" : "memory"} limit of this browser.` : "";
      toast(`Captured ${frames} frames losslessly (${w}×${ht}, uncompressed, ${fmtBytes(bytes)}, ${fps} fps measured)${skipped ? `; ${skipped} frame${skipped === 1 ? "" : "s"} could not be captured in time` : ""}${saved}.${stop}`, skipped || hitLimit ? "info" : "ok", 9000);
    } catch (e) {
      pd.close();
      await drop();
      toast(`The recording could not be finished: ${(e as Error).message}`, "error", 8000);
    }
  };

  const onEnded = () => d.close(); // the user stopped sharing from the browser's own controls
  track?.addEventListener("ended", onEnded);

  const d = dialog({
    title: "Video Input — Lossless Recording",
    body: h("div", { class: "form" }, video, note, status),
    width: 620,
    onClose: () => { void finish(); },
    buttons: [{ label: "Cancel" }, { label: "Start Recording", primary: true, action: () => { void start(); return false; } }],
  });
}
