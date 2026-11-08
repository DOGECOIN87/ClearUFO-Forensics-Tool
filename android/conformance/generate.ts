// Conformance vectors: runs the browser workbench's own kernels (src/engine) on deterministic inputs and writes
// their outputs, so the Android port can be checked against them (app/src/test/.../ConformanceTest.kt).
//
//   node android/conformance/run.mjs        (from the repository root, after npm ci)
//
// Output: android/app/src/test/resources/conformance/<name>.f32 (little-endian float32) + manifest.json
import { mkdirSync, writeFileSync } from "node:fs";
import type { Frame } from "../../src/engine/frame";
import { bilateral, boxBlur, deblock, gaussianBlur, mapRGB, medianPlane, nlMeans, wienerAdaptive } from "../../src/engine/kernels/conv";
import { applyLuts, clahe, Lut } from "../../src/engine/kernels/color";
import { brightnessContrastLut, curveFunction, exposureLut, levelsLut } from "../../src/engine/filters/luts";
import { deconvolve, fourierFilter, hannWindowed, phaseCorrelate, spectrum } from "../../src/engine/kernels/fft";
import { homography, resize, translate, warp } from "../../src/engine/kernels/geometry";
import { jpegRoundTrip } from "../../src/engine/kernels/jpeg";
import { diskPsf, gaussianPsf, linePsf, pathPsf } from "../../src/shared/psf";
import { smoothFrame, temporalFilters } from "../../src/engine/filters/temporal";
import { yuvToFrame } from "../../src/engine/sources/yuv";
import { luma } from "../../src/engine/frame";
import { FILTER_LIST } from "../../src/shared/filters";

const OUT = "android/app/src/test/resources/conformance";
mkdirSync(OUT, { recursive: true });
const manifest: Record<string, { w: number; h: number; c: number }> = {};

function save(name: string, d: Float32Array | Float64Array, w: number, h: number, c: number) {
  const f = d instanceof Float32Array ? d : Float32Array.from(d);
  writeFileSync(`${OUT}/${name}.f32`, Buffer.from(f.buffer, f.byteOffset, f.byteLength));
  manifest[name] = { w, h, c };
}
const saveFrame = (name: string, f: Frame) => save(name, f.d, f.w, f.h, 4);

/** mulberry32, the generator of the synthetic test patterns (identical in the Kotlin port). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic test frame: gradients, a bright disk, an edge, fractional values and noise. */
function input(w: number, h: number, seed: number, dx = 0, dy = 0): Frame {
  const r = rng(seed), d = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = x - dx, Y = y - dy, k = (y * w + x) * 4;
    const disk = Math.hypot(X - w * 0.6, Y - h * 0.45) < h * 0.22 ? 120 : 0;
    const edge = X > w * 0.3 ? 40 : 0;
    d[k] = Math.fround(30 + (X / w) * 150 + disk + r() * 12);
    d[k + 1] = Math.fround(20 + (Y / h) * 170 + edge + r() * 12);
    d[k + 2] = Math.fround(60 + ((X + Y) / (w + h)) * 120 + (disk ? 40 : 0) + r() * 12 - 4);
    d[k + 3] = 255;
  }
  return { w, h, d };
}

const W = 61, H = 47;
const f = input(W, H, 7);
saveFrame("input", f);

// ---------------------------------------------------------------- spatial kernels
saveFrame("gauss_1_3", gaussianBlur(f, 1.3));
saveFrame("gauss_4_2", gaussianBlur(f, 4.2));
saveFrame("box_2", boxBlur(f, 2));
saveFrame("median_1", mapRGB(f, (p) => medianPlane(p, W, H, 1)));
saveFrame("median_3", mapRGB(f, (p) => medianPlane(p, W, H, 3)));
saveFrame("bilateral", bilateral(f, 2, 20));
saveFrame("nlmeans", nlMeans(f, 10, 1, 3));
saveFrame("wiener", wienerAdaptive(f, 2, 0));
saveFrame("deblock", deblock(f, 8, 0.6, 24));

