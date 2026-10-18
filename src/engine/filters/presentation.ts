// Annotation, redaction, presentation and measurement filters.
import type { Pt } from "../../shared/types";
import { alloc, cropFrame, type Frame } from "../frame";
import { gaussianBlur } from "../kernels/conv";
import { arrowHead, FONT_FAMILY, hexA, label, overlay } from "../kernels/draw";
import { applyH, homography, resize, type Interp } from "../kernels/geometry";
import { clampFrameIndex, mapStream, needInput, type FilterImpl } from "../stream";

const corner = (pos: string, W: number, H: number, w: number, h: number, m: number): [number, number] => {
  switch (pos) {
    case "tl": return [m, m];
    case "tr": return [W - w - m, m];
    case "bl": return [m, H - h - m];
    default: return [W - w - m, H - h - m];
  }
};

export function fmtTime(t: number): string {
  if (!isFinite(t)) t = 0;
  const neg = t < 0; t = Math.abs(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), ms = Math.round((t - Math.floor(t)) * 1000) % 1000;
  return `${neg ? "-" : ""}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

const addText: FilterImpl = (input, p) => mapStream(input, (f) => overlay(f, (c) => {
  const pos = p.position ?? { x: 20, y: 20 };
  label(c, String(p.text ?? ""), pos.x, pos.y, p.size, p.color, p.background ? hexA(p.bgColor, p.bgOpacity) : null, FONT_FAMILY[p.font] ?? FONT_FAMILY.sans, p.bold);
}));

const addShape: FilterImpl = (input, p) => {
  const s = needInput(input);
  return mapStream(s, (f, i) => {
    const from = clampFrameIndex(p.from, s.info.frameCount), to = clampFrameIndex(p.to, s.info.frameCount, true);
    if (i < from || i > to) return f;
    return overlay(f, (c) => {
      c.lineWidth = p.thickness;
      c.strokeStyle = p.borderColor;
      c.fillStyle = p.borderColor;
      if (p.shape === "rectangle" || p.shape === "ellipse") {
        const r = p.rect;
        if (!r) return;
        c.beginPath();
        if (p.shape === "rectangle") c.rect(r.x, r.y, r.w, r.h);
        else c.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.abs(r.w / 2), Math.abs(r.h / 2), 0, 0, Math.PI * 2);
        if (p.fill) { c.fillStyle = hexA(p.fillColor, p.fillOpacity); c.fill(); }
        if (p.thickness > 0) c.stroke();
      } else {
        const l: [Pt, Pt] | null = p.line;
        if (!l) return;
        c.beginPath(); c.moveTo(l[0].x, l[0].y); c.lineTo(l[1].x, l[1].y); c.stroke();
        const hs = Math.max(8, p.thickness * 4);
        if (p.shape === "arrow" || p.shape === "double_arrow") arrowHead(c, l[0].x, l[0].y, l[1].x, l[1].y, hs);
        if (p.shape === "double_arrow") arrowHead(c, l[1].x, l[1].y, l[0].x, l[0].y, hs);
      }
    });
  });
};

function regionMask(w: number, h: number, r: { x: number; y: number; w: number; h: number }, ellipse: boolean, feather = 0): Float32Array {
  const m = new Float32Array(w * h);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rx = Math.abs(r.w / 2), ry = Math.abs(r.h / 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let dist: number; // signed distance-ish (negative inside)
    if (ellipse) { const nx = (x + 0.5 - cx) / (rx || 1), ny = (y + 0.5 - cy) / (ry || 1); dist = (Math.sqrt(nx * nx + ny * ny) - 1) * Math.min(rx, ry); }
    else dist = Math.max(Math.abs(x + 0.5 - cx) - rx, Math.abs(y + 0.5 - cy) - ry);
    m[y * w + x] = feather > 0 ? Math.min(1, Math.max(0, 0.5 - dist / feather)) : dist <= 0 ? 1 : 0;
  }
  return m;
}

const hideSelection: FilterImpl = (input, p) => mapStream(input, (f) => {
  const r = p.rect;
  if (!r || r.w < 1 || r.h < 1) return f;
  let hidden: Frame;
  if (p.mode === "fill") {
    hidden = alloc(f.w, f.h, true);
    const n = parseInt(String(p.color).replace("#", ""), 16) || 0;
    for (let k = 0; k < hidden.d.length; k += 4) { hidden.d[k] = (n >> 16) & 255; hidden.d[k + 1] = (n >> 8) & 255; hidden.d[k + 2] = n & 255; }
  } else if (p.mode === "blur") hidden = gaussianBlur(f, Math.max(1, p.strength / 2));
  else {
    hidden = alloc(f.w, f.h, true);
    const B = Math.max(2, p.strength | 0);
    for (let by = 0; by < f.h; by += B) for (let bx = 0; bx < f.w; bx += B) {
      let rr = 0, gg = 0, bb = 0, c = 0;
      for (let y = by; y < Math.min(f.h, by + B); y++) for (let x = bx; x < Math.min(f.w, bx + B); x++) { const k = (y * f.w + x) * 4; rr += f.d[k]; gg += f.d[k + 1]; bb += f.d[k + 2]; c++; }
      for (let y = by; y < Math.min(f.h, by + B); y++) for (let x = bx; x < Math.min(f.w, bx + B); x++) { const k = (y * f.w + x) * 4; hidden.d[k] = rr / c; hidden.d[k + 1] = gg / c; hidden.d[k + 2] = bb / c; }
    }
  }
  const m = regionMask(f.w, f.h, r, p.shape === "ellipse");
  const out = new Float32Array(f.d);
  for (let i = 0; i < m.length; i++) if (m[i] > 0) { const k = i * 4; for (let c = 0; c < 3; c++) out[k + c] = f.d[k + c] * (1 - m[i]) + hidden.d[k + c] * m[i]; }
  return { w: f.w, h: f.h, d: out };
});

const spotlight: FilterImpl = (input, p) => mapStream(input, (f) => {
  const r = p.rect;
  if (!r || r.w < 1 || r.h < 1) return f;
  const m = regionMask(f.w, f.h, r, p.shape === "ellipse", p.feather);
  const out = new Float32Array(f.d);
  for (let i = 0; i < m.length; i++) { const k = i * 4, g = 1 - p.dim * (1 - m[i]); out[k] *= g; out[k + 1] *= g; out[k + 2] *= g; }
  const res = { w: f.w, h: f.h, d: out };
  if (!p.border) return res;
  return overlay(res, (c) => {
    c.strokeStyle = p.borderColor; c.lineWidth = 2; c.beginPath();
    if (p.shape === "ellipse") c.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.abs(r.w / 2), Math.abs(r.h / 2), 0, 0, Math.PI * 2); else c.rect(r.x, r.y, r.w, r.h);
    c.stroke();
  });
});

const magnify: FilterImpl = (input, p) => mapStream(input, (f) => {
  const r = p.rect;
  if (!r || r.w < 2 || r.h < 2) return f;
  const src = cropFrame(f, r.x, r.y, r.w, r.h);
  let iw = Math.round(r.w * p.zoom), ih = Math.round(r.h * p.zoom);
  const maxW = f.w * 0.6, maxH = f.h * 0.6;
  const s = Math.min(1, maxW / iw, maxH / ih);
  iw = Math.max(4, Math.round(iw * s)); ih = Math.max(4, Math.round(ih * s));
  const inset = resize(src, iw, ih, p.interp as Interp);
  const [x0, y0] = corner(p.position, f.w, f.h, iw, ih, 10 + p.border);
  const out = new Float32Array(f.d);
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
    const X = x0 + x, Y = y0 + y;
    if (X < 0 || Y < 0 || X >= f.w || Y >= f.h) continue;
    const o = (Y * f.w + X) * 4, q = (y * iw + x) * 4;
    out[o] = inset.d[q]; out[o + 1] = inset.d[q + 1]; out[o + 2] = inset.d[q + 2];
  }
  return overlay({ w: f.w, h: f.h, d: out }, (c) => {
    if (!p.border) return;
    c.strokeStyle = p.borderColor; c.lineWidth = p.border;
    c.strokeRect(x0 - p.border / 2, y0 - p.border / 2, iw + p.border, ih + p.border);
    c.lineWidth = Math.max(1, p.border / 2);
    c.strokeRect(r.x, r.y, r.w, r.h);
    c.setLineDash([4, 4]);
    c.beginPath(); c.moveTo(r.x + r.w / 2, r.y + r.h / 2); c.lineTo(x0 + iw / 2, y0 + ih / 2); c.stroke();
  });
});

const addTimestamp: FilterImpl = (input, p) => {
  const s = needInput(input);
  const start = Date.parse(String(p.start).replace(" ", "T") + (/(Z|[+-]\d\d:?\d\d)$/.test(p.start) ? "" : "Z"));
  return mapStream(s, (f, i) => {
    const pts = s.meta(i).pts ?? i / s.info.fps;
    let text: string;
    if (p.format === "frame") text = `Frame ${i}`;
    else if (p.format === "time") text = fmtTime(pts);
    else if (p.format === "datetime") text = isFinite(start) ? new Date(start + pts * 1000).toISOString().replace("T", " ").replace("Z", "") : fmtTime(pts);
    else text = `Frame ${i}   ${fmtTime(pts)}`;
    return overlay(f, (c) => {
      c.font = `bold ${p.size}px ${FONT_FAMILY.mono}`;
      const tw = c.measureText(text).width;
      const [x, y] = corner(p.position, f.w, f.h, tw, p.size * 1.2, 10);
      label(c, text, x, y, p.size, p.color, p.background ? "rgba(0,0,0,0.65)" : null, FONT_FAMILY.mono, true);
    });
  });
};

const addLogo: FilterImpl = async (input, p, ctx) => {
  const s = needInput(input);
  if (!p.image) return s;
  const logo = await ctx.source(p.image).getFrame(0);
  const { width: W, height: H } = s.info;
  const lw = Math.max(4, Math.round((W * p.scale) / 100)), lh = Math.max(4, Math.round((lw * logo.h) / logo.w));
  const L = resize(logo, lw, lh, "bicubic");
  const [x0, y0] = corner(p.position, W, H, lw, lh, p.margin);
  return mapStream(s, (f) => {
    const out = new Float32Array(f.d);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      const X = x0 + x, Y = y0 + y;
      if (X < 0 || Y < 0 || X >= f.w || Y >= f.h) continue;
      const o = (Y * f.w + X) * 4, q = (y * lw + x) * 4, a = (L.d[q + 3] / 255) * p.opacity;
      for (let c = 0; c < 3; c++) out[o + c] += (L.d[q + c] - out[o + c]) * a;
    }
    return { w: f.w, h: f.h, d: out };
  });
};

const addGrid: FilterImpl = (input, p) => mapStream(input, (f) => overlay(f, (c) => {
  c.strokeStyle = hexA(p.color, p.opacity);
  c.lineWidth = p.thickness;
  c.beginPath();
  for (let x = 0; x <= f.w; x += p.spacing) { c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, f.h); }
  for (let y = 0; y <= f.h; y += p.spacing) { c.moveTo(0, y + 0.5); c.lineTo(f.w, y + 0.5); }
  c.stroke();
  if (p.labels) {
    c.fillStyle = hexA(p.color, Math.min(1, p.opacity + 0.3));
    c.font = `10px ${FONT_FAMILY.mono}`;
    for (let x = 0; x <= f.w; x += p.spacing) c.fillText(String(x), x + 2, 10);
    for (let y = p.spacing; y <= f.h; y += p.spacing) c.fillText(String(y), 2, y - 2);
  }
}));

// ---------------------------------------------------------------- measurement
const len = (l: [Pt, Pt]) => Math.hypot(l[1].x - l[0].x, l[1].y - l[0].y);

function drawSegment(c: OffscreenCanvasRenderingContext2D, l: [Pt, Pt], color: string, text: string, size: number, dashed = false) {
  c.strokeStyle = color; c.fillStyle = color; c.lineWidth = Math.max(1.5, size / 8);
  c.setLineDash(dashed ? [6, 4] : []);
  c.beginPath(); c.moveTo(l[0].x, l[0].y); c.lineTo(l[1].x, l[1].y); c.stroke();
  c.setLineDash([]);
  for (const q of l) { c.beginPath(); c.arc(q.x, q.y, Math.max(2.5, size / 6), 0, Math.PI * 2); c.fill(); }
  if (text) label(c, text, (l[0].x + l[1].x) / 2 + 8, (l[0].y + l[1].y) / 2 + 6, size, color, "rgba(0,0,0,0.65)");
}

const measure1d: FilterImpl = (input, p) => mapStream(input, (f) => overlay(f, (c) => {
  if (p.refLine) drawSegment(c, p.refLine, "#ffffff", `Reference: ${Number(p.refLength).toFixed(3)} ${p.unit}`, p.size * 0.85, true);
  if (p.line) {
    const scale = p.refLine && len(p.refLine) > 0 ? p.refLength / len(p.refLine) : 0;
    const txt = scale ? `${(len(p.line) * scale).toFixed(3)} ${p.unit}` : `${len(p.line).toFixed(1)} px`;
    drawSegment(c, p.line, p.color, txt, p.size);
  }
}));

const measure2d: FilterImpl = (input, p) => mapStream(input, (f) => overlay(f, (c) => {
  const q: Pt[] = p.refPoints || [];
  if (q.length >= 2) {
    c.strokeStyle = "#ffffff"; c.lineWidth = 1.5; c.setLineDash([6, 4]); c.beginPath();
    q.forEach((pt, i) => (i ? c.lineTo(pt.x, pt.y) : c.moveTo(pt.x, pt.y)));
    if (q.length === 4) c.closePath();
    c.stroke(); c.setLineDash([]);
  }
  if (q.length === 4 && p.line) {
    try {
      const H = homography(q, [{ x: 0, y: 0 }, { x: p.refWidth, y: 0 }, { x: p.refWidth, y: p.refHeight }, { x: 0, y: p.refHeight }]);
      const a = applyH(H, p.line[0].x, p.line[0].y), b = applyH(H, p.line[1].x, p.line[1].y);
      drawSegment(c, p.line, p.color, `${Math.hypot(b[0] - a[0], b[1] - a[1]).toFixed(3)} ${p.unit}`, p.size);
    } catch { drawSegment(c, p.line, p.color, "invalid reference", p.size); }
  } else if (p.line) drawSegment(c, p.line, p.color, `${len(p.line).toFixed(1)} px`, p.size);
}));

export const presentationFilters: Record<string, FilterImpl> = {
  add_text: addText, add_shape: addShape, hide_selection: hideSelection, spotlight, magnify, add_timestamp: addTimestamp, add_logo: addLogo, add_grid: addGrid,
  measure_1d: measure1d, measure_2d: measure2d,
};
