// Pixel readback self-checks. Fingerprinting protections (Brave Shields, Firefox and Safari private
// browsing, Firefox "resist fingerprinting") add noise to pixels read back from canvases. LUCID reads
// decoded images and video frames that way where the browser offers nothing else, so it checks once that
// a known pattern comes back unchanged, through a canvas and through a WebCodecs VideoFrame.

const W = 64, H = 16;

/** Every 8-bit value appears in each channel; opaque. */
function pattern(): Uint8ClampedArray<ArrayBuffer> {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { d[i * 4] = (i * 7) & 255; d[i * 4 + 1] = (i * 13 + 85) & 255; d[i * 4 + 2] = (i * 29 + 170) & 255; d[i * 4 + 3] = 255; }
  return d;
}

function context2d(): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(W, H).getContext("2d", { willReadFrequently: true });
  if (typeof document !== "undefined") { const c = document.createElement("canvas"); c.width = W; c.height = H; return c.getContext("2d", { willReadFrequently: true }); }
  return null;
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>, stride = 4, rgbOnly = false) => {
  for (let i = 0; i < W * H; i++) for (let c = 0; c < (rgbOnly ? 3 : 4); c++) if (a[i * stride + c] !== b[i * 4 + c]) return false;
  return true;
};

let canvasResult: Promise<boolean> | null = null;
let frameResult: Promise<boolean> | null = null;

/** Whether pixels drawn into a canvas read back unchanged (false: a protection perturbs them). */
export function canvasReadbackExact(): Promise<boolean> {
  return (canvasResult ??= (async () => {
    try {
      const ctx = context2d();
      if (!ctx) return true;
      const ref = pattern();
      ctx.putImageData(new ImageData(ref, W, H), 0, 0);
      if (!same(ctx.getImageData(0, 0, W, H).data, ref)) return false;
      // drawing a decoded bitmap is the path used for images and video
      const bmp = await createImageBitmap(new ImageData(ref.slice(), W, H));
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      return same(ctx.getImageData(0, 0, W, H).data, ref);
    } catch { return false; }
  })());
}

/** Whether a decoded bitmap reads back unchanged through a WebCodecs VideoFrame (no canvas involved). */
export function videoFrameReadbackExact(): Promise<boolean> {
  return (frameResult ??= (async () => {
    const VF = (globalThis as { VideoFrame?: typeof VideoFrame }).VideoFrame;
    if (!VF || typeof createImageBitmap !== "function") return false;
    let vf: VideoFrame | null = null;
    try {
      const ref = pattern();
      const bmp = await createImageBitmap(new ImageData(ref.slice(), W, H));
      vf = new VF(bmp, { timestamp: 0 });
      bmp.close();
      const fmt = vf.format;
      if (!fmt || !/^(RGBA|RGBX|BGRA|BGRX)$/.test(fmt)) return false;
      const buf = new Uint8Array(vf.allocationSize());
      const layout = await vf.copyTo(buf);
      const L = layout[0], bgr = fmt.startsWith("BGR");
      const rgba = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = L.offset + y * L.stride + x * 4, o = (y * W + x) * 4;
        rgba[o] = buf[bgr ? s + 2 : s]; rgba[o + 1] = buf[s + 1]; rgba[o + 2] = buf[bgr ? s : s + 2]; rgba[o + 3] = 255;
      }
      return same(rgba, ref, 4, true);
    } catch { return false; }
    finally { vf?.close(); }
  })());
}
