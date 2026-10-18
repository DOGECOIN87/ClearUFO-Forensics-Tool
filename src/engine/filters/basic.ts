// Frame-wise filter implementations.
import type { ParamValues, Pt } from "../../shared/types";
import { jpegRoundTrip } from "../kernels/jpeg";
import { psfForFilter } from "../../shared/psf";
import { alloc, clone, cropFrame, grayFrame, luma, merge, parseColor, split, type Frame } from "../frame";
import { applyLuts, clahe, clamp255, histogramPlane, hslToRgb, Lut, percentileFromHist, rgbToHsl, rgbToHsv, rgbToLab, rgbToXyz, ycbcr, ycbcrToRgb, equalizeMap } from "../kernels/color";
import { brightnessContrastLut, curveFunction, exposureLut, levelsLut } from "./luts";
export { curveFunction };
import { bilateralP, blurPlane, boxBlur, boxBlurPlane, conv3x3, deblock, gaussianBlur, gaussianBlurP, mapRGB, medianP, nlMeansP, wienerP } from "../kernels/conv";
import { overlay } from "../kernels/draw";
import { deconvolveP, fourierFilter, spectrumOf, type DeconvMethod } from "../kernels/fft";
import { homography, resize, warp, type Interp } from "../kernels/geometry";
import { SyntheticSource } from "../sources/synthetic";
import { mapStream, needInput, type FilterImpl, type Stream } from "../stream";

// ---------------------------------------------------------------- loaders
const fileLoader: FilterImpl = async (_input, p, ctx) => {
  if (!p.source) throw new Error("No file selected. Use Browse to choose a file.");
  const base = ctx.source(p.source);
  // automatic fallback to the browser media element when WebCodecs cannot decode the codec
  let src = base;
  if (p.engine === "media" || base.decodable === false) {
    try { src = await ctx.mediaSource(p.source); }
    catch {
      const codec = (base.info.codec ?? "this").toUpperCase();
      throw new Error(`This browser cannot decode the ${codec} video (neither WebCodecs nor the media element support it). Open the project in Chrome, Edge or Safari, or transcode the file.`);
    }
  }
  // (a loader without "chroma" comes from a project saved before the option existed: keep its replicate decoding)
  // (likewise a loader without "hdr": HDR signal values were shown as decoded)
  const opts = { colorRange: p.colorRange, matrix: p.matrix, chroma: p.chroma ?? "nearest", siting: p.siting ?? "auto", hdr: p.hdr ?? "none", hdrPeak: p.hdrPeak ?? 1000 };
  const par = src.info.par && src.info.par[1] ? src.info.par[0] / src.info.par[1] : 1;
  const fps = p.fps && src.info.kind === "sequence" ? p.fps : src.info.fps;
  return {
    info: { width: src.info.width, height: src.info.height, frameCount: src.info.frameCount, fps, par },
    getFrame: (i) => src.getFrame(i, opts),
    meta: (i) => (src.info.kind === "sequence" ? { ...src.meta(i), pts: i / fps } : src.meta(i)),
  };
};

const testPattern: FilterImpl = (_input, p, ctx) => {
  const s = new SyntheticSource(ctx.key, p);
  return { info: { width: s.info.width, height: s.info.height, frameCount: s.info.frameCount, fps: s.info.fps, par: 1 }, getFrame: (i) => s.getFrame(i), meta: (i) => s.meta(i) };
};

// ---------------------------------------------------------------- channels
const lumaW = (m: string): [number, number, number] => (m === "bt709" ? [0.2126, 0.7152, 0.0722] : [0.299, 0.587, 0.114]);

const grayscale: FilterImpl = (input, p) => mapStream(input, (f) => {
  const [wr, wg, wb] = lumaW(p.method);
  const method = p.method;
  const d = f.d, o = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    o[i + 3] = d[i + 3];
    let v: number;
    switch (method) {
      case "average": v = (r + g + b) / 3; break;
      case "lightness": v = (Math.max(r, g, b) + Math.min(r, g, b)) / 2; break;
      case "max": v = Math.max(r, g, b); break;
      case "min": v = Math.min(r, g, b); break;
      default: v = wr * r + wg * g + wb * b;
    }
    o[i] = o[i + 1] = o[i + 2] = v;
  }
  return { w: f.w, h: f.h, d: o };
});

