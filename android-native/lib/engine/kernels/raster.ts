// Software 2D rasterizer used for annotations, overlays and the synthetic test material.
//
// The browser reference draws overlays on an OffscreenCanvas and composites the result onto the float
// frame. React Native has no canvas, so the same drawing model is implemented here in plain TypeScript:
// the same path model (moveTo/lineTo/rect/ellipse/arc), the same painting model (fill, stroke, fillRect,
// fillText) and the same compositing rule (source-over with the alpha of the drawn pixels). Pixels
// outside the annotation keep their full float precision.
//
// Text is drawn with a built-in bitmap font (see font.ts), so a label is rendered identically on every
// device; the browser uses the system font instead. This is the one documented difference between the
// native export and the browser export of the annotation filters.

import type { Frame } from "../frame";

export interface Rgba { r: number; g: number; b: number; a: number }

export function parseRgba(style: string, alpha = 1): Rgba {
  const s = (style || "#000").trim();
  if (s.startsWith("rgba") || s.startsWith("rgb")) {
    const nums = s.replace(/[^0-9.,]/g, "").split(",").map((v) => parseFloat(v));
    return { r: nums[0] || 0, g: nums[1] || 0, b: nums[2] || 0, a: (nums.length > 3 ? nums[3] : 1) * alpha };
  }
  let hex = s.replace("#", "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const n = parseInt(hex.slice(0, 6), 16) || 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: alpha };
}

export function hexA(hex: string, a: number): string {
  const c = parseRgba(hex, 1);
  return `rgba(${c.r},${c.g},${c.b},${Math.max(0, Math.min(1, a))})`;
}

/** Font families of the browser reference; the native rasterizer uses one built-in face for all of them. */
export const FONT_FAMILY: Record<string, string> = {
  sans: "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "Consolas, 'DejaVu Sans Mono', 'Courier New', monospace",
};

type Point = [number, number];
/** A subpath: a list of points. */
type Poly = Point[];

interface State {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textBaseline: string;
  lineCap: string;
  lineJoin: string;
  globalAlpha: number;
  m: number[]; // 2x3 transform: [a, b, c, d, e, f]
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

const apply = (m: number[], x: number, y: number): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const scaleM = (m: number[], sx: number, sy: number): number[] => [
  m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy, m[4], m[5],
];
const translateM = (m: number[], dx: number, dy: number): number[] => [
  m[0], m[1], m[2], m[3], m[0] * dx + m[2] * dy + m[4], m[1] * dx + m[3] * dy + m[5],
];
const rotateM = (m: number[], r: number): number[] => {
  const c = Math.cos(r), s = Math.sin(r);
  return [m[0] * c + m[2] * s, m[1] * c + m[3] * s, -m[0] * s + m[2] * c, -m[1] * s + m[3] * c, m[4], m[5]];
};

/** Coverage of a pixel by a polygon (non-zero winding), sampled on a 4x4 grid. */
function polygonCoverage(poly: Poly, w: number, h: number, cov: Float32Array): void {
  if (poly.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of poly) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(h - 1, Math.ceil(maxY));
  const SS = 4, inv = 1 / SS;
  for (let py = y0; py <= y1; py++) {
    for (let px = 0; px < w; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        const y = py + (sy + 0.5) * inv;
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) * inv;
          let wind = 0;
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const [xi, yi] = poly[i], [xj, yj] = poly[j];
            if (yi <= y) {
              if (yj > y && (xj - xi) * (y - yi) - (x - xi) * (yj - yi) > 0) wind++;
            } else if (yj <= y && (xj - xi) * (y - yi) - (x - xi) * (yj - yi) < 0) wind--;
          }
          if (wind !== 0) hits++;
        }
      }
      if (hits) cov[py * w + px] = Math.max(cov[py * w + px], hits / (SS * SS));
    }
  }
}

/** Coverage of a pixel by a disc (round caps and joins). */
function discCoverage(cx: number, cy: number, r: number, w: number, h: number, cov: Float32Array): void {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
  const SS = 4, inv = 1 / SS, r2 = r * r;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        const y = py + (sy + 0.5) * inv - cy;
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) * inv - cx;
          if (x * x + y * y <= r2) hits++;
        }
      }
      if (hits) cov[py * w + px] = Math.max(cov[py * w + px], hits / (SS * SS));
    }
  }
}

