// Synthetic, fully deterministic test material: degraded license plate (motion blur, noise,
// camera shake), color bars, resolution chart, zone plate, distorted grid and periodic noise.
// Text uses a built-in stroke font so the output is identical on every system.
import type { FrameMeta, SourceInfo } from "../../shared/types";
import { linePsf } from "../../shared/psf";
import { fromRGBA8, type Frame } from "../frame";
import { baseInfo, type SourceProvider } from "./types";

const G: Record<string, number[][][]> = {
  "0": [[[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]]],
  "1": [[[1, 1], [2, 0], [2, 6]], [[1, 6], [3, 6]]],
  "2": [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [0, 6], [4, 6]]],
  "3": [[[0, 0], [4, 0], [2, 2.5], [3, 2.5], [4, 3.5], [4, 5], [3, 6], [1, 6], [0, 5]]],
  "4": [[[3, 6], [3, 0], [0, 4], [4, 4]]],
  "5": [[[4, 0], [0, 0], [0, 2.5], [3, 2.5], [4, 3.5], [4, 5], [3, 6], [0, 6]]],
  "6": [[[3.5, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3.5], [3, 2.5], [0, 2.5]]],
  "7": [[[0, 0], [4, 0], [1.5, 6]]],
  "8": [[[1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1, 3], [0, 2], [0, 1], [1, 0]]],
  "9": [[[4, 3.5], [1, 3.5], [0, 2.5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [0.5, 6]]],
  A: [[[0, 6], [2, 0], [4, 6]], [[0.7, 4], [3.3, 4]]],
  B: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[0, 0], [3, 0], [4, 1], [4, 2], [3, 3]]],
  C: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]],
  D: [[[0, 0], [0, 6], [2.5, 6], [4, 4.5], [4, 1.5], [2.5, 0], [0, 0]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  F: [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]],
  G: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3.5], [2.5, 3.5]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  J: [[[4, 0], [4, 5], [3, 6], [1, 6], [0, 5]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 3.5]], [[1.3, 2.6], [4, 6]]],
  L: [[[0, 0], [0, 6], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  P: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2.5], [3, 3.5], [0, 3.5]]],
  R: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2.5], [3, 3.5], [0, 3.5]], [[2, 3.5], [4, 6]]],
  S: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]],
  V: [[[0, 0], [2, 6], [4, 0]]],
  W: [[[0, 0], [1, 6], [2, 2.5], [3, 6], [4, 0]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
  Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]],
  Z: [[[0, 0], [4, 0], [0, 6], [4, 6]]],
  "-": [[[0.5, 3], [3.5, 3]]],
  ".": [[[2, 5.8], [2, 6]]],
  ":": [[[2, 1.8], [2, 2]], [[2, 4.8], [2, 5]]],
};

export function strokeText(ctx: OffscreenCanvasRenderingContext2D, text: string, x: number, y: number, h: number, weight = 0.16, xs = 0.72) {
  const s = h / 6;
  ctx.save();
  ctx.lineWidth = Math.max(1, h * weight);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = G[ch];
    if (g) for (const poly of g) {
      ctx.beginPath();
      poly.forEach(([px, py], i) => (i ? ctx.lineTo(cx + px * s * xs, y + py * s) : ctx.moveTo(cx + px * s * xs, y + py * s)));
      ctx.stroke();
    }
    cx += s * (4 * xs + 1.25);
  }
  ctx.restore();
  return cx - x;
}

export const strokeTextWidth = (text: string, h: number, xs = 0.72) => text.length * (h / 6) * (4 * xs + 1.25) - (h / 6) * 1.25;

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function plateText(seed: number) {
  const r = rng(seed * 7919 + 13);
  const L = "ABCDEFGHJKLMNPRSTUVWXYZ", D = "0123456789";
  const pick = (s: string) => s[Math.floor(r() * s.length)];
  return `${pick(L)}${pick(L)}${pick(L)}-${pick(D)}${pick(D)}${pick(D)}${pick(D)}`;
}