const colorConversion: FilterImpl = (input, p) => mapStream(input, (f) => {
  const space = p.space;
  const d = f.d, o = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    o[i + 3] = d[i + 3];
  let c: [number, number, number];
  switch (space) {
    case "ycbcr709": c = ycbcr(r, g, b, true); break;
    case "hsv": { const [h, s, v] = rgbToHsv(r, g, b); c = [(h / 360) * 255, s * 255, v * 255]; break; }
    case "hsl": { const [h, s, l] = rgbToHsl(r, g, b); c = [(h / 360) * 255, s * 255, l * 255]; break; }
    case "lab": { const [L, a, bb] = rgbToLab(r, g, b); c = [L * 2.55, a + 128, bb + 128]; break; }
    case "cmy": c = [255 - r, 255 - g, 255 - b]; break;
    case "xyz": { const [x, y, z] = rgbToXyz(r, g, b); c = [x * 255, y * 255, z * 255]; break; }
    default: c = ycbcr(r, g, b, false);
  }
  o[i] = c[0]; o[i + 1] = c[1]; o[i + 2] = c[2];
  }
  return { w: f.w, h: f.h, d: o };
});

const switchPick = (s: string, r: number, g: number, b: number) => (s === "r" ? r : s === "g" ? g : s === "b" ? b : s === "full" ? 255 : 0);
const colorSwitch: FilterImpl = (input, p) => mapStream(input, (f) => {
  const pr = p.r, pg = p.g, pb = p.b;
  const d = f.d, o = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    o[i + 3] = d[i + 3];
    o[i] = switchPick(pr, r, g, b); o[i + 1] = switchPick(pg, r, g, b); o[i + 2] = switchPick(pb, r, g, b);
  }
  return { w: f.w, h: f.h, d: o };
});

export function channelValue(ch: string, r: number, g: number, b: number): number {
  switch (ch) {
    case "r": return r;
    case "g": return g;
    case "b": return b;
    case "y": return 0.299 * r + 0.587 * g + 0.114 * b;
    case "cb": return ycbcr(r, g, b, false)[1];
    case "cr": return ycbcr(r, g, b, false)[2];
    case "h": return (rgbToHsv(r, g, b)[0] / 360) * 255;
    case "s": return rgbToHsv(r, g, b)[1] * 255;
    case "v": return rgbToHsv(r, g, b)[2] * 255;
    case "l": return rgbToLab(r, g, b)[0] * 2.55;
    case "a": return rgbToLab(r, g, b)[1] + 128;
    case "bb": return rgbToLab(r, g, b)[2] + 128;
    case "c": case "m": case "ye": case "k": {
      const k = 1 - Math.max(r, g, b) / 255;
      if (ch === "k") return k * 255;
      const den = 1 - k || 1;
      const v = ch === "c" ? (1 - r / 255 - k) / den : ch === "m" ? (1 - g / 255 - k) / den : (1 - b / 255 - k) / den;
      return v * 255;
    }
    default: return r;
  }
}

const extractChannel: FilterImpl = (input, p) => mapStream(input, (f) => {
  const n = f.w * f.h, plane = new Float32Array(n);
  for (let i = 0, k = 0; i < n; i++, k += 4) plane[i] = channelValue(p.channel, f.d[k], f.d[k + 1], f.d[k + 2]);
  if (p.stretch) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) { if (plane[i] < mn) mn = plane[i]; if (plane[i] > mx) mx = plane[i]; }
    const s = mx > mn ? 255 / (mx - mn) : 1;
    for (let i = 0; i < n; i++) plane[i] = (plane[i] - mn) * s;
  }
  return grayFrame(f.w, f.h, plane);
});

const enableChannels: FilterImpl = (input, p) => mapStream(input, (f) => {
  const er = !!p.r, eg = !!p.g, eb = !!p.b;
  const d = f.d, o = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    o[i + 3] = d[i + 3];
    o[i] = er ? r : 0; o[i + 1] = eg ? g : 0; o[i + 2] = eb ? b : 0;
  }
  return { w: f.w, h: f.h, d: o };
});

// ---------------------------------------------------------------- adjust

const levels: FilterImpl = (input, p) => {
  const lut = levelsLut(p);
  const pick = (c: string) => (p.channel === "all" || p.channel === c ? lut : null);
  return mapStream(input, (f) => applyLuts(f, pick("r"), pick("g"), pick("b")));
};

