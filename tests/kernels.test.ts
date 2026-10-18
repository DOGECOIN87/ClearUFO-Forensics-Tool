import { medianPlane, blurPlane, boxBlurPlane } from "../src/engine/kernels/conv";
import { fft2, nextPow2 } from "../src/engine/kernels/fft";
import { deconvolve } from "../src/engine/kernels/fft";
import { linePsf, diskPsf, gaussianPsf, pathPsf } from "../src/shared/psf";
import { resize, homography, applyH } from "../src/engine/kernels/geometry";
import { yuvToFrame } from "../src/engine/sources/yuv";
import { parseFrameList } from "../src/engine/filters/temporal";
import { curveFunction } from "../src/engine/filters/basic";
let fail = 0;
const check = (name: string, ok: boolean, info = "") => { if (!ok) { fail++; console.log("FAIL", name, info); } else console.log("ok  ", name, info); };
const rnd = (n: number, seed = 1) => { let a = seed; return Float32Array.from({ length: n }, () => { a = (a * 1103515245 + 12345) % 2147483648; return (a / 2147483648) * 255; }); };

// median 3x3 network vs brute force
{ const w = 37, h = 23, p = rnd(w * h, 7); const m = medianPlane(p, w, h, 1); let bad = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v: number[] = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) v.push(p[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))]); v.sort((a, b) => a - b); if (Math.abs(v[4] - m[y * w + x]) > 1e-4) bad++; }
  check("median3 network == sort", bad === 0, `${bad} mismatches`); }
// Huang median r=2 vs brute force (quantized)
{ const w = 31, h = 19, p = rnd(w * h, 3).map(Math.round); const m = medianPlane(p, w, h, 2); let bad = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v: number[] = []; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) v.push(p[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))]); v.sort((a, b) => a - b); if (Math.abs(v[12] - m[y * w + x]) > 1e-4) bad++; }
  check("median5 Huang == sort", bad === 0, `${bad} mismatches`); }
// FFT round trip
{ const W = 64, H = 32, re = Float64Array.from(rnd(W * H, 5)), im = new Float64Array(W * H), orig = Float64Array.from(re);
  fft2(re, im, W, H, false); fft2(re, im, W, H, true); let e = 0; for (let i = 0; i < re.length; i++) e = Math.max(e, Math.abs(re[i] - orig[i]));
  check("fft2 round trip", e < 1e-9, `max err ${e.toExponential(2)}`); }
// PSFs normalized
for (const [n, p] of [["line", linePsf(9, 12)], ["disk", diskPsf(3)], ["gauss", gaussianPsf(1.5)], ["path", pathPsf([{ x: 0, y: 0 }, { x: 5, y: 3 }, { x: 8, y: 8 }], 2)]] as const) {
  const s = p.d.reduce((a, b) => a + b, 0); check(`psf ${n} normalized`, Math.abs(s - 1) < 1e-5, s.toFixed(6)); }
// deconvolution recovers a blurred step edge (Wiener, low noise)
{ const w = 96, h = 64, d = new Float32Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = x > 40 && x < 60 && y > 20 && y < 44 ? 220 : 30; const k = (y * w + x) * 4; d[k] = d[k + 1] = d[k + 2] = v; d[k + 3] = 255; }
  const psf = linePsf(7, 0); const bl = new Float32Array(d.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) { let s = 0; for (let ky = 0; ky < psf.h; ky++) for (let kx = 0; kx < psf.w; kx++) { const xx = Math.min(w - 1, Math.max(0, x - (kx - (psf.w >> 1)))), yy = Math.min(h - 1, Math.max(0, y - (ky - (psf.h >> 1)))); s += d[(yy * w + xx) * 4 + c] * psf.d[ky * psf.w + kx]; } bl[(y * w + x) * 4 + c] = s; }
  const err = (a: Float32Array) => { let e = 0, n = 0; for (let y = 24; y < 40; y++) for (let x = 30; x < 70; x++) { e += Math.abs(a[(y * w + x) * 4] - d[(y * w + x) * 4]); n++; } return e / n; };
  const r = deconvolve({ w, h, d: bl }, psf, "wiener", 0.0005, 0);
  check("wiener deblur reduces error", err(r.d) < err(bl) * 0.5, `blurred ${err(bl).toFixed(2)} → restored ${err(r.d).toFixed(2)}`); }
// resize preserves mean
{ const w = 50, h = 40, d = new Float32Array(w * h * 4); for (let i = 0; i < d.length; i++) d[i] = (i & 3) === 3 ? 255 : (i * 13) % 251;
  const mean = (a: Float32Array) => { let s = 0, n = 0; for (let i = 0; i < a.length; i += 4) { s += a[i]; n++; } return s / n; };
  for (const it of ["bilinear", "bicubic", "lanczos"] as const) { const r = resize({ w, h, d }, 125, 100, it); check(`resize ${it} mean`, Math.abs(mean(r.d) - mean(d)) < 2, `${mean(d).toFixed(2)} vs ${mean(r.d).toFixed(2)}`); } }
// homography maps the correspondences
{ const src = [{ x: 10, y: 10 }, { x: 200, y: 20 }, { x: 190, y: 150 }, { x: 15, y: 140 }], dst = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
  const H = homography(src, dst); const e = Math.max(...src.map((p, i) => { const [x, y] = applyH(H, p.x, p.y); return Math.hypot(x - dst[i].x, y - dst[i].y); })); check("homography", e < 1e-6, e.toExponential(2)); }
// YUV limited range BT.601: Y=235 → white, Y=16 → black
{ const w = 4, h = 2, buf = new Uint8Array(w * h + 2 * (w / 2) * (h / 2)); buf.fill(128); for (let i = 0; i < 4; i++) buf[i] = 235; for (let i = 4; i < 8; i++) buf[i] = 16;
  const f = yuvToFrame(buf, [{ offset: 0, stride: w }, { offset: w * h, stride: w / 2 }, { offset: w * h + (w / 2) * (h / 2), stride: w / 2 }], "I420", w, h, { matrix: "bt601", full: false });
  check("yuv limited white/black", Math.abs(f.d[0] - 255) < 0.01 && Math.abs(f.d[16]) < 0.01, `${f.d[0].toFixed(2)} / ${f.d[16].toFixed(2)}`); }
check("frame list parser", JSON.stringify(parseFrameList("0, 3-5, 9, 99", 10)) === "[0,3,4,5,9]");
{ const fn = curveFunction([{ x: 0, y: 0 }, { x: 128, y: 160 }, { x: 255, y: 255 }]); let mono = true, prev = -1; for (let v = 0; v <= 255; v++) { const y = fn(v); if (y < prev - 1e-9) mono = false; prev = y; } check("curve monotone + passes points", mono && Math.abs(fn(128) - 160) < 1e-9); }
void blurPlane; void boxBlurPlane; void nextPow2;
console.log(fail ? `${fail} FAILED` : "kernels: all tests passed");
process.exit(fail ? 1 : 0);