function drawScene(pattern: string, W: number, H: number, seed: number): Frame {
  const S = 2;
  const c = new OffscreenCanvas(W * S, H * S);
  const ctx = c.getContext("2d")!;
  ctx.scale(S, S);
  const r = rng(seed);
  if (pattern === "bars") {
    const cols = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
    cols.forEach((col, i) => { ctx.fillStyle = col; ctx.fillRect((i * W) / 7, 0, W / 7 + 1, H * 0.67); });
    const low = ["#0000c0", "#131313", "#c000c0", "#131313", "#00c0c0", "#131313", "#c0c0c0"];
    low.forEach((col, i) => { ctx.fillStyle = col; ctx.fillRect((i * W) / 7, H * 0.67, W / 7 + 1, H * 0.08); });
    for (let x = 0; x < W; x++) { const v = Math.round((x / (W - 1)) * 255); ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(x, H * 0.75, 1, H * 0.25); }
  } else if (pattern === "zone") {
    const img = ctx.createImageData(W, H);
    const k = Math.PI / Math.max(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = x - W / 2, dy = y - H / 2;
      const v = 127.5 + 127.5 * Math.cos(k * (dx * dx + dy * dy));
      const o = (y * W + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
    }
    const t = new OffscreenCanvas(W, H);
    t.getContext("2d")!.putImageData(img, 0, 0);
    ctx.drawImage(t, 0, 0);
  } else if (pattern === "chart") {
    ctx.fillStyle = "#f2f2f2"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#111";
    const cx = W * 0.27, cy = H * 0.5, R = Math.min(W, H) * 0.38;
    for (let i = 0; i < 36; i++) {
      const a0 = (i / 36) * Math.PI * 2, a1 = ((i + 0.5) / 36) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a0, a1); ctx.closePath(); ctx.fill();
    }
    let x = W * 0.56;
    for (let lp = 1; lp <= 8; lp++) {
      const bw = Math.max(0.5, 6 / lp);
      for (let k = 0; k < 5; k++) ctx.fillRect(x + k * bw * 2, H * 0.12, bw, H * 0.3);
      for (let k = 0; k < 5; k++) ctx.fillRect(x, H * 0.55 + k * bw * 2, bw * 10, bw);
      x += bw * 10 + 8;
    }
    for (let i = 0; i < 11; i++) { const v = Math.round((i / 10) * 255); ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(W * 0.56 + i * (W * 0.4 / 11), H * 0.85, W * 0.4 / 11, H * 0.1); }
    ctx.strokeStyle = "#111"; strokeText(ctx, "LUCID 2026", W * 0.56, H * 0.46, H * 0.05, 0.12);
  } else if (pattern === "grid") {
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    const n = 12, cell = Math.min(W, H) / 8;
    ctx.fillStyle = "#000";
    for (let gy = -n; gy < n; gy++) for (let gx = -n; gx < n; gx++) if ((gx + gy) & 1) ctx.fillRect(W / 2 + gx * cell, H / 2 + gy * cell, cell, cell);
  } else {
    // plate scene
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#3d4148"); g.addColorStop(1, "#1e2024");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 900; i++) { const v = 40 + r() * 40; ctx.fillStyle = `rgba(${v},${v},${v + 5},0.35)`; ctx.fillRect(r() * W, r() * H, 1 + r() * 2, 1 + r() * 2); }
    const bw = W * 0.8, bh = H * 0.62, bx = (W - bw) / 2, by = H * 0.2;
    ctx.fillStyle = "#6b1418";
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, H * 0.06); ctx.fill();
    ctx.fillStyle = "#4b0e11"; ctx.fillRect(bx, by + bh * 0.72, bw, bh * 0.28);
    ctx.fillStyle = "#ff3b2f"; ctx.fillRect(bx + bw * 0.04, by + bh * 0.18, bw * 0.16, bh * 0.16); ctx.fillRect(bx + bw * 0.8, by + bh * 0.18, bw * 0.16, bh * 0.16);
    ctx.fillStyle = "#ffd0a0"; ctx.fillRect(bx + bw * 0.06, by + bh * 0.21, bw * 0.05, bh * 0.08); ctx.fillRect(bx + bw * 0.89, by + bh * 0.21, bw * 0.05, bh * 0.08);
    const pw = bw * 0.42, ph = pw / 2.0, px = (W - pw) / 2, py = by + bh * 0.3;
    ctx.fillStyle = "#e9e6dc"; ctx.beginPath(); ctx.roundRect(px, py, pw, ph, ph * 0.08); ctx.fill();
    ctx.strokeStyle = "#1c2a5a"; ctx.lineWidth = Math.max(1, ph * 0.04); ctx.beginPath(); ctx.roundRect(px + ph * 0.05, py + ph * 0.05, pw - ph * 0.1, ph - ph * 0.1, ph * 0.06); ctx.stroke();
    ctx.strokeStyle = "#1c2a5a"; strokeText(ctx, "TEXAS", px + pw / 2 - strokeTextWidth("TEXAS", ph * 0.14) / 2, py + ph * 0.1, ph * 0.14, 0.14);
    ctx.strokeStyle = "#141414"; const t = plateText(seed); const th = Math.min(ph * 0.5, (pw * 0.86) / (strokeTextWidth(t, 6) / 6)); strokeText(ctx, t, px + pw / 2 - strokeTextWidth(t, th) / 2, py + ph * 0.32 + (ph * 0.5 - th) / 2, th, 0.14);
    ctx.fillStyle = "#777"; for (const sx of [0.18, 0.82]) { ctx.beginPath(); ctx.arc(px + pw * sx, py + ph * 0.18, ph * 0.03, 0, Math.PI * 2); ctx.fill(); }
  }
  const out = new OffscreenCanvas(W, H);
  const octx = out.getContext("2d", { willReadFrequently: true })!;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(c, 0, 0, W, H);
  return fromRGBA8(octx.getImageData(0, 0, W, H).data, W, H);
}