const curves: FilterImpl = (input, p) => {
  const lut = new Lut(curveFunction(p.curve));
  const pick = (c: string) => (p.channel === "all" || p.channel === c ? lut : null);
  return mapStream(input, (f) => applyLuts(f, pick("r"), pick("g"), pick("b")));
};

const brightnessContrast: FilterImpl = (input, p) => {
  const lut = brightnessContrastLut(p);
  return mapStream(input, (f) => applyLuts(f, lut, lut, lut));
};

const exposure: FilterImpl = (input, p) => {
  const lut = exposureLut(p);
  return mapStream(input, (f) => applyLuts(f, lut, lut, lut));
};

const autoContrast: FilterImpl = (input, p) => mapStream(input, (f) => {
  const planes = split(f), n = f.w * f.h;
  const range = (pl: Float32Array) => { const h = histogramPlane(pl); return [percentileFromHist(h, n, p.clipLow / 100), percentileFromHist(h, n, 1 - p.clipHigh / 100)]; };
  let luts: Lut[];
  if (p.linked) {
    const [lo, hi] = range(luma(f));
    const l = new Lut((v) => ((v - lo) / Math.max(1, hi - lo)) * 255);
    luts = [l, l, l];
  } else luts = [0, 1, 2].map((c) => { const [lo, hi] = range(planes[c]); return new Lut((v) => ((v - lo) / Math.max(1, hi - lo)) * 255); });
  return applyLuts(f, luts[0], luts[1], luts[2]);
});

const histEq: FilterImpl = (input, p) => mapStream(input, (f) => {
  const { w, h } = f, n = w * h, amt = p.amount;
  const eq = (pl: Float32Array) => {
    if (p.mode === "clahe") return clahe(pl, w, h, p.tiles, p.clip);
    const map = equalizeMap(histogramPlane(pl), n);
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) o[i] = map[Math.min(255, Math.max(0, Math.round(pl[i])))];
    return o;
  };
  if (p.target === "rgb") {
    const out = mapRGB(f, eq);
    if (amt < 1) for (let i = 0; i < out.d.length; i++) if ((i & 3) !== 3) out.d[i] = f.d[i] + (out.d[i] - f.d[i]) * amt;
    return out;
  }
  const Y = luma(f), Y2 = eq(Y);
  const d = f.d, o = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    o[i + 3] = d[i + 3];
    const k = i >> 2;
    const [, cb, cr] = ycbcr(r, g, b, false);
    const yy = Y[k] + (Y2[k] - Y[k]) * amt;
    const c = ycbcrToRgb(yy, cb, cr);
    o[i] = c[0]; o[i + 1] = c[1]; o[i + 2] = c[2];
  }
  return { w: f.w, h: f.h, d: o };
});

const whiteBalance: FilterImpl = (input, p) => mapStream(input, (f) => {
  let gains: [number, number, number] = [1, 1, 1];
  const d = f.d, n = f.w * f.h;
  if (p.mode === "manual") gains = [p.r, p.g, p.b];
  else if (p.mode === "grayworld") {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const m = (r + g + b) / 3;
    gains = [m / Math.max(1e-6, r), m / Math.max(1e-6, g), m / Math.max(1e-6, b)];
  } else if (p.mode === "whitepatch") {
    const [R, G, B] = split(f);
    const hi = (pl: Float32Array) => Math.max(1, percentileFromHist(histogramPlane(pl), n, 0.995));
    gains = [255 / hi(R), 255 / hi(G), 255 / hi(B)];
  } else if (p.mode === "point" && p.point) {
    const rad = p.radius | 0;
    let r = 0, g = 0, b = 0, c = 0;
    for (let y = Math.round(p.point.y) - rad; y <= Math.round(p.point.y) + rad; y++) for (let x = Math.round(p.point.x) - rad; x <= Math.round(p.point.x) + rad; x++) {
      if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
      const k = (y * f.w + x) * 4;
      r += d[k]; g += d[k + 1]; b += d[k + 2]; c++;
    }
    if (c) { const m = (r + g + b) / 3; gains = [m / Math.max(1e-6, r), m / Math.max(1e-6, g), m / Math.max(1e-6, b)]; }
  }
  const g0 = gains[0], g1 = gains[1], g2 = gains[2];
  const o = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) { o[i] = d[i] * g0; o[i + 1] = d[i + 1] * g1; o[i + 2] = d[i + 2] * g2; o[i + 3] = d[i + 3]; }
  return { w: f.w, h: f.h, d: o };
});

