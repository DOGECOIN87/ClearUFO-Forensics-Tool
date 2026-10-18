// "Browser Media Element" video engine: frames grabbed from an HTMLVideoElement on the UI thread.
// Used as a fallback when WebCodecs cannot decode a codec that the browser can still play.
interface Entry { video: HTMLVideoElement; url: string; canvas: HTMLCanvasElement; ready: Promise<void> }
/** Planar YUV formats the engine converts itself (8, 10 and 12-bit, with or without alpha, and NV12). */
const PLANAR = /^(I420|I422|I444)A?(P10|P12)?$|^NV12$/;
export interface MtFrame {
  w: number; h: number;
  data?: Uint8ClampedArray;
  yuv?: { buf: Uint8Array; layout: { offset: number; stride: number }[]; format: string; matrix: string | null; fullRange: boolean | null };
}

export class MediaElementFrames {
  private files = new Map<string, File>();
  private open = new Map<string, Entry>();
  private queue: Promise<unknown> = Promise.resolve();

  register(sourceId: string, file: File) { this.files.set(sourceId, file); }

  private entry(sourceId: string): Entry {
    let e = this.open.get(sourceId);
    if (e) return e;
    const file = this.files.get(sourceId);
    if (!file) throw new Error("Media file not available");
    const video = document.createElement("video");
    video.muted = true; video.preload = "auto"; video.playsInline = true; video.crossOrigin = "anonymous";
    const url = URL.createObjectURL(file);
    video.src = url;
    const ready = new Promise<void>((resolve, reject) => {
      video.addEventListener("loadeddata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("The browser cannot play this file with the media element")), { once: true });
    });
    e = { video, url, canvas: document.createElement("canvas"), ready };
    this.open.set(sourceId, e);
    return e;
  }

  async meta(sourceId: string) {
    const e = this.entry(sourceId);
    await e.ready;
    return { width: e.video.videoWidth, height: e.video.videoHeight, duration: e.video.duration };
  }

  frame(sourceId: string, time: number): Promise<MtFrame> {
    const run = async (): Promise<MtFrame> => {
      const e = this.entry(sourceId);
      await e.ready;
      const v = e.video;
      const t = Math.max(0, Math.min(v.duration - 1e-3, time));
      if (Math.abs(v.currentTime - t) > 1e-4) {
        await new Promise<void>((resolve) => { v.addEventListener("seeked", () => resolve(), { once: true }); v.currentTime = t; });
      }
      // Prefer the decoded planes (exact samples, converted by the engine with the loader settings) when the
      // browser exposes them; GPU-backed frames have no readable format and go through the canvas below.
      if (typeof VideoFrame !== "undefined") {
        let vf: VideoFrame | null = null;
        try {
          vf = new VideoFrame(v, { timestamp: Math.round(t * 1e6) });
          const fmt = vf.format, r = vf.visibleRect;
          if (fmt && PLANAR.test(fmt) && r) {
            const buf = new Uint8Array(vf.allocationSize());
            const layout = await vf.copyTo(buf);
            return { w: Math.round(r.width), h: Math.round(r.height), yuv: { buf, layout: layout.map((l) => ({ offset: l.offset, stride: l.stride })), format: fmt, matrix: vf.colorSpace?.matrix ?? null, fullRange: vf.colorSpace?.fullRange ?? null } };
          }
        } catch { /* not supported for this element: canvas */ } finally { vf?.close(); }
      }
      const w = v.videoWidth, h = v.videoHeight;
      if (e.canvas.width !== w || e.canvas.height !== h) { e.canvas.width = w; e.canvas.height = h; }
      const ctx = e.canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(v, 0, 0, w, h);
      return { w, h, data: ctx.getImageData(0, 0, w, h).data };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}
