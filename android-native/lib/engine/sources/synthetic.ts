// Synthetic, fully deterministic test material: degraded license plate (motion blur, noise,
// camera shake), color bars, resolution chart, zone plate, calibration grid and periodic noise.
//
// The browser reference paints the scene on an OffscreenCanvas. React Native has no canvas, so the
// native generator draws the same scenes with the software rasterizer of this app (same layout, same
// parameters, same deterministic noise). The rasterized pixels are not bit-identical to the browser's
// antialiased canvas output; the degradation model (blur, noise, shake) and the geometry are.
import type { FrameMeta, SourceInfo } from "../../shared/types";
import { linePsf } from "../../shared/psf";
import { fromRGBA8, type Frame } from "../frame";
import { RasterContext } from "../kernels/raster";
import { baseInfo, type SourceProvider } from "./types";

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
  const ctx = new RasterContext(W, H);
  const r = rng(seed);
  if (pattern === "bars") {
    const cols = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
    cols.forEach((col, i) => { ctx.fillStyle = col; ctx.fillRect((i * W) / 7, 0, W / 7 + 1, H * 0.67); });
    const low = ["#0000c0", "#131313", "#c000c0", "#131313", "#00c0c0", "#131313", "#c0c0c0"];
    low.forEach((col, i) => { ctx.fillStyle = col; ctx.fillRect((i * W) / 7, H * 0.67, W / 7 + 1, H * 0.08); });
    for (let x = 0; x < W; x++) { const v = Math.round((x / Math.max(1, W - 1)) * 255); ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(x, H * 0.75, 1, H * 0.25); }
  } else if (pattern === "zone") {
    const d = ctx.imageData();
    const k = Math.PI / Math.max(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = x - W / 2, dy = y - H / 2;
      const v = 127.5 + 127.5 * Math.cos(k * (dx * dx + dy * dy));
      const o = (y * W + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255;
    }
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
    ctx.fillStyle = "#111"; ctx.font = `bold ${Math.max(6, Math.round(H * 0.05))}px sans-serif`; ctx.fillText("LUCID 2026", W * 0.56, H * 0.46);
  } else if (pattern === "grid") {
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    const n = 12, cell = Math.min(W, H) / 8;
    ctx.fillStyle = "#000";
    for (let gy = -n; gy < n; gy++) for (let gx = -n; gx < n; gx++) if ((gx + gy) & 1) ctx.fillRect(W / 2 + gx * cell, H / 2 + gy * cell, cell, cell);
  } else {
    // plate scene
    const d = ctx.imageData();
    for (let y = 0; y < H; y++) {
      const t = y / Math.max(1, H - 1);
      const rr = Math.round(0x3d + (0x1e - 0x3d) * t);
      const gg = Math.round(0x41 + (0x20 - 0x41) * t);
      const bb = Math.round(0x48 + (0x24 - 0x48) * t);
      for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; d[o] = rr; d[o + 1] = gg; d[o + 2] = bb; d[o + 3] = 255; }
    }
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
    ctx.fillStyle = "#1c2a5a"; ctx.font = `bold ${Math.max(6, Math.round(ph * 0.16))}px sans-serif`; ctx.fillText("TEXAS", px + pw / 2 - ctx.measureText("TEXAS").width / 2, py + ph * 0.12);
    const t = plateText(seed);
    ctx.fillStyle = "#141414"; ctx.font = `bold ${Math.max(6, Math.round(Math.min(ph * 0.5, (pw * 0.86) / 6)))}px sans-serif`;
    ctx.fillText(t, px + pw / 2 - ctx.measureText(t).width / 2, py + ph * 0.38);
    ctx.fillStyle = "#777";
    for (const sx of [0.18, 0.82]) { ctx.beginPath(); ctx.arc(px + pw * sx, py + ph * 0.18, ph * 0.03, 0, Math.PI * 2); ctx.fill(); }
  }
  return fromRGBA8(ctx.imageData(), W, H);
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
        const a = src[(y0 * w + x0) * 4 + c], b = src[(y0 * w + x1) * 4 + c], cc = src[(y1 * w + x0) * 4 + c], d = src[(y1 * w + x1) * 4 + c];
        shifted[o + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
      }
      shifted[o + 3] = 255;
    }
    // motion blur along the blur angle (the line spread function of the reference)
    const psf = linePsf(Math.max(1, this.p.blur | 0), this.p.blurAngle || 0);
    const blurred = convolveWithPsf(shifted, w, h, psf.d, psf.w, psf.h);
    // additive noise (deterministic)
    const noise = Math.max(0, this.p.noise || 0);
    const rn = rng((this.p.seed | 0) * 31 + i);
    const out = new Float32Array(blurred.length);
    for (let k = 0; k < blurred.length; k += 4) {
      for (let c = 0; c < 3; c++) {
        const n = noise > 0 ? (rn() + rn() + rn() - 1.5) * 2 * noise : 0;
        out[k + c] = blurred[k + c] + n;
      }
      out[k + 3] = 255;
    }
    return { w, h, d: out };
  }

  meta(i: number): FrameMeta { return { type: "I", key: true, pts: i / (this.info.fps || 25), src: i }; }

  dispose() { /* nothing to release */ }
}

/** Convolve an RGBA float image with a small kernel (the motion blur of the test material). */
function convolveWithPsf(src: Float32Array, w: number, h: number, psf: Float32Array, pw: number, ph: number): Float32Array {
  const out = new Float32Array(src.length);
  const rx = pw >> 1, ry = ph >> 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    let r = 0, g = 0, b = 0;
    for (let ky = 0; ky < ph; ky++) {
      const sy = Math.min(h - 1, Math.max(0, y + ky - ry));
      for (let kx = 0; kx < pw; kx++) {
        const wgt = psf[ky * pw + kx];
        if (!wgt) continue;
        const sx = Math.min(w - 1, Math.max(0, x + kx - rx));
        const s = (sy * w + sx) * 4;
        r += src[s] * wgt; g += src[s + 1] * wgt; b += src[s + 2] * wgt;
      }
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
  }
  return out;
}