const hueSat: FilterImpl = (input, p) => mapStream(input, (f) => {
  const hue = p.hue, saturation = p.saturation, lightness = p.lightness;
  const d = f.d, o = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    o[i + 3] = d[i + 3];
    let [h, s, l] = rgbToHsl(clamp255(r), clamp255(g), clamp255(b));
    h += hue;
    s = Math.min(1, Math.max(0, s * (1 + saturation / 100)));
    l = lightness >= 0 ? l + (1 - l) * (lightness / 100) : l * (1 + lightness / 100);
    const c = hslToRgb(h, s, l);
    o[i] = c[0]; o[i + 1] = c[1]; o[i + 2] = c[2];
  }
  return { w: f.w, h: f.h, d: o };
});

const negative: FilterImpl = (input) => mapStream(input, (f) => {
  const d = f.d, o = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) { o[i] = 255 - d[i]; o[i + 1] = 255 - d[i + 1]; o[i + 2] = 255 - d[i + 2]; o[i + 3] = d[i + 3]; }
  return { w: f.w, h: f.h, d: o };
});

const threshold: FilterImpl = (input, p) => mapStream(input, (f) => {
  const rgb = p.mode === "rgb", level = p.level;
  const d = f.d, o = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    o[i + 3] = d[i + 3];
    if (rgb) { o[i] = r >= level ? 255 : 0; o[i + 1] = g >= level ? 255 : 0; o[i + 2] = b >= level ? 255 : 0; }
    else { const v = 0.299 * r + 0.587 * g + 0.114 * b >= level ? 255 : 0; o[i] = o[i + 1] = o[i + 2] = v; }
  }
  return { w: f.w, h: f.h, d: o };
});

// ---------------------------------------------------------------- extract
const fourier: FilterImpl = (input, p) => mapStream(input, (f) => grayFrame(f.w, f.h, spectrumOf(f, p.channel, p.mode, p.log)));

