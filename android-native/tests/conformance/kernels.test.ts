// Conformance: the native kernels against the browser reference (src/engine/kernels).
//
// The browser implementation is the oracle: the native app must compute the same numbers, so the
// examiner gets the same result on the phone as on the workstation. The comparison is bit exact
// (Float32Array samples compared byte for byte).
import { describe, expect, it } from "vitest";

import * as refColor from "../../../src/engine/kernels/color";
import * as refConv from "../../../src/engine/kernels/conv";
import * as refFft from "../../../src/engine/kernels/fft";
import * as refGeometry from "../../../src/engine/kernels/geometry";
import * as refJpeg from "../../../src/engine/kernels/jpeg";
import * as refLuts from "../../../src/engine/filters/luts";

import * as natColor from "@/lib/engine/kernels/color";
import * as natConv from "@/lib/engine/kernels/conv";
import * as natFft from "@/lib/engine/kernels/fft";
import * as natGeometry from "@/lib/engine/kernels/geometry";
import * as natJpeg from "@/lib/engine/kernels/jpeg";
import * as natLuts from "@/lib/engine/filters/luts";

const same = (a: ArrayLike<number>, b: ArrayLike<number>, what: string) => {
  expect(a.length, `${what}: length`).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) {
      expect({ i, native: a[i], reference: b[i] }, `${what}: first difference`).toEqual({ i, native: a[i], reference: b[i] });
    }
  }
};

const plane = (w: number, h: number, seed = 1): Float32Array => {
  const p = new Float32Array(w * h);
  let s = seed;
  for (let i = 0; i < p.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    p[i] = (s >> 8) % 256;
  }
  return p;
};

describe("colour kernels", () => {
  it("converts the same way", () => {
    for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [12, 200, 77], [255, 0, 128]] as const) {
      same(refColor.rgbToHsv(r, g, b), natColor.rgbToHsv(r, g, b), "rgbToHsv");
      same(refColor.rgbToHsl(r, g, b), natColor.rgbToHsl(r, g, b), "rgbToHsl");
      same(refColor.rgbToXyz(r, g, b), natColor.rgbToXyz(r, g, b), "rgbToXyz");
      same(refColor.rgbToLab(r, g, b), natColor.rgbToLab(r, g, b), "rgbToLab");
      same(refColor.ycbcr(r, g, b, false), natColor.ycbcr(r, g, b, false), "ycbcr601");
      same(refColor.ycbcr(r, g, b, true), natColor.ycbcr(r, g, b, true), "ycbcr709");
      same(refColor.ycbcrToRgb(120, 128, 128, false), natColor.ycbcrToRgb(120, 128, 128, false), "ycbcrToRgb");
    }
  });

  it("applies the same lookup tables", () => {
    const p = { inBlack: 10, inWhite: 240, gamma: 2.2, outBlack: 4, outWhite: 250 };
    const a = refLuts.levelsLut(p);
    const b = natLuts.levelsLut(p);
    same(a.t, b.t, "levels table");
    for (let v = 0; v <= 255; v++) same([a.map(v)], [b.map(v)], `levels lut ${v}`);

    const curve = [{ x: 0, y: 0 }, { x: 64, y: 20 }, { x: 128, y: 140 }, { x: 255, y: 255 }];
    const c = new refColor.Lut(refLuts.curveFunction(curve));
    const d = new natColor.Lut(natLuts.curveFunction(curve));
    for (let v = 0; v <= 255; v++) same([c.map(v)], [d.map(v)], `curve lut ${v}`);

    const e = refLuts.brightnessContrastLut({ brightness: 12, contrast: 35 });
    const f = natLuts.brightnessContrastLut({ brightness: 12, contrast: 35 });
    same(e.t, f.t, "brightness/contrast table");

    const g = refLuts.exposureLut({ exposure: 1.5, gamma: 2.2, offset: 3 });
    const h = natLuts.exposureLut({ exposure: 1.5, gamma: 2.2, offset: 3 });
    same(g.t, h.t, "exposure table");
  });

  it("equalizes the same way", () => {
    const p = plane(32, 24);
    same(refColor.histogramPlane(p), natColor.histogramPlane(p), "histogram");
    same(refColor.equalizeMap(refColor.histogramPlane(p), p.length), natColor.equalizeMap(natColor.histogramPlane(p), p.length), "equalize map");
    same(refColor.clahe(p, 32, 24, 4, 3), natColor.clahe(p, 32, 24, 4, 3), "clahe");
  });
});