/** Coverage of a pixel by a thick segment (a rectangle around the segment). */
function segmentCoverage(ax: number, ay: number, bx: number, by: number, r: number, w: number, h: number, cov: Float32Array): void {
  const minX = Math.max(0, Math.floor(Math.min(ax, bx) - r)), maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r));
  const minY = Math.max(0, Math.floor(Math.min(ay, by) - r)), maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r));
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const SS = 4, inv = 1 / SS, r2 = r * r;
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        const y = py + (sy + 0.5) * inv;
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) * inv;
          let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + t * dx - x, qy = ay + t * dy - y;
          if (qx * qx + qy * qy <= r2) hits++;
        }
      }
      if (hits) cov[py * w + px] = Math.max(cov[py * w + px], hits / (SS * SS));
    }
  }
}

export class RasterContext {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  private state: State = {
    fillStyle: "#000000", strokeStyle: "#000000", lineWidth: 1, font: "10px sans-serif",
    textBaseline: "top", lineCap: "butt", lineJoin: "miter", globalAlpha: 1, m: [...IDENTITY],
  };
  private stack: State[] = [];
  private path: Poly = [];          // current subpath
  private subpaths: Poly[] = [];      // all subpaths of the path
  private cur: Point = [0, 0];
  private dash: number[] = [];

  constructor(width: number, height: number, data?: Uint8ClampedArray) {
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8ClampedArray(width * height * 4);
  }

  // ---- state
  save() { this.stack.push({ ...this.state, m: [...this.state.m] }); }
  restore() { const s = this.stack.pop(); if (s) this.state = s; }
  get fillStyle() { return this.state.fillStyle; }
  set fillStyle(v: string) { this.state.fillStyle = v; }
  get strokeStyle() { return this.state.strokeStyle; }
  set strokeStyle(v: string) { this.state.strokeStyle = v; }
  get lineWidth() { return this.state.lineWidth; }
  set lineWidth(v: number) { this.state.lineWidth = v; }
  get font() { return this.state.font; }
  set font(v: string) { this.state.font = v; }
  get textBaseline() { return this.state.textBaseline; }
  set textBaseline(v: string) { this.state.textBaseline = v; }
  get lineCap() { return this.state.lineCap; }
  set lineCap(v: string) { this.state.lineCap = v; }
  get lineJoin() { return this.state.lineJoin; }
  set lineJoin(v: string) { this.state.lineJoin = v; }
  get globalAlpha() { return this.state.globalAlpha; }
  set globalAlpha(v: number) { this.state.globalAlpha = v; }
  setLineDash(d: number[]) { this.dash = d.slice(); }

  // ---- transforms
  scale(x: number, y: number) { this.state.m = scaleM(this.state.m, x, y); }
  translate(x: number, y: number) { this.state.m = translateM(this.state.m, x, y); }
  rotate(a: number) { this.state.m = rotateM(this.state.m, a); }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { this.state.m = [a, b, c, d, e, f]; }

  // ---- path
  beginPath() { this.path = []; this.subpaths = []; }
  moveTo(x: number, y: number) { this.flushPath(); this.cur = apply(this.state.m, x, y); this.path = [this.cur]; }
  lineTo(x: number, y: number) { if (!this.path.length) this.path = [this.cur]; this.path.push(apply(this.state.m, x, y)); this.cur = apply(this.state.m, x, y); }
  closePath() { if (this.path.length > 1) { this.path.push([...this.path[0]]); } }
  private flushPath() { if (this.path.length) this.subpaths.push(this.path); this.path = []; }

  rect(x: number, y: number, w: number, h: number) {
    this.flushPath();
    const p = [apply(this.state.m, x, y), apply(this.state.m, x + w, y), apply(this.state.m, x + w, y + h), apply(this.state.m, x, y + h)];
    this.subpaths.push(p);
  }