const fourierFilt: FilterImpl = (input, p) => mapStream(input, (f) => {
  if (p.view === "spectrum") {
    const spec = grayFrame(f.w, f.h, spectrumOf(f, "y", "magnitude", true));
    const pts: Pt[] = p.filter === "notch" ? p.points || [] : [];
    return overlay(spec, (ctx) => {
      ctx.lineWidth = 1.5;
      for (const pt of pts) {
        const marks = p.symmetric ? [pt, { x: f.w - pt.x, y: f.h - pt.y }] : [pt];
        marks.forEach((m, k) => { ctx.strokeStyle = k ? "rgba(255,170,0,0.8)" : "#ff3030"; ctx.beginPath(); ctx.arc(m.x, m.y, p.radius, 0, Math.PI * 2); ctx.stroke(); });
      }
      if (p.filter !== "notch") {
        ctx.strokeStyle = "#ffd400";
        ctx.beginPath();
        ctx.ellipse(f.w / 2, f.h / 2, p.cutoff * f.w, p.cutoff * f.h, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  }
  return fourierFilter(f, p as any);
});

const KERNELS: Record<string, [number[], number[]]> = {
  sobel: [[-1, 0, 1, -2, 0, 2, -1, 0, 1], [-1, -2, -1, 0, 0, 0, 1, 2, 1]],
  prewitt: [[-1, 0, 1, -1, 0, 1, -1, 0, 1], [-1, -1, -1, 0, 0, 0, 1, 1, 1]],
  scharr: [[-3, 0, 3, -10, 0, 10, -3, 0, 3], [-3, -10, -3, 0, 0, 0, 3, 10, 3]],
};

const gradient: FilterImpl = (input, p) => mapStream(input, (f) => {
  const { w, h } = f, Y = luma(f), n = w * h;
  if (p.operator === "laplacian") {
    const L = conv3x3(Y, w, h, [0, 1, 0, 1, -4, 1, 0, 1, 0]);
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) o[i] = p.output === "magnitude" ? Math.abs(L[i]) * p.gain : 128 + L[i] * p.gain;
    return grayFrame(w, h, o);
  }
  const [kx, ky] = KERNELS[p.operator] ?? KERNELS.sobel;
  const norm = p.operator === "scharr" ? 1 / 16 : p.operator === "prewitt" ? 1 / 3 : 1 / 4;
  const gx = conv3x3(Y, w, h, kx), gy = conv3x3(Y, w, h, ky);
  if (p.output === "direction") {
    const out = alloc(w, h, true);
    for (let i = 0; i < n; i++) {
      const mag = Math.min(1, (Math.hypot(gx[i], gy[i]) * norm * p.gain) / 128);
      const ang = ((Math.atan2(gy[i], gx[i]) * 180) / Math.PI + 360) % 360;
      const c = hslToRgb(ang, 1, mag * 0.5);
      out.d[i * 4] = c[0]; out.d[i * 4 + 1] = c[1]; out.d[i * 4 + 2] = c[2];
    }
    return out;
  }
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (p.output === "x") o[i] = 128 + gx[i] * norm * p.gain;
    else if (p.output === "y") o[i] = 128 + gy[i] * norm * p.gain;
    else o[i] = Math.hypot(gx[i], gy[i]) * norm * p.gain;
  }
  return grayFrame(w, h, o);
});

const bitPlane: FilterImpl = (input, p) => mapStream(input, (f) => {
  const channel = p.channel, bit = p.bit;
  const d = f.d, o = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    o[i + 3] = d[i + 3];
    const v = Math.round(clamp255(channelValue(channel, r, g, b)));
    o[i] = o[i + 1] = o[i + 2] = ((v >> bit) & 1) * 255;
  }
  return { w: f.w, h: f.h, d: o };
});

// ---------------------------------------------------------------- sharpen / denoise
const unsharp: FilterImpl = (input, p, ctx) => mapStream(input, async (f) => {
  const bl = await gaussianBlurP(f, p.radius, ctx.isStale), out = clone(f);
  for (let i = 0; i < out.d.length; i++) {
    if ((i & 3) === 3) continue;
    const diff = f.d[i] - bl.d[i];
    if (Math.abs(diff) >= p.threshold) out.d[i] = f.d[i] + p.amount * diff;
  }
  return out;
});

const laplacianSharp: FilterImpl = (input, p) => mapStream(input, (f) => {
  const k = p.diagonals ? [1, 1, 1, 1, -8, 1, 1, 1, 1] : [0, 1, 0, 1, -4, 1, 0, 1, 0];
  const s = p.diagonals ? p.amount / 2 : p.amount;
  return mapRGB(f, (pl) => { const L = conv3x3(pl, f.w, f.h, k); const o = new Float32Array(pl.length); for (let i = 0; i < pl.length; i++) o[i] = pl[i] - s * L[i]; return o; });
});

const highPass: FilterImpl = (input, p, ctx) => mapStream(input, async (f) => {
  // the blur of each channel is blurPlane's (gaussianBlurP), the arithmetic is the per-plane one of earlier versions
  const bl = (await gaussianBlurP(f, p.radius, ctx.isStale)).d, d = f.d, o = new Float32Array(d.length), amount = p.amount;
  for (let i = 0; i < d.length; i += 4) {
    o[i] = d[i] + amount * (d[i] - bl[i]); o[i + 1] = d[i + 1] + amount * (d[i + 1] - bl[i + 1]); o[i + 2] = d[i + 2] + amount * (d[i + 2] - bl[i + 2]);
    o[i + 3] = d[i + 3];
  }
  return { w: f.w, h: f.h, d: o };
});

// ---------------------------------------------------------------- deblurring
const deblur: FilterImpl = (input, p, ctx) => {
  const src = needInput(input);
  const type = (p as any).__type as string;
  const psf = psfForFilter(type, p);
  if (!psf) return src;
  return mapStream(src, (f) => deconvolveP(f, psf, p.method as DeconvMethod, p.noise, p.iterations ?? 25, (v) => ctx.progress("Deblurring", v), ctx.isStale));
};

// ---------------------------------------------------------------- verify
function fitInto(f: Frame, w: number, h: number): Frame {
  const s = Math.min(w / f.w, h / f.h);
  const nw = Math.max(1, Math.round(f.w * s)), nh = Math.max(1, Math.round(f.h * s));
  const r = resize(f, nw, nh, "bicubic");
  const out = alloc(w, h, true);
  const ox = (w - nw) >> 1, oy = (h - nh) >> 1;
  for (let y = 0; y < nh; y++) out.d.set(r.d.subarray(y * nw * 4, (y + 1) * nw * 4), ((y + oy) * w + ox) * 4);
  return out;
}

const compareOriginal: FilterImpl = async (input, p, ctx) => {
  const src = needInput(input);
  const orig = await ctx.originalStream();
  const { width: w, height: h } = src.info;
  const lt = Math.max(0, p.lineThickness | 0);
  const [lr, lg, lb] = parseColor(p.lineColor);
  const ow = p.mode === "sbs_h" ? w * 2 + lt : w, oh = p.mode === "sbs_v" ? h * 2 + lt : h;
  return {
    info: { ...src.info, width: ow, height: oh },
    meta: (i) => src.meta(i),
    getFrame: async (i) => {
      const proc = await src.getFrame(i);
      const oi = Math.min(orig.info.frameCount - 1, src.meta(i).src ?? i);
      const o0 = await orig.getFrame(oi);
      const of = p.mode === "sbs_h" || p.mode === "sbs_v" ? fitInto(o0, w, h) : o0.w === w && o0.h === h ? o0 : resize(o0, w, h, "bicubic");
      const out = alloc(ow, oh, true);
      const put = (src2: Frame, ox: number, oy: number) => { for (let y = 0; y < src2.h; y++) out.d.set(src2.d.subarray(y * src2.w * 4, (y + 1) * src2.w * 4), ((y + oy) * ow + ox) * 4); };
      const fillLine = (x0: number, y0: number, lw: number, lh: number) => {
        for (let y = y0; y < y0 + lh; y++) for (let x = x0; x < x0 + lw; x++) { if (x < 0 || y < 0 || x >= ow || y >= oh) continue; const k = (y * ow + x) * 4; out.d[k] = lr; out.d[k + 1] = lg; out.d[k + 2] = lb; }
      };
      const first = p.originalFirst ? of : proc, second = p.originalFirst ? proc : of;
      switch (p.mode) {
        case "sbs_h": put(first, 0, 0); put(second, w + lt, 0); fillLine(w, 0, lt, h); break;
        case "sbs_v": put(first, 0, 0); put(second, 0, h + lt); fillLine(0, h, w, lt); break;
        case "blend": for (let k = 0; k < out.d.length; k++) out.d[k] = (k & 3) === 3 ? 255 : of.d[k] * (1 - p.balance) + proc.d[k] * p.balance; break;
        case "difference": for (let k = 0; k < out.d.length; k++) out.d[k] = (k & 3) === 3 ? 255 : Math.abs(proc.d[k] - of.d[k]) * p.gain; break;
        case "wipe_h": case "wipe_v": {
          const split2 = p.mode === "wipe_h" ? Math.round(p.balance * w) : Math.round(p.balance * h);
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const k = (y * w + x) * 4;
            const useFirst = p.mode === "wipe_h" ? x < split2 : y < split2;
            const s = useFirst ? first : second;
            out.d[k] = s.d[k]; out.d[k + 1] = s.d[k + 1]; out.d[k + 2] = s.d[k + 2];
          }
          if (lt) p.mode === "wipe_h" ? fillLine(split2 - (lt >> 1), 0, lt, h) : fillLine(0, split2 - (lt >> 1), w, lt);
          break;
        }
      }
      return out;
    },
  };
};

