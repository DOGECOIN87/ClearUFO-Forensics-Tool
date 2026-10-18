// Speed-ups must never change results. Each fast path is compared bit for bit with a straightforward
// reference implementation (the code it replaced):
//   - WebAssembly SIMD float -> 8-bit conversion vs Uint8ClampedArray stores (EXHAUSTIVE=1: all 2^32 float32 patterns)
//   - WebAssembly display histogram vs the JavaScript loop
//   - blocked / loop-swapped FFT vs the textbook radix-2 transform
//   - inlined LUT application vs Lut.map
import { convertToU8, histReference, setWasmEnabled, toU8Reference, wasmActive } from "../src/engine/wasm/px";
import { fft, fft2 } from "../src/engine/kernels/fft";
import { applyLuts, Lut } from "../src/engine/kernels/color";
import { bilateral, bilateralP, gaussianBlur, gaussianBlurP, mapRGB, medianP, medianPlane, nlMeans, nlMeansP, nlmBands, wienerAdaptive, wienerP } from "../src/engine/kernels/conv";
import { deconvolve, deconvolveP } from "../src/engine/kernels/fft";
import { matchTemplate, matchTemplateP } from "../src/engine/kernels/geometry";
import { yuvToFrame, yuvToFrameP } from "../src/engine/sources/yuv";
import { forceBands, rowBands, setThreads } from "../src/engine/pool";
import { linePsf } from "../src/shared/psf";