describe("convolution kernels", () => {
  it("blurs the same way", () => {
    const p = plane(40, 30);
    same(refConv.boxBlurPlane(p, 40, 30, 2), natConv.boxBlurPlane(p, 40, 30, 2), "box blur");
    same(refConv.gaussKernel(1.5), natConv.gaussKernel(1.5), "gaussian kernel");
    same(refConv.blurPlane(p, 40, 30, 1.2), natConv.blurPlane(p, 40, 30, 1.2), "gaussian blur (small sigma)");
    same(refConv.blurPlane(p, 40, 30, 6), natConv.blurPlane(p, 40, 30, 6), "gaussian blur (large sigma)");
    same(refConv.conv3x3(p, 40, 30, [0, 1, 0, 1, -4, 1, 0, 1, 0]), natConv.conv3x3(p, 40, 30, [0, 1, 0, 1, -4, 1, 0, 1, 0]), "3x3 convolution");
  });

  it("denoises the same way", () => {
    const p = plane(32, 32);
    same(refConv.medianPlane(p, 32, 32, 1), natConv.medianPlane(p, 32, 32, 1), "median 3x3");
    same(refConv.medianPlane(p, 32, 32, 2), natConv.medianPlane(p, 32, 32, 2), "median 5x5");
    same(refConv.wienerPlane(p, 32, 32, 2, 0), natConv.wienerPlane(p, 32, 32, 2, 0), "adaptive wiener");
    const f = { w: 32, h: 32, d: new Float32Array(32 * 32 * 4) };
    for (let i = 0; i < f.d.length; i++) f.d[i] = plane(32, 32)[i % (32 * 32)];
    same(refConv.bilateral(f, 2, 20).d, natConv.bilateral(f, 2, 20).d, "bilateral");
    same(refConv.nlMeans(f, 10, 1, 2).d, natConv.nlMeans(f, 10, 1, 2).d, "non-local means");
    same(refConv.deblock(f, 8, 0.6, 24).d, natConv.deblock(f, 8, 0.6, 24).d, "deblocking");
  });
});

describe("geometry kernels", () => {
  const frame = (w: number, h: number) => {
    const d = new Float32Array(w * h * 4);
    const p = plane(w, h, 7);
    for (let i = 0, k = 0; i < w * h; i++, k += 4) {
      d[k] = p[i]; d[k + 1] = p[(i * 7) % (w * h)]; d[k + 2] = p[(i * 13) % (w * h)]; d[k + 3] = 255;
    }
    return { w, h, d };
  };

  it("resizes the same way", () => {
    const f = frame(37, 23);
    for (const interp of ["nearest", "bilinear", "bicubic", "lanczos"] as const) {
      same(refGeometry.resize(f, 19, 41, interp).d, natGeometry.resize(f, 19, 41, interp).d, `resize ${interp}`);
    }
  });

  it("warps the same way", () => {
    const f = frame(32, 32);
    const map = (x: number, y: number, q: Float64Array) => { q[0] = x + 2.5; q[1] = y - 1.5; };
    same(refGeometry.warp(f, 40, 40, map, "bicubic").d, natGeometry.warp(f, 40, 40, map, "bicubic").d, "warp");
    same(refGeometry.translate(f, 3, -2, false).d, natGeometry.translate(f, 3, -2, false).d, "translate");
  });

  it("solves the same homography and matches the same template", () => {
    const src = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const dst = [{ x: 1, y: 2 }, { x: 12, y: 3 }, { x: 11, y: 14 }, { x: 0, y: 9 }];
    same(refGeometry.homography(src, dst), natGeometry.homography(src, dst), "homography");
    const img = plane(40, 40, 3);
    const tpl = new Float32Array(64);
    for (let i = 0; i < 64; i++) tpl[i] = img[10 * 40 + 10 + (i % 8) + Math.floor(i / 8) * 40];
    const a = refGeometry.matchTemplate(img, 40, 40, tpl, 8, 8, 14, 14, 6);
    const b = natGeometry.matchTemplate(img, 40, 40, tpl, 8, 8, 14, 14, 6);
    same([a.x, a.y, a.score], [b.x, b.y, b.score], "template match");
    same(refGeometry.downPlane(img, 40, 40, 2).d, natGeometry.downPlane(img, 40, 40, 2).d, "downscale");
  });
});