// Error Level Analysis: difference between the image and its JPEG re-compression. The built-in JPEG model
// (kernels/jpeg.ts) replaces the browser's encoder/decoder, which differ between browsers and platforms.
const ela: FilterImpl = (input, p) => mapStream(input, (f) => {
  const re = jpegRoundTrip(f, p.quality, p.chroma === "444" ? "444" : "420");
  const scale = p.scale, q = re.d;
  const d = f.d, o = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    o[i + 3] = d[i + 3];
    o[i] = Math.abs(Math.min(255, Math.max(0, Math.round(r))) - q[i]) * scale;
    o[i + 1] = Math.abs(Math.min(255, Math.max(0, Math.round(g))) - q[i + 1]) * scale;
    o[i + 2] = Math.abs(Math.min(255, Math.max(0, Math.round(b))) - q[i + 2]) * scale;
  }
  return { w: f.w, h: f.h, d: o };
});

// ---------------------------------------------------------------- edit
const crop: FilterImpl = (input, p) => {
  const src = needInput(input);
  const r = p.rect;
  if (!r || r.w < 1 || r.h < 1) return src;
  const x = Math.max(0, Math.min(src.info.width - 1, Math.round(r.x))), y = Math.max(0, Math.min(src.info.height - 1, Math.round(r.y)));
  const w = Math.max(1, Math.min(src.info.width - x, Math.round(r.w))), h = Math.max(1, Math.min(src.info.height - y, Math.round(r.h)));
  return mapStream(src, (f) => cropFrame(f, x, y, w, h), { width: w, height: h });
};