function warpBarrel(f: Frame, k1: number): Frame {
  const { w, h } = f, out = new Float32Array(f.d.length);
  const cx = w / 2, cy = h / 2, R = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const nx = (x - cx) / R, ny = (y - cy) / R, r2 = nx * nx + ny * ny, s = 1 + k1 * r2;
    const sx = Math.min(w - 1, Math.max(0, cx + nx * s * R)), sy = Math.min(h - 1, Math.max(0, cy + ny * s * R));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = sx - x0, fy = sy - y0;
    const o = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      const a = f.d[(y0 * w + x0) * 4 + c], b = f.d[(y0 * w + x1) * 4 + c], cc = f.d[(y1 * w + x0) * 4 + c], d = f.d[(y1 * w + x1) * 4 + c];
      out[o + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
    }
    out[o + 3] = 255;
  }
  return { w, h, d: out };
}

export class SyntheticSource implements SourceProvider {
  info: SourceInfo;
  private base: Frame;
  private shake: { x: number; y: number }[] = [];
  constructor(public id: string, private p: Record<string, any>) {
    const W = Math.max(64, Math.min(3840, p.width | 0)), H = Math.max(64, Math.min(2160, p.height | 0));
    const n = Math.max(1, Math.min(10000, p.frames | 0));
    const names: Record<string, string> = { plate: "License Plate (degraded)", bars: "Color Bars", chart: "Resolution Chart", zone: "Zone Plate", grid: "Calibration Grid", periodic: "Periodic Noise" };
    this.info = baseInfo(id, `Test Pattern — ${names[p.pattern] ?? p.pattern}`, "synthetic");
    Object.assign(this.info, { width: W, height: H, frameCount: n, fps: p.fps || 25, duration: n / (p.fps || 25), container: "Synthetic", codec: "Generated", engine: "Built-in generator", videoStreams: 1, frameTypesReady: true });
    this.base = drawScene(p.pattern === "periodic" ? "plate" : p.pattern, W, H, p.seed | 0);
    if (p.pattern === "grid") this.base = warpBarrel(this.base, -0.22);
    const r = rng((p.seed | 0) + 101);
    const ph = [r() * 6.28, r() * 6.28, r() * 6.28, r() * 6.28];
    for (let i = 0; i < n; i++) this.shake.push({ x: p.shake * (0.6 * Math.sin(i * 0.37 + ph[0]) + 0.4 * Math.sin(i * 1.13 + ph[1])), y: p.shake * (0.6 * Math.sin(i * 0.29 + ph[2]) + 0.4 * Math.sin(i * 0.91 + ph[3])) });
    this.info.metadata = [["Generator", names[p.pattern] ?? p.pattern], ["Motion Blur", `${p.blur} px at ${p.blurAngle}°`], ["Noise (sigma)", String(p.noise)], ["Camera Shake", `${p.shake} px`], ["Seed", String(p.seed)]];
    if (p.pattern === "plate" || p.pattern === "periodic") this.info.metadata.push(["Ground Truth Plate", plateText(p.seed | 0)]);
  }