// ---------------------------------------------------------------- geometry
saveFrame("resize_up_bicubic", resize(f, 97, 73, "bicubic"));
saveFrame("resize_down_lanczos", resize(f, 29, 22, "lanczos"));
saveFrame("resize_up_bilinear", resize(f, 80, 60, "bilinear"));
{
  const a = (17 * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const ow = Math.ceil(Math.abs(W * c) + Math.abs(H * s)), oh = Math.ceil(Math.abs(W * s) + Math.abs(H * c));
  saveFrame("rotate_17", warp(f, ow, oh, (x, y, q) => { const dx = x - ow / 2 + 0.5, dy = y - oh / 2 + 0.5; q[0] = c * dx + s * dy + W / 2 - 0.5; q[1] = -s * dx + c * dy + H / 2 - 0.5; }, "bicubic", [0, 0, 0]));
}
{
  const pts = [{ x: 5, y: 4 }, { x: 55, y: 9 }, { x: 50, y: 42 }, { x: 8, y: 38 }];
  const Hm = homography([{ x: 0, y: 0 }, { x: 39, y: 0 }, { x: 39, y: 29 }, { x: 0, y: 29 }], pts);
  saveFrame("perspective", warp(f, 40, 30, (x, y, q) => { const wq = Hm[6] * x + Hm[7] * y + Hm[8]; q[0] = (Hm[0] * x + Hm[1] * y + Hm[2]) / wq; q[1] = (Hm[3] * x + Hm[4] * y + Hm[5]) / wq; }, "bilinear"));
}
saveFrame("translate", translate(f, 2.37, -1.61, true));

// ---------------------------------------------------------------- color / tone
save("clahe", clahe(luma(f), W, H, 4, 3), W, H, 1);
{
  const lv = levelsLut({ inBlack: 10, inWhite: 240, gamma: 1.4, outBlack: 5, outWhite: 250 });
  saveFrame("levels", applyLuts(f, lv, lv, lv));
  const cv = new Lut(curveFunction([{ x: 0, y: 0 }, { x: 64, y: 40 }, { x: 180, y: 220 }, { x: 255, y: 255 }]));
  saveFrame("curves", applyLuts(f, cv, null, cv));
  const bc = brightnessContrastLut({ brightness: 12, contrast: 35 });
  saveFrame("brightness_contrast", applyLuts(f, bc, bc, bc));
  const ex = exposureLut({ exposure: 0.7, gamma: 1.8, offset: -6 });
  saveFrame("exposure", applyLuts(f, ex, ex, ex));
}

// ---------------------------------------------------------------- frequency domain
saveFrame("deconv_wiener_line", deconvolve(f, linePsf(7, 20), "wiener", 0.01, 1));
saveFrame("deconv_tikhonov_gauss", deconvolve(f, gaussianPsf(1.5), "tikhonov", 0.02, 1));
saveFrame("deconv_rl_disk", deconvolve(f, diskPsf(2.5), "rl", 0.01, 6));
saveFrame("deconv_wiener_path", deconvolve(f, pathPsf([{ x: 0, y: 0 }, { x: 6, y: 2 }, { x: 9, y: 7 }], 2), "wiener", 0.02, 1));
saveFrame("fourier_notch", fourierFilter(f, { filter: "notch", points: [{ x: 20, y: 15 }, { x: 40, y: 9 }], radius: 4, symmetric: true, cutoff: 0.1, smooth: true }));
saveFrame("fourier_lowpass", fourierFilter(f, { filter: "lowpass", points: [], radius: 8, symmetric: true, cutoff: 0.12, smooth: false }));
save("spectrum_log", spectrum(luma(f), W, H, "magnitude", true), W, H, 1);
save("spectrum_phase", spectrum(luma(f), W, H, "phase", false), W, H, 1);
{
  const g = input(W, H, 7, 3.4, -2.2);
  const a = hannWindowed(luma(f), W, H, 0, 0, 64, 64), b = hannWindowed(luma(g), W, H, 0, 0, 64, 64);
  const s = phaseCorrelate(a, b, 64, 64);
  save("phase_correlate", Float64Array.from([s.dx, s.dy, s.peak]), 3, 1, 1);
}

// ---------------------------------------------------------------- ELA JPEG model
saveFrame("jpeg_q90_420", jpegRoundTrip(f, 90, "420"));
saveFrame("jpeg_q75_444", jpegRoundTrip(f, 75, "444"));

// ---------------------------------------------------------------- temporal smoothing
{
  const frames = [0, 1, 2, 3, 4, 5, 6].map((k) => input(W, H, 100 + k, k === 3 ? 6 : 0, 0));
  const get = async (j: number) => frames[j];
  for (const [name, o] of [
    ["smooth_mean_protect", { size: 5, method: "mean", protect: true, threshold: 12, showMask: false }],
    ["smooth_gauss", { size: 7, method: "gaussian", protect: false, threshold: 12, showMask: false }],
    ["smooth_median_protect", { size: 5, method: "median", protect: true, threshold: 8, showMask: false }],
    ["smooth_mean_mask", { size: 5, method: "mean", protect: true, threshold: 6, showMask: true }],
  ] as const) saveFrame(name, await smoothFrame(get, 3, frames.length, o as any));
}

// ---------------------------------------------------------------- super resolution
{
  // sub-pixel shifted views of the same scene (each with its own noise)
  const shifts = [[0, 0], [0.4, -0.3], [-0.7, 0.25], [1.2, 0.6], [-0.35, -0.8], [0.55, 1.1]];
  const frames = shifts.map(([dx, dy], k) => input(W, H, 200 + k, dx, dy));
  const s = { info: { width: W, height: H, frameCount: frames.length, fps: 25, par: 1 }, getFrame: async (i: number) => frames[i], meta: (i: number) => ({ type: "P", pts: i / 25, key: i === 0, bytes: 0, src: i }) };
  const ctx = { isStale: () => false, progress: () => {} };
  for (const [name, p] of [
    ["superres_gauss_x2", { scale: 2, roi: null, maxFrames: 30, kernel: "gaussian" }],
    ["superres_bilinear_x3", { scale: 3, roi: null, maxFrames: 30, kernel: "bilinear" }],
    ["superres_gauss_x2_roi", { scale: 2, roi: { x: 9, y: 7, w: 40, h: 33 }, maxFrames: 4, kernel: "gaussian" }],
  ] as const) saveFrame(name, await (await temporalFilters.super_resolution(s as any, p as any, ctx as any)).getFrame(0));
}

// ---------------------------------------------------------------- YUV → RGB (I420, 8-bit)
{
  const w = 33, h = 21, cw = (w + 1) >> 1, ch = (h + 1) >> 1;
  const r = rng(99), buf = new Uint8Array(w * h + 2 * cw * ch);
  for (let i = 0; i < w * h; i++) buf[i] = 16 + Math.floor(r() * 220);
  for (let i = 0; i < cw * ch; i++) { buf[w * h + i] = 40 + Math.floor(r() * 176); buf[w * h + cw * ch + i] = 30 + Math.floor(r() * 196); }
  save("yuv_planes", Float32Array.from(buf), buf.length, 1, 1);
  const layout = [{ offset: 0, stride: w }, { offset: w * h, stride: cw }, { offset: w * h + cw * ch, stride: cw }];
  saveFrame("yuv_709_limited_bicubic_left", yuvToFrame(buf, layout, "I420", w, h, { matrix: "bt709", full: false, chroma: "bicubic", siting: "left" }));
  saveFrame("yuv_601_full_bilinear_center", yuvToFrame(buf, layout, "I420", w, h, { matrix: "bt601", full: true, chroma: "bilinear", siting: "center" }));
  saveFrame("yuv_2020_limited_nearest", yuvToFrame(buf, layout, "I420", w, h, { matrix: "bt2020", full: false, chroma: "nearest", siting: "left" }));
}

// ---------------------------------------------------------------- filter catalog (ids, parameter keys, types, defaults)
writeFileSync(`${OUT}/catalog.json`, JSON.stringify(FILTER_LIST.map((f) => ({ id: f.id, category: f.category, kind: f.kind, params: f.params.map((p: any) => ({ key: p.key, type: p.type, default: p.default ?? null, legacy: p.legacy ?? null, min: p.min ?? null, max: p.max ?? null, options: p.options?.map((o: [string, string]) => o[0]) ?? null })) })), null, 1));

writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 1));
console.log(`${Object.keys(manifest).length} conformance vectors written to ${OUT}`);