const resizeF: FilterImpl = (input, p) => {
  const src = needInput(input);
  let nw: number, nh: number;
  if (p.mode === "size") { nw = p.width; nh = p.keepAspect ? Math.round((p.width * src.info.height) / src.info.width) : p.height; }
  else { nw = Math.round((src.info.width * p.scale) / 100); nh = Math.round((src.info.height * p.scale) / 100); }
  nw = Math.max(1, Math.min(16384, nw)); nh = Math.max(1, Math.min(16384, nh));
  return mapStream(src, (f) => resize(f, nw, nh, p.interp as Interp), { width: nw, height: nh });
};

const rotate: FilterImpl = (input, p) => {
  const src = needInput(input);
  const a = (p.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const { width: w, height: h } = src.info;
  const ow = p.expand ? Math.ceil(Math.abs(w * c) + Math.abs(h * s)) : w, oh = p.expand ? Math.ceil(Math.abs(w * s) + Math.abs(h * c)) : h;
  const bg = parseColor(p.background);
  return mapStream(src, (f) => warp(f, ow, oh, (x, y, q) => {
    const dx = x - ow / 2 + 0.5, dy = y - oh / 2 + 0.5;
    q[0] = c * dx + s * dy + w / 2 - 0.5; q[1] = -s * dx + c * dy + h / 2 - 0.5;
  }, p.interp as Interp, bg), { width: ow, height: oh });
};

const flip: FilterImpl = (input, p) => mapStream(input, (f) => {
  const out = alloc(f.w, f.h, false);
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
    const sx = p.horizontal ? f.w - 1 - x : x, sy = p.vertical ? f.h - 1 - y : y;
    const s = (sy * f.w + sx) * 4, o = (y * f.w + x) * 4;
    out.d[o] = f.d[s]; out.d[o + 1] = f.d[s + 1]; out.d[o + 2] = f.d[s + 2]; out.d[o + 3] = f.d[s + 3];
  }
  return out;
});

const perspective: FilterImpl = (input, p) => {
  const src = needInput(input);
  const pts: Pt[] = p.points || [];
  if (pts.length < 4) return src;
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const ow = p.outWidth > 0 ? p.outWidth : Math.max(2, Math.round((d(pts[0], pts[1]) + d(pts[3], pts[2])) / 2));
  const oh = p.outHeight > 0 ? p.outHeight : Math.max(2, Math.round((d(pts[0], pts[3]) + d(pts[1], pts[2])) / 2));
  const H = homography([{ x: 0, y: 0 }, { x: ow - 1, y: 0 }, { x: ow - 1, y: oh - 1 }, { x: 0, y: oh - 1 }], pts.slice(0, 4));
  return mapStream(src, (f) => warp(f, ow, oh, (x, y, q) => {
    const wq = H[6] * x + H[7] * y + H[8];
    q[0] = (H[0] * x + H[1] * y + H[2]) / wq; q[1] = (H[3] * x + H[4] * y + H[5]) / wq;
  }, p.interp as Interp), { width: ow, height: oh });
};

const lens: FilterImpl = (input, p) => mapStream(input, (f) => {
  const cx = p.cx * f.w, cy = p.cy * f.h, R = Math.hypot(f.w / 2, f.h / 2);
  return warp(f, f.w, f.h, (x, y, q) => {
    const nx = (x - cx) / R / p.zoom, ny = (y - cy) / R / p.zoom, r2 = nx * nx + ny * ny;
    const k = 1 + p.k1 * r2 + p.k2 * r2 * r2;
    q[0] = cx + nx * k * R; q[1] = cy + ny * k * R;
  }, p.interp as Interp);
});

const aspect: FilterImpl = (input, p) => {
  const src = needInput(input);
  const par = p.mode === "custom" ? p.par : p.mode === "pal" ? 12 / 11 : p.mode === "ntsc" ? 10 / 11 : p.mode === "half" ? 2 : src.info.par || 1;
  const { width: w, height: h } = src.info;
  const nw = p.direction === "width" ? Math.max(1, Math.round(w * par)) : w;
  const nh = p.direction === "height" ? Math.max(1, Math.round(h / par)) : h;
  if (nw === w && nh === h) return src;
  return mapStream(src, (f) => resize(f, nw, nh, p.interp as Interp), { width: nw, height: nh, par: 1 });
};