let fail = 0, pass = 0;
const ok = (c: unknown, m: string) => { if (c) { pass++; if (process.env.VERBOSE) console.log("ok  ", m); } else { fail++; console.log("FAIL", m); } };
const sameBytes = (a: ArrayBufferView, b: ArrayBufferView) => {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

// ---------------------------------------------------------------- 8-bit conversion
ok(wasmActive(), "WebAssembly SIMD kernels load (Node / V8)");
{
  const special = [NaN, Infinity, -Infinity, 0, -0, 0.5, 1.5, 2.5, 254.5, 255.5, 253.5, -0.5, -0.49999997, 0.49999997, 255, 256, -1, 1e-45, -1e-45, 3.4e38, -3.4e38, 127.5, 128.5, 0.50000006];
  const n = 1 << 18;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = i < special.length ? special[i] : (rnd() * 300 - 20) * (i % 3 === 0 ? 1 : Math.round(rnd() * 2) / 2);
  for (const len of [n, n - 1, n - 15, 17, 16, 15, 3, 1, 65537, 65536, 65535]) {
    const a = new Uint8ClampedArray(len), b = new Uint8ClampedArray(len);
    toU8Reference(src.subarray(0, len), a);
    convertToU8(src.subarray(0, len), b, false);
    ok(sameBytes(a, b), `conversion identical to Uint8ClampedArray stores (${len} samples)`);
  }
  // a strided sweep of the whole float32 space (EXHAUSTIVE=1 checks every bit pattern, ~30 s)
  const all = !!process.env.EXHAUSTIVE, step = all ? 1 : 4093, chunk = 1 << 20;
  const bits = new Uint32Array(chunk), f = new Float32Array(bits.buffer), r = new Uint8ClampedArray(chunk), w = new Uint8ClampedArray(chunk);
  let bad = 0, count = 0;
  for (let base = 0; base < 2 ** 32 && !bad; base += chunk * step) {
    let m = 0;
    for (let k = 0; k < chunk; k++) { const v = base + k * step; if (v >= 2 ** 32) break; bits[k] = v; m++; }
    const ff = f.subarray(0, m - (m % 4)), rr = r.subarray(0, ff.length), ww = w.subarray(0, ff.length);
    toU8Reference(ff, rr);
    convertToU8(ff, ww, false);
    if (!sameBytes(rr, ww)) bad++;
    count += ff.length;
  }
  ok(!bad, `conversion identical over ${count.toLocaleString("en-US")} float32 bit patterns${all ? " (exhaustive)" : " (strided sweep)"}`);
}

// ---------------------------------------------------------------- display histogram
{
  const n = 1920 * 1080 * 4;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = (i & 3) === 3 ? 255 : i % 97 === 0 ? (i % 2 ? 0 : 255) : rnd() * 270 - 5;
  const rgbaW = new Uint8ClampedArray(n), rgbaJ = new Uint8ClampedArray(n);
  const hw = convertToU8(src, rgbaW, true)!;
  setWasmEnabled(false);
  ok(!wasmActive(), "the WebAssembly path can be switched off");
  const hj = convertToU8(src, rgbaJ, true)!;
  setWasmEnabled(true);
  const ref = histReference(rgbaJ);
  ok(sameBytes(rgbaW, rgbaJ), "1080p frame: WebAssembly and JavaScript conversions give the same bytes");
  ok(sameBytes(hw.hist, ref.hist) && hw.low === ref.low && hw.high === ref.high, `histogram identical (R, G, B, luma; low ${ref.low}, high ${ref.high})`);
  ok(sameBytes(hj.hist, ref.hist) && hj.low === ref.low && hj.high === ref.high, "JavaScript fallback histogram identical");
  ok(hw.hist.length === 1280 && ref.hist.length === 1280, "histogram keeps its 5 x 256 layout");
  // every (r, g, b) combination exercises the integer luma formula and the saturation counts
  const px = new Float32Array(256 * 256 * 256 * 4);
  for (let r = 0, i = 0; r < 256; r++) for (let g = 0; g < 256; g++) for (let b = 0; b < 256; b++, i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; }
  const o = new Uint8ClampedArray(px.length), h2 = convertToU8(px, o, true)!, r2 = histReference(o);
  ok(sameBytes(h2.hist, r2.hist) && h2.low === r2.low && h2.high === r2.high, "histogram identical for all 16,777,216 RGB triples");
}

// ---------------------------------------------------------------- FFT
{
  // the textbook transform the optimized one replaced (same twiddle tables)
  const refFft = (re: Float64Array, im: Float64Array, inverse: boolean) => {
    const n = re.length, bitsN = Math.log2(n);
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
    for (let i = 0; i < n; i++) {
      let j = 0;
      for (let b = 0; b < bitsN; b++) j |= ((i >> b) & 1) << (bitsN - 1 - b);
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
        const c = cos[k], s = inverse ? sin[k] : -sin[k];
        const a = i + j, b = a + half;
        const tre = re[b] * c - im[b] * s, tim = re[b] * s + im[b] * c;
        re[b] = re[a] - tre; im[b] = im[a] - tim;
        re[a] += tre; im[a] += tim;
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  };
  const refFft2 = (re: Float64Array, im: Float64Array, W: number, H: number, inverse: boolean) => {
    for (let y = 0; y < H; y++) refFft(re.subarray(y * W, y * W + W), im.subarray(y * W, y * W + W), inverse);
    const cr = new Float64Array(H), ci = new Float64Array(H);
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) { cr[y] = re[y * W + x]; ci[y] = im[y * W + x]; }
      refFft(cr, ci, inverse);
      for (let y = 0; y < H; y++) { re[y * W + x] = cr[y]; im[y * W + x] = ci[y]; }
    }
  };
  for (const n of [2, 4, 8, 32, 64, 1024]) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) { re[i] = rnd() * 255 - (i % 5 === 0 ? 0 : 100); im[i] = i % 7 === 0 ? -0 : rnd() - 0.5; }
    for (const inv of [false, true]) {
      const a = re.slice(), b = im.slice(), c = re.slice(), d = im.slice();
      fft(a, b, inv); refFft(c, d, inv);
      ok(sameBytes(a, c) && sameBytes(b, d), `1-D FFT n=${n}${inv ? " inverse" : ""}: bit-identical to the radix-2 reference`);
    }
  }
  for (const [W, H] of [[2, 2], [8, 4], [4, 16], [64, 32], [256, 128], [16, 512]]) {
    const n = W * H, re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) { re[i] = Math.sin(i * 0.37) * 100 + (i % 13); im[i] = i % 3 ? Math.cos(i * 0.11) : 0; }
    for (const inv of [false, true]) {
      const a = re.slice(), b = im.slice(), c = re.slice(), d = im.slice();
      fft2(a, b, W, H, inv); refFft2(c, d, W, H, inv);
      ok(sameBytes(a, c) && sameBytes(b, d), `2-D FFT ${W}x${H}${inv ? " inverse" : ""}: bit-identical (blocked columns)`);
    }
  }
}