describe("FFT kernels", () => {
  it("computes the same spectrum and filters", () => {
    const p = plane(32, 32, 5);
    same(refFft.spectrum(p, 32, 32, "magnitude", true), natFft.spectrum(p, 32, 32, "magnitude", true), "spectrum");
    same(refFft.spectrum(p, 32, 32, "phase", false), natFft.spectrum(p, 32, 32, "phase", false), "phase spectrum");
    same([refFft.nextPow2(37)], [natFft.nextPow2(37)], "next power of two");
    const win = refFft.hannWindowed(p, 32, 32, 0, 0, 32, 32);
    const win2 = natFft.hannWindowed(p, 32, 32, 0, 0, 32, 32);
    same(win, win2, "hann window");
    const a = plane(32, 32, 9), b = plane(32, 32, 11);
    const r1 = refFft.phaseCorrelate(Float64Array.from(a), Float64Array.from(b), 32, 32);
    const r2 = natFft.phaseCorrelate(Float64Array.from(a), Float64Array.from(b), 32, 32);
    same([r1.dx, r1.dy], [r2.dx, r2.dy], "phase correlation");
  });

  it("deconvolves the same way", () => {
    const w = 24, h = 24;
    const d = new Float32Array(w * h * 4);
    const p = plane(w, h, 13);
    for (let i = 0, k = 0; i < w * h; i++, k += 4) { d[k] = p[i]; d[k + 1] = p[i]; d[k + 2] = p[i]; d[k + 3] = 255; }
    const psf = { w: 5, h: 5, d: new Float32Array(25) };
    psf.d[12] = 1;
    same(refFft.deconvolve({ w, h, d }, psf, "wiener", 0.01, 5).d, natFft.deconvolve({ w, h, d }, psf, "wiener", 0.01, 5).d, "wiener deconvolution");
    same(refFft.deconvolve({ w, h, d }, psf, "tikhonov", 0.01, 5).d, natFft.deconvolve({ w, h, d }, psf, "tikhonov", 0.01, 5).d, "tikhonov deconvolution");
  });
});

describe("JPEG model", () => {
  it("compresses the same way", () => {
    const w = 16, h = 16;
    const d = new Float32Array(w * h * 4);
    const p = plane(w, h, 17);
    for (let i = 0, k = 0; i < w * h; i++, k += 4) { d[k] = p[i]; d[k + 1] = p[i]; d[k + 2] = p[i]; d[k + 3] = 255; }
    const f = { w, h, d };
    same(refJpeg.quantTable(refJpeg.LUMA_TABLE, 90), natJpeg.quantTable(natJpeg.LUMA_TABLE, 90), "quantization table");
    same(refJpeg.jpegRoundTrip(f, 90, "420").d, natJpeg.jpegRoundTrip(f, 90, "420").d, "JPEG round trip 4:2:0");
    same(refJpeg.jpegRoundTrip(f, 75, "444").d, natJpeg.jpegRoundTrip(f, 75, "444").d, "JPEG round trip 4:4:4");
  });
});