  /** Rounded rectangle (the shape of the license plate in the test material). */
  roundRect(x: number, y: number, w: number, h: number, r: number) {
    const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    const p: Poly = [];
    const corners: [number, number, number][] = [
      [x + w - rr, y + rr, -Math.PI / 2],
      [x + w - rr, y + h - rr, 0],
      [x + rr, y + h - rr, Math.PI / 2],
      [x + rr, y + rr, Math.PI],
    ];
    for (const [cx, cy, a0] of corners) {
      const steps = 8;
      for (let i = 0; i <= steps; i++) {
        const a = a0 + (Math.PI / 2) * (i / steps);
        p.push(apply(this.state.m, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
      }
    }
    p.push(p[0]);
    this.flushPath();
    this.subpaths.push(p);
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, rot = 0, a0 = 0, a1 = Math.PI * 2) {
    this.flushPath();
    const steps = Math.max(16, Math.ceil(Math.abs(a1 - a0) * 12));
    const p: Poly = [];
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      const ex = Math.cos(a) * rx, ey = Math.sin(a) * ry;
      const xr = ex * Math.cos(rot) - ey * Math.sin(rot), yr = ex * Math.sin(rot) + ey * Math.cos(rot);
      p.push(apply(this.state.m, cx + xr, cy + yr));
    }
    this.subpaths.push(p);
  }

  arc(cx: number, cy: number, r: number, a0: number, a1: number, ccw = false) {
    let s = a0, e = a1;
    if (!ccw && e < s) e += Math.PI * 2;
    if (ccw && e > s) e -= Math.PI * 2;
    this.ellipse(cx, cy, r, r, 0, s, e);
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    const [sx, sy] = this.cur;
    const p0: Point = [sx, sy], p1 = apply(this.state.m, cx, cy), p2 = apply(this.state.m, x, y);
    const steps = 16;
    const pts: Poly = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      pts.push([
        u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
        u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
      ]);
    }
    if (!this.path.length) this.path = [p0];
    this.path.push(...pts);
    this.cur = p2;
  }

  // ---- painting
  private coverage(): Float32Array {
    const cov = new Float32Array(this.width * this.height);
    for (const poly of this.subpaths) polygonCoverage(poly, this.width, this.height, cov);
    return cov;
  }

  private blend(cov: Float32Array, color: Rgba) {
    const a = color.a * this.state.globalAlpha;
    if (a <= 0) return;
    const d = this.data;
    for (let i = 0; i < cov.length; i++) {
      const c = cov[i];
      if (!c) continue;
      const alpha = c * a;
      const o = i * 4;
      d[o] = color.r * alpha + d[o] * (1 - alpha);
      d[o + 1] = color.g * alpha + d[o + 1] * (1 - alpha);
      d[o + 2] = color.b * alpha + d[o + 2] * (1 - alpha);
      d[o + 3] = 255 * alpha + d[o + 3] * (1 - alpha);
    }
  }

  fill() {
    this.flushPath();
    this.blend(this.coverage(), parseRgba(this.state.fillStyle));
  }

  stroke() {
    this.flushPath();
    const w = Math.max(0.1, this.state.lineWidth) / 2;
    const cov = new Float32Array(this.width * this.height);
    for (const poly of this.subpaths) {
      const pts = this.dash.length ? applyDash(poly, this.dash) : poly;
      for (let i = 1; i < pts.length; i++) segmentCoverage(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], w, this.width, this.height, cov);
      if (this.state.lineCap === "round" || this.state.lineJoin === "round") {
        for (const p of pts) discCoverage(p[0], p[1], w, this.width, this.height, cov);
      }
    }
    this.blend(cov, parseRgba(this.state.strokeStyle));
  }

  fillRect(x: number, y: number, w: number, h: number) {
    const p: Poly = [apply(this.state.m, x, y), apply(this.state.m, x + w, y), apply(this.state.m, x + w, y + h), apply(this.state.m, x, y + h)];
    const cov = new Float32Array(this.width * this.height);
    polygonCoverage(p, this.width, this.height, cov);
    this.blend(cov, parseRgba(this.state.fillStyle));
  }

  strokeRect(x: number, y: number, w: number, h: number) {
    this.beginPath();
    this.rect(x, y, w, h);
    this.stroke();
  }

  clearRect(x: number, y: number, w: number, h: number) {
    const p: Poly = [apply(this.state.m, x, y), apply(this.state.m, x + w, y), apply(this.state.m, x + w, y + h), apply(this.state.m, x, y + h)];
    const cov = new Float32Array(this.width * this.height);
    polygonCoverage(p, this.width, this.height, cov);
    for (let i = 0; i < cov.length; i++) if (cov[i]) { const o = i * 4; this.data[o] = 0; this.data[o + 1] = 0; this.data[o + 2] = 0; this.data[o + 3] = 0; }
  }

  // ---- text
  measureText(text: string): { width: number } {
    const px = fontSize(this.state.font);
    return { width: measureTextWidth(text, px) };
  }

  fillText(text: string, x: number, y: number) {
    const px = fontSize(this.state.font);
    const width = measureTextWidth(text, px);
    let cx = x;
    if (this.state.textBaseline === "middle") y -= px * 0.5;
    else if (this.state.textBaseline === "bottom" || this.state.textBaseline === "alphabetic") y -= px * 0.8;
    const scale = px / FONT_CELL_H;
    const advance = FONT_CELL_W * scale;
    for (const ch of text) {
      const glyph = glyphFor(ch);
      if (glyph) {
        for (let gy = 0; gy < FONT_CELL_H; gy++) {
          for (let gx = 0; gx < FONT_CELL_W; gx++) {
            if (!glyph[gy * FONT_CELL_W + gx]) continue;
            const px0 = cx + gx * scale, py0 = y + gy * scale;
            this.fillRect(px0, py0, Math.ceil(scale), Math.ceil(scale));
          }
        }
      }
      cx += advance;
    }
    return width;
  }

  /** Pixel data of the canvas (RGBA). */
  imageData(): Uint8ClampedArray { return this.data; }
}