// ---------------------------------------------------------------- LUT application
{
  const n = 1 << 16, d = new Float32Array(n * 4);
  // fractional values, out-of-range values, whole numbers (8-bit sources: the integer table path), -0
  for (let i = 0; i < d.length; i++) d[i] = (i & 3) === 3 ? 200 : i % 11 === 0 ? -3 : i % 13 === 0 ? 300 : i % 17 === 0 ? -0 : i % 2 ? Math.round(rnd() * 255) : rnd() * 255;
  const f = { w: n, h: 1, d };
  const curve = new Lut((v) => Math.pow(v / 255, 0.45) * 255), lin = new Lut((v) => v * 1.2 - 10);
  for (const [lr, lg, lb, name] of [[curve, curve, curve, "all"], [lin, null, null, "red only"], [null, curve, lin, "mixed"], [null, null, null, "none"]] as const) {
    const out = applyLuts(f, lr, lg, lb).d;
    const ref = new Float32Array(d.length);
    for (let i = 0; i < d.length; i += 4) {
      ref[i] = lr ? lr.map(d[i]) : d[i];
      ref[i + 1] = lg ? lg.map(d[i + 1]) : d[i + 1];
      ref[i + 2] = lb ? lb.map(d[i + 2]) : d[i + 2];
      ref[i + 3] = d[i + 3];
    }
    ok(sameBytes(out, ref), `applyLuts (${name}) bit-identical to Lut.map`);
  }
}