// ---------------------------------------------------------------- deinterlacing (frame-wise)
export function deinterlaceFrame(f: Frame, keepTop: boolean, method: string): Frame {
  const { w, h } = f, out = clone(f), d = f.d, o = out.d, row = w * 4;
  const keep = keepTop ? 0 : 1;
  for (let y = 0; y < h; y++) {
    if ((y & 1) === keep) continue;
    const up = y - 1 >= 0 ? y - 1 : y + 1, dn = y + 1 < h ? y + 1 : y - 1;
    for (let x = 0; x < row; x++) {
      if ((x & 3) === 3) continue;
      if (method === "duplicate") o[y * row + x] = d[up * row + x];
      else if (method === "blend") o[y * row + x] = (d[y * row + x] * 2 + d[up * row + x] + d[dn * row + x]) / 4;
      else o[y * row + x] = (d[up * row + x] + d[dn * row + x]) / 2;
    }
  }
  if (method === "blend") for (let y = 0; y < h; y++) {
    if ((y & 1) !== keep) continue;
    const up = Math.max(0, y - 1), dn = Math.min(h - 1, y + 1);
    for (let x = 0; x < row; x++) if ((x & 3) !== 3) o[y * row + x] = (d[y * row + x] * 2 + d[up * row + x] + d[dn * row + x]) / 4;
  }
  return out;
}

const lineDoubling: FilterImpl = (input, p) => mapStream(input, (f) => deinterlaceFrame(f, p.field === "top", "duplicate"));

const fieldShift: FilterImpl = (input, p) => mapStream(input, (f) => {
  const { w, h } = f, out = clone(f), keep = p.field === "top" ? 0 : 1;
  for (let y = keep; y < h; y += 2) {
    const sy = y - 2 * p.dy;
    for (let x = 0; x < w; x++) {
      const sx = x - p.dx;
      const o = (y * w + x) * 4;
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) { out.d[o] = out.d[o + 1] = out.d[o + 2] = 0; continue; }
      const s = (sy * w + sx) * 4;
      out.d[o] = f.d[s]; out.d[o + 1] = f.d[s + 1]; out.d[o + 2] = f.d[s + 2];
    }
  }
  return out;
});

// ---------------------------------------------------------------- registry (frame-wise)
export const basicFilters: Record<string, FilterImpl> = {
  image_loader: fileLoader, video_loader: fileLoader, sequence_loader: fileLoader, test_pattern: testPattern,
  grayscale, color_conversion: colorConversion, color_switch: colorSwitch, extract_channel: extractChannel, enable_channels: enableChannels,
  levels, curves, brightness_contrast: brightnessContrast, exposure, auto_contrast: autoContrast, histogram_equalization: histEq,
  white_balance: whiteBalance, hue_saturation: hueSat, negative, threshold,
  fourier, fourier_filter: fourierFilt, gradient, bit_plane: bitPlane,
  unsharp_mask: unsharp, laplacian_sharpening: laplacianSharp, high_pass_sharpening: highPass,
  averaging_filter: (input, p) => mapStream(input, (f) => boxBlur(f, p.radius)),
  gaussian_filter: (input, p, ctx) => mapStream(input, (f) => gaussianBlurP(f, p.sigma, ctx.isStale)),
  median_filter: (input, p, ctx) => mapStream(input, (f) => medianP(f, p.radius, ctx.isStale)),
  bilateral_filter: (input, p, ctx) => mapStream(input, (f) => bilateralP(f, p.sigmaS, p.sigmaR, ctx.isStale)),
  nl_means: (input, p, ctx) => mapStream(input, (f) => nlMeansP(f, p.h, p.patch, p.search, ctx.isStale)),
  wiener_filter: (input, p, ctx) => mapStream(input, (f) => wienerP(f, p.radius, p.noise, ctx.isStale)),
  deblocking: (input, p) => mapStream(input, (f) => deblock(f, p.block, p.strength, p.threshold)),
  motion_deblurring: deblur, optical_deblurring: deblur, gaussian_deblurring: deblur, nonlinear_deblurring: deblur,
  compare_original: compareOriginal, ela,
  crop, resize: resizeF, rotate, flip, correct_perspective: perspective, lens_distortion: lens, aspect_ratio: aspect,
  line_doubling: lineDoubling, field_shift: fieldShift,
};

export { boxBlurPlane };