function applyDash(poly: Poly, dash: number[]): Poly {
  const out: Poly = [];
  let idx = 0, rem = dash[0] || 1, on = true;
  for (let i = 1; i < poly.length; i++) {
    let [x0, y0] = poly[i - 1];
    const [x1, y1] = poly[i];
    let seg = Math.hypot(x1 - x0, y1 - y0);
    if (seg <= 0) continue;
    const ux = (x1 - x0) / seg, uy = (y1 - y0) / seg;
    while (seg > 0) {
      const step = Math.min(seg, rem);
      if (on) {
        out.push([x0, y0]);
        out.push([x0 + ux * step, y0 + uy * step]);
      }
      x0 += ux * step; y0 += uy * step; seg -= step; rem -= step;
      if (rem <= 1e-9) {
        idx = (idx + 1) % dash.length;
        rem = dash[idx] || 1;
        on = !on;
      }
    }
  }
  return out;
}

function fontSize(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font || "");
  return m ? parseFloat(m[1]) : 10;
}

// The built-in bitmap font (generated by scripts/gen_bitmap_font.py from DejaVu Sans Mono).
import { FONT_CELL_H, FONT_CELL_W, FONT_DATA } from "./font";

function glyphFor(ch: string): Uint8Array | null {
  const code = ch.charCodeAt(0);
  if (code < 32 || code > 126) return null;
  const idx = code - 32;
  const start = idx * FONT_CELL_H * FONT_CELL_W;
  if (start + FONT_CELL_H * FONT_CELL_W > FONT_DATA.length) return null;
  return FONT_DATA.subarray(start, start + FONT_CELL_H * FONT_CELL_W);
}

function measureTextWidth(text: string, px: number): number {
  const scale = px / FONT_CELL_H;
  return text.length * FONT_CELL_W * scale;
}

/** Text label with an optional translucent background box (the browser reference draws it on the canvas). */
export function label(ctx: RasterContext, text: string, x: number, y: number, size: number, color: string, bg: string | null, font = FONT_FAMILY.sans, bold = true) {
  ctx.font = `${bold ? "bold " : ""}${size}px ${font}`;
  const lines = text.split("\n");
  const lh = size * 1.2;
  const wMax = Math.max(...lines.map((l) => ctx.measureText(l).width));
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(x - size * 0.25, y - size * 0.15, wMax + size * 0.5, lh * lines.length + size * 0.1); }
  ctx.fillStyle = color;
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lh));
}

export function arrowHead(ctx: RasterContext, x1: number, y1: number, x2: number, y2: number, size: number) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(a - Math.PI / 7), y2 - size * Math.sin(a - Math.PI / 7));
  ctx.lineTo(x2 - size * Math.cos(a + Math.PI / 7), y2 - size * Math.sin(a + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

/**
 * Draw on a float frame and composite the result: pixels outside the drawing keep their exact values.
 * The canvas alpha is blended over the float data, exactly like the browser reference.
 */
export function overlay(f: Frame, draw: (ctx: RasterContext) => void): Frame {
  const c = new RasterContext(f.w, f.h);
  draw(c);
  const img = c.imageData();
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

/** A canvas of the given size, for code that paints into one (the synthetic test material). */
export function createCanvas(w: number, h: number): { width: number; height: number; getContext(id: "2d"): RasterContext } {
  const ctx = new RasterContext(w, h);
  return { width: w, height: h, getContext: () => ctx };
}