// ---------------------------------------------------------------- multi-core: band decomposition is exact
// Without workers (Node) the pool runs every band in this thread, which exercises exactly the band code paths.
await (async () => {
  setThreads(8);
  const mkFrame = (w: number, h: number, seedV: number) => {
    const d = new Float32Array(w * h * 4);
    for (let i = 0; i < d.length; i++) d[i] = (i & 3) === 3 ? 255 - (i % 7) : ((Math.sin(i * 0.013 + seedV) + 1) * 110 + ((i * 2654435761) >>> 27)) % 260;
    return { w, h, d };
  };
  const same = (a: { d: Float32Array }, b: { d: Float32Array }) => sameBytes(a.d, b.d);
  const f = mkFrame(97, 61, 1);
  for (const n of [2, 3, 7]) {
    forceBands(n);
    ok(same(await gaussianBlurP(f, 1.3), gaussianBlur(f, 1.3)), `Gaussian (rows) identical in ${n} bands`);
    ok(same(await gaussianBlurP(f, 4.5), gaussianBlur(f, 4.5)), `Gaussian sigma > 3 (box passes, per channel) identical, ${n} bands setting`);
    for (const r of [1, 3]) ok(same(await medianP(f, r), mapRGB(f, (pl) => medianPlane(pl, f.w, f.h, r))), `median r=${r} identical in ${n} bands`);
    ok(same(await bilateralP(f, 2.2, 25), bilateral(f, 2.2, 25)), `bilateral identical in ${n} bands`);
    ok(same(await nlMeansP(f, 9, 2, 4), nlMeans(f, 9, 2, 4)), `non-local means identical in ${n} bands (integral from the top row)`);
    ok(same(await wienerP(f, 2, 0), wienerAdaptive(f, 2, 0)), `adaptive Wiener identical (per channel), ${n} bands setting`);
  }
  forceBands(2);
  const psf = linePsf(7, 30);
  for (const m of ["wiener", "tikhonov", "rl"] as const) {
    ok(same(await deconvolveP(f, psf, m, 0.01, 3), deconvolve(f, psf, m, 0.01, 3)), `deconvolution (${m}) identical with channel pairs as separate jobs`);
  }
  // template matching: bands of search rows, first best position kept
  const W = 120, H = 90, img = new Float32Array(W * H);
  for (let i = 0; i < img.length; i++) img[i] = ((i * 7919) % 251) + Math.sin(i * 0.05) * 20;
  const tpl = new Float32Array(20 * 14);
  for (let y = 0; y < 14; y++) for (let x = 0; x < 20; x++) tpl[y * 20 + x] = img[(37 + y) * W + 51 + x];
  const flat = new Float32Array(W * H).fill(7);
  for (const n of [2, 5]) {
    forceBands(n);
    const a = await matchTemplateP(img, W, H, tpl, 20, 14, 48, 33, 9), b = matchTemplate(img, W, H, tpl, 20, 14, 48, 33, 9);
    ok(JSON.stringify(a) === JSON.stringify(b) && Math.round(a.x) === 51 && Math.round(a.y) === 37, `template match identical in ${n} bands (${JSON.stringify(a)})`);
    const c = await matchTemplateP(flat, W, H, tpl, 20, 14, 48, 33, 9), e = matchTemplate(flat, W, H, tpl, 20, 14, 48, 33, 9);
    ok(JSON.stringify(c) === JSON.stringify(e), `template match on a flat image (all scores tie) keeps the first position, ${n} bands`);
  }
  // YUV -> RGB in row bands, all formats / filters / sitings / bit depths
  let yuvBad = 0, yuvCount = 0;
  for (const [fmt, bps, cwd, chd] of [["I420", 1, 2, 2], ["I422", 1, 2, 1], ["I444", 1, 1, 1], ["NV12", 1, 2, 2], ["I420P10", 2, 2, 2], ["I422P12", 2, 2, 1]] as const) {
    const w = 98, h = 70, cw = Math.ceil(w / cwd), ch = Math.ceil(h / chd);
    const yStride = w * bps + 6, cStride = (fmt === "NV12" ? cw * 2 : cw) * bps + 4;  // padded rows
    const ysz = yStride * h, csz = cStride * ch;
    const buf = new Uint8Array(ysz + csz * (fmt === "NV12" ? 1 : 2));
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 2654435761) >>> 24;
    if (bps === 2) for (let i = 1; i < buf.length; i += 2) buf[i] &= fmt.endsWith("P12") ? 15 : 3;
    const layout = fmt === "NV12" ? [{ offset: 0, stride: yStride }, { offset: ysz, stride: cStride }] : [{ offset: 0, stride: yStride }, { offset: ysz, stride: cStride }, { offset: ysz + csz, stride: cStride }];
    for (const chroma of ["bicubic", "bilinear", "nearest"] as const) for (const siting of ["left", "center", "topleft", "bottom"] as const) for (const n of [2, 3]) {
      forceBands(n);
      const P = { matrix: "bt709" as const, full: fmt.includes("P1"), chroma, siting };
      const a = await yuvToFrameP(buf, layout, fmt, w, h, P), b = yuvToFrame(buf, layout, fmt, w, h, P);
      yuvCount++;
      if (!same(a, b)) { yuvBad++; if (yuvBad < 4) console.log("yuv mismatch", fmt, chroma, siting, n); }
    }
  }
  ok(!yuvBad, `YUV -> RGB identical in row bands (${yuvCount} format / filter / siting / band combinations)`);
  forceBands(0);
  setThreads(0);
  // band helpers
  const covers = (bands: [number, number][], h: number) => bands.length > 0 && bands[0][0] === 0 && bands[bands.length - 1][1] === h && bands.every((b, i) => b[1] > b[0] && (i === 0 || b[0] === bands[i - 1][1]));
  ok([1, 2, 7, 33, 1080].every((h) => [1, 2, 3, 8, 24].every((n) => covers(rowBands(h, n), h))), "row bands cover the image without gaps or overlaps");
  ok([16, 61, 1080, 2160].every((h) => [2, 3, 7, 8].every((n) => covers(nlmBands(h, n, 3), h))), "non-local means bands cover the image");
  const nb = nlmBands(1080, 4, 3), cost = nb.map(([a, b]) => (b + 3) + 6 * (b - a));
  ok(Math.max(...cost) / Math.min(...cost) < 1.25, `non-local means bands have balanced cost (${nb.map((b) => b.join("-")).join(", ")})`);
})();

console.log(`perf: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