  async getFrame(i: number): Promise<Frame> {
    i = Math.max(0, Math.min(this.info.frameCount - 1, i | 0));
    const { w, h } = this.base;
    const s = this.shake[i];
    const src = this.base.d;
    // sub-pixel shift (bilinear)
    const shifted = new Float32Array(src.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - s.x)), sy = Math.min(h - 1, Math.max(0, y - s.y));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = sx - x0, fy = sy - y0;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        shifted[o + c] = (src[(y0 * w + x0) * 4 + c] * (1 - fx) + src[(y0 * w + x1) * 4 + c] * fx) * (1 - fy) + (src[(y1 * w + x0) * 4 + c] * (1 - fx) + src[(y1 * w + x1) * 4 + c] * fx) * fy;
      }
    }
    // motion blur with the exact linear PSF (so Motion Deblurring can invert it)
    let blurred = shifted;
    if (this.p.blur >= 1) {
      const psf = linePsf(this.p.blur, this.p.blurAngle);
      // taps in flat typed arrays: destructuring in this per-pixel loop is several times slower in JavaScriptCore
      const tdx: number[] = [], tdy: number[] = [], tvv: number[] = [];
      for (let ky = 0; ky < psf.h; ky++) for (let kx = 0; kx < psf.w; kx++) { const v = psf.d[ky * psf.w + kx]; if (v > 1e-5) { tdx.push(kx - (psf.w >> 1)); tdy.push(ky - (psf.h >> 1)); tvv.push(v); } }
      const nt = tvv.length, TX = Int32Array.from(tdx), TY = Int32Array.from(tdy), TV = Float64Array.from(tvv);
      blurred = new Float32Array(src.length);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0;
        for (let t = 0; t < nt; t++) {
          const v = TV[t];
          const xx = Math.min(w - 1, Math.max(0, x - TX[t])), yy = Math.min(h - 1, Math.max(0, y - TY[t]));
          const k = (yy * w + xx) * 4;
          r += shifted[k] * v; g += shifted[k + 1] * v; b += shifted[k + 2] * v;
        }
        const o = (y * w + x) * 4;
        blurred[o] = r; blurred[o + 1] = g; blurred[o + 2] = b;
      }
    }
    // periodic interference, gaussian noise and 8-bit quantization (capture simulation)
    const rand = rng((this.p.seed | 0) * 1000003 + i * 7919 + 1);
    const sigma = this.p.noise || 0;
    const periodic = this.p.pattern === "periodic";
    const out = new Float32Array(src.length);
    for (let k = 0, px = 0; k < out.length; k += 4, px++) {
      const x = px % w, y = (px / w) | 0;
      const per = periodic ? 28 * Math.sin(x * 0.9 + y * 0.35) + 18 * Math.sin(x * 0.21 - y * 0.77) : 0;
      for (let c = 0; c < 3; c++) {
        let n = 0;
        if (sigma > 0) { const u1 = Math.max(1e-9, rand()), u2 = rand(); n = sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(6.283185307 * u2); }
        out[k + c] = Math.round(Math.min(255, Math.max(0, blurred[k + c] + n + per)));
      }
      out[k + 3] = 255;
    }
    return { w, h, d: out };
  }

  meta(i: number): FrameMeta { return { type: "I", key: true, pts: i / this.info.fps, src: i }; }
  dispose() { /* nothing */ }
}
