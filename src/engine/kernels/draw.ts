// Vector drawing on frames via OffscreenCanvas, composited onto the float data so that
// pixels outside the annotations keep their full precision.
import type { Frame } from "../frame";

export function overlay(f: Frame, draw: (ctx: OffscreenCanvasRenderingContext2D) => void): Frame {
  const c = new OffscreenCanvas(f.w, f.h);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  draw(ctx);
  const img = ctx.getImageData(0, 0, f.w, f.h).data;
  const d = f.d, out = new Float32Array(d);
  for (let i = 0; i < img.length; i += 4) {
    const a = img[i + 3];
    if (!a) continue;
    const t = a / 255;
    out[i] += (img[i] - out[i]) * t;
    out[i + 1] += (img[i + 1] - out[i + 1]) * t;
    out[i + 2] += (img[i + 2] - out[i + 2]) * t;
  }
  return { w: f.w, h: f.h, d: out };
}

export const FONT_FAMILY: Record<string, string> = {
  sans: "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "Consolas, 'DejaVu Sans Mono', 'Courier New', monospace",
};

export function arrowHead(ctx: OffscreenCanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, size: number) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(a - Math.PI / 7), y2 - size * Math.sin(a - Math.PI / 7));
  ctx.lineTo(x2 - size * Math.cos(a + Math.PI / 7), y2 - size * Math.sin(a + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

/** Text label with an optional translucent background box. */
export function label(ctx: OffscreenCanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, bg: string | null, font = FONT_FAMILY.sans, bold = true) {
  ctx.font = `${bold ? "bold " : ""}${size}px ${font}`;
  ctx.textBaseline = "top";
  const lines = text.split("\n");
  const lh = size * 1.2;
  const wMax = Math.max(...lines.map((l) => ctx.measureText(l).width));
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(x - size * 0.25, y - size * 0.15, wMax + size * 0.5, lh * lines.length + size * 0.1); }
  ctx.fillStyle = color;
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lh));
}

export function hexA(hex: string, a: number): string {
  let s = hex.replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  const n = parseInt(s, 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
