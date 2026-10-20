// Temporal Smoothing (Integrate): the production implementation against a naive per-pixel reference written
// straight from the documented definition, plus window edges, median selection, ghost protection, noise reduction,
// equivalence with Frame Averaging's Moving Window, determinism and cancellation.
import { medianInPlace, smoothFrame, smoothingWeight, smoothingWindow, smoothOptions, temporalFilters, type SmoothOptions } from "../src/engine/filters/temporal";
import type { Frame } from "../src/engine/frame";
import type { Stream } from "../src/engine/stream";
import { defaultParams, FILTERS } from "../src/shared/filters";

let fail = 0;
const check = (name: string, ok: boolean, info = "") => { if (!ok) { fail++; console.log("FAIL", name, info); } else console.log("ok  ", name, info); };

function prng(seed: number) { let a = seed >>> 0; return () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; }; }
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/** Static textured background with noise and a bright square moving `speed` px per frame (alpha 255). */
function makeClip(n: number, w: number, h: number, seed: number, noise: number, speed = 3, size = 5, fractional = true): Frame[] {
  const r = prng(seed), frames: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Float32Array(w * h * 4), ox = 2 + i * speed, oy = Math.floor(h / 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4, inObj = x >= ox && x < ox + size && y >= oy && y < oy + size;
      for (let c = 0; c < 3; c++) {
        const base = inObj ? 220 - 10 * c : 90 + 20 * Math.sin(x * 0.7 + c) + 15 * Math.cos(y * 0.5);
        const v = base + noise * gauss(r);
        d[q + c] = fractional ? v : Math.round(v);
      }
      d[q + 3] = 255;
    }
    frames.push({ w, h, d });
  }
  return frames;
}

/** Naive reference: every output pixel computed directly from the definition. */
function reference(frames: Frame[], i: number, o: SmoothOptions): Frame {
  const n = frames.length, cur = frames[i], { w, h } = cur;
  const before = Math.floor((o.size - 1) / 2), a = Math.max(0, i - before), b = Math.min(n - 1, i - before + o.size - 1);
  if (a === b) return cur;
  const cx = (x: number) => Math.min(w - 1, Math.max(0, x)), cy = (y: number) => Math.min(h - 1, Math.max(0, y));
  // largest absolute R/G/B difference, then the 1-2-1 x 1-2-1 weighted 3x3 sum against 16 x threshold
  const md = (f: Frame, x: number, y: number) => {
    const q = (y * w + x) * 4;
    return Math.fround(Math.max(Math.abs(f.d[q] - cur.d[q]), Math.abs(f.d[q + 1] - cur.d[q + 1]), Math.abs(f.d[q + 2] - cur.d[q + 2])));
  };
  const still = (f: Frame, x: number, y: number) => {
    const row = (yy: number) => Math.fround(md(f, cx(x - 1), yy) + 2 * md(f, x, yy) + md(f, cx(x + 1), yy));
    return row(cy(y - 1)) + 2 * row(y) + row(cy(y + 1)) <= 16 * o.threshold;
  };
  const weight = (k: number) => (o.method === "gaussian" ? Math.fround(Math.exp(-(k * k) / (2 * (o.size / 4) * (o.size / 4)))) : 1);
  const median = (v: number[]) => { const s = [...v].sort((p, q) => p - q), m = s.length >> 1; return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const out = new Float32Array(w * h * 4);
  let total = 0;
  for (let j = a; j <= b; j++) total += weight(j - i);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const q = (y * w + x) * 4, acc = [0, 0, 0], vals: number[][] = [[], [], []];
    let ws = 0;
    for (let j = a; j <= b; j++) {
      const f = frames[j];
      if (o.protect && j !== i && !still(f, x, y)) continue;
      const wk = weight(j - i);
      for (let c = 0; c < 3; c++) { acc[c] += wk * f.d[q + c]; vals[c].push(f.d[q + c]); }
      ws += wk;
    }
    for (let c = 0; c < 3; c++) out[q + c] = o.method === "median" ? median(vals[c]) : acc[c] / ws;
    out[q + 3] = cur.d[q + 3];
    if (o.showMask && o.protect) {
      // gray image, red where weight was left out
      const s = 0.6 * (1 - (o.method === "median" ? vals[0].length / (b - a + 1) : ws / total));
      const g = 0.299 * out[q] + 0.587 * out[q + 1] + 0.114 * out[q + 2];
      out[q] = g + (255 - g) * s; out[q + 1] = g * (1 - s); out[q + 2] = g * (1 - s);
    }
  }
  return { w, h, d: out };
}

const diffCount = (x: Float32Array, y: Float32Array) => { let c = 0; for (let k = 0; k < x.length; k++) if (!Object.is(x[k], y[k])) c++; return c; };
const getter = (frames: Frame[]) => (j: number) => Promise.resolve(frames[j]);
const streamOf = (frames: Frame[]): Stream => ({
  info: { width: frames[0].w, height: frames[0].h, frameCount: frames.length, fps: 25 },
  getFrame: async (i) => frames[i], meta: (i) => ({ pts: i / 25, type: "P", src: i }),
});
const ctx = { isStale: () => false, progress: () => {} } as never;
const o = (size: number, method: SmoothOptions["method"], protect: boolean, threshold = 12, showMask = false): SmoothOptions => ({ size, method, protect, threshold, showMask });

// ---------------------------------------------------------------- window and weights
{
  const W = (i: number, n: number, s: number) => smoothingWindow(i, n, s).join("-");
  check("window size 5 is centered", W(5, 10, 5) === "3-7");
  check("window size 4 takes the extra frame after (as Frame Averaging)", W(5, 10, 4) === "4-7");
  check("window clipped at the start", W(0, 10, 5) === "0-2" && W(1, 10, 5) === "0-3");
  check("window clipped at the end", W(9, 10, 5) === "7-9" && W(8, 10, 5) === "6-9");
  check("window of a single-frame clip", W(0, 1, 9) === "0-0");
  check("mean weights are all 1", [0, 1, 2, 7].every((k) => smoothingWeight("mean", k, 5) === 1));
  const g = [-2, -1, 0, 1, 2].map((k) => smoothingWeight("gaussian", k, 5));
  check("gaussian weights symmetric, 1 at the current frame, decreasing", g[2] === 1 && g[0] === g[4] && g[1] === g[3] && g[0] < g[1] && g[1] < 1);
  check("gaussian weights are float32 values", g.every((v) => Math.fround(v) === v), g.map((v) => v.toFixed(4)).join(" "));
}

// ---------------------------------------------------------------- median selection (insertion sort ≤ 16, Wirth's selection above)
{
  const r = prng(99);
  let bad = 0;
  for (let len = 1; len <= 40; len++) for (let rep = 0; rep < 30; rep++) {
    const v = Array.from({ length: len }, () => (rep % 3 === 0 ? Math.round(r() * 6) : Math.fround(r() * 255)));
    const s = [...v].sort((p, q) => p - q), m = len >> 1, want = len & 1 ? s[m] : (s[m - 1] + s[m]) / 2;
    const buf = new Float64Array(len + 3); buf.set(v);
    if (medianInPlace(buf, len) !== want) bad++;
  }
  check("medianInPlace == sort, lengths 1-40 with ties", bad === 0, `${bad} mismatches`);
}

// ---------------------------------------------------------------- bit-exact against the reference
{
  const n = 9, w = 23, h = 17;
  const clips = [makeClip(n, w, h, 1, 4), makeClip(n, w, h, 2, 10, 2, 6, false)];
  let cases = 0, bad = 0;
  const failures: string[] = [];
  for (const [ci, frames] of clips.entries()) for (const size of [2, 3, 4, 5, 7]) for (const method of ["mean", "gaussian", "median"] as const)
    for (const [protect, threshold, showMask] of [[false, 12, false], [true, 6, false], [true, 12, false], [true, 30, true]] as const) {
      const opt = o(size, method, protect, threshold, showMask);
      for (let i = 0; i < n; i++) {
        const got = await smoothFrame(getter(frames), i, n, opt), want = reference(frames, i, opt);
        cases++;
        const d = diffCount(got.d, want.d);
        if (d) { bad++; if (failures.length < 5) failures.push(`clip${ci} size ${size} ${method} protect ${protect} T ${threshold} mask ${showMask} frame ${i}: ${d} values`); }
      }
    }
  check("smoothFrame == reference (2 clips × 5 sizes × 3 methods × 4 protection settings × every frame)", bad === 0, `${cases} frames, ${bad} differ ${failures.join("; ")}`);
  // large window: median above 16 values (Wirth path) and long gaussian windows
  const long = makeClip(25, 13, 9, 3, 6, 1, 3);
  let bad2 = 0;
  for (const method of ["median", "gaussian", "mean"] as const) for (const protect of [false, true]) for (const i of [0, 5, 12, 20, 24]) {
    const opt = o(31, method, protect, 15);
    if (diffCount((await smoothFrame(getter(long), i, 25, opt)).d, reference(long, i, opt).d)) bad2++;
  }
  check("size 31 windows (median by selection) == reference", bad2 === 0, `${bad2} frames differ`);
  // frames larger than one accumulation block (8192 pixels, last block partial), kept and streamed
  const big = makeClip(6, 131, 97, 4, 8, 9, 20);
  let bad3 = 0, cases3 = 0;
  for (const method of ["mean", "gaussian", "median"] as const) for (const protect of [false, true]) for (const holdBytes of [undefined, 0]) for (const i of [0, 2, 5]) {
    if (method === "median" && holdBytes === 0) continue;
    const opt = { ...o(5, method, protect, 12, protect), holdBytes };
    cases3++;
    if (diffCount((await smoothFrame(getter(big), i, 6, opt)).d, reference(big, i, opt).d)) bad3++;
  }
  check("multi-block frames, kept and streamed == reference", bad3 === 0, `${cases3} frames, ${bad3} differ`);
  // streamed (windows too large to keep in memory) == kept, on the whole matrix
  let bad4 = 0, cases4 = 0;
  for (const [ci, frames] of clips.entries()) for (const size of [2, 3, 5, 7]) for (const method of ["mean", "gaussian"] as const) for (const protect of [false, true]) for (let i = 0; i < n; i++) {
    const opt = o(size, method, protect, 12, protect);
    cases4++;
    if (diffCount((await smoothFrame(getter(frames), i, n, { ...opt, holdBytes: 0 })).d, (await smoothFrame(getter(frames), i, n, opt)).d)) { bad4++; void ci; }
  }
  check("streamed == kept (bit-identical)", bad4 === 0, `${cases4} frames, ${bad4} differ`);
}

// ---------------------------------------------------------------- behaviour
{
  // ghosts: a bright square crossing a noisy static background
  const n = 9, w = 48, h = 24, frames = makeClip(n, w, h, 7, 3, 4, 5), i = 4;
  const objAt = (k: number, x: number, y: number) => x >= 2 + k * 4 && x < 7 + k * 4 && y >= 8 && y < 13;
  const ghost = (out: Frame) => {
    let worst = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (objAt(i, x, y)) continue;
      let near = false;
      for (let k = i - 2; k <= i + 2; k++) if (k !== i && objAt(k, x, y)) near = true;
      if (!near) continue;
      const q = (y * w + x) * 4, bg = 90 + 20 * Math.sin(x * 0.7) + 15 * Math.cos(y * 0.5);
      worst = Math.max(worst, out.d[q] - bg);
    }
    return worst;
  };
  const plain = await smoothFrame(getter(frames), i, n, o(5, "mean", false));
  const prot = await smoothFrame(getter(frames), i, n, o(5, "mean", true, 12));
  check("without protection the moving square leaves ghosts", ghost(plain) > 15, `max ghost ${ghost(plain).toFixed(1)} levels`);
  check("with protection no ghost trails", ghost(prot) < 9, `max ghost ${ghost(prot).toFixed(1)} levels`);
  let objKept = 0, objN = 0;
  for (let y = 8; y < 13; y++) for (let x = 18; x < 23; x++) { objN++; if (Math.abs(prot.d[(y * w + x) * 4] - frames[i].d[(y * w + x) * 4]) < 1e-3) objKept++; }
  check("with protection the moving square itself is not diluted", objKept === objN, `${objKept}/${objN} pixels unchanged`);
  const masked = await smoothFrame(getter(frames), i, n, o(5, "mean", true, 12, true));
  let tinted = 0, tintedFar = 0, grayElsewhere = true;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const q = (y * w + x) * 4, red = masked.d[q] - masked.d[q + 1];
    if (red > 1) { tinted++; if (y < 5 || y > 16) tintedFar++; }
    else if (Math.abs(masked.d[q + 1] - masked.d[q + 2]) > 1e-3 || Math.abs(red) > 1e-3) grayElsewhere = false;
  }
  check("Show Protected Areas: red on the moving square's path only, gray elsewhere", tinted > 40 && tintedFar === 0 && grayElsewhere, `${tinted} marked, ${tintedFar} far from the path`);
  // the marks show on a red subject too (the old red tint vanished on red)
  const redClip = makeClip(n, w, h, 7, 3, 4, 5).map((f) => { const d = new Float32Array(f.d); for (let p = 0; p < w * h; p++) if (d[p * 4] < 200) { d[p * 4] = 230; d[p * 4 + 1] = 20 + (d[p * 4 + 1] - 90) * 0.1; d[p * 4 + 2] = 20; } return { w, h, d }; });
  const onRed = await smoothFrame(getter(redClip), i, n, o(5, "mean", true, 12, true));
  let marked = 0;
  for (let p = 0; p < w * h; p++) if (onRed.d[p * 4] - onRed.d[p * 4 + 1] > 30) marked++;
  check("Show Protected Areas is visible on a red background", marked > 40, `${marked} marked pixels`);
}
{
  // a square of another color but the same brightness crossing a gray background: a brightness (luma) test misses it
  const n = 7, w = 40, h = 20, i = 3, r = prng(21), frames: Frame[] = [];
  const bg = [128, 128, 128], obj = [200, 100, (128 - 0.299 * 200 - 0.587 * 100) / 0.114];
  const inObj = (k: number, x: number, y: number) => x >= 3 + 4 * k && x < 9 + 4 * k && y >= 7 && y < 13;
  for (let k = 0; k < n; k++) {
    const d = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const q = (y * w + x) * 4; for (let c = 0; c < 3; c++) d[q + c] = (inObj(k, x, y) ? obj[c] : bg[c]) + 1.5 * gauss(r); d[q + 3] = 255; }
    frames.push({ w, h, d });
  }
  const lumaOf = (c: number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const colorGhost = (out: Frame) => {
    let worst = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (inObj(i, x, y)) continue;
      let crossed = false;
      for (let k = i - 2; k <= i + 2; k++) if (k !== i && inObj(k, x, y)) crossed = true;
      if (crossed) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(out.d[(y * w + x) * 4 + c] - 128));
    }
    return worst;
  };
  const plainG = colorGhost(await smoothFrame(getter(frames), i, n, o(5, "mean", false)));
  const protG = colorGhost(await smoothFrame(getter(frames), i, n, o(5, "mean", true, 12)));
  check("same-brightness color square: identical luma, different color", Math.abs(lumaOf(obj) - lumaOf(bg)) < 1e-9 && obj[0] - bg[0] === 72);
  check("same-brightness color square: unprotected leaves a color ghost", plainG > 12, `max ${plainG.toFixed(1)} levels`);
  check("same-brightness color square: protection leaves none", protG < 6, `max ${protG.toFixed(1)} levels`);
}
{
  // noise reduction on a static scene: ~1/sqrt(N) of the noise; protection must not get in the way of plain noise
  const n = 9, w = 64, h = 48, sigma = 5, r = prng(5), frames: Frame[] = [];
  for (let k = 0; k < n; k++) { const d = new Float32Array(w * h * 4); for (let p = 0; p < w * h; p++) { for (let c = 0; c < 3; c++) d[p * 4 + c] = 120 + sigma * gauss(r); d[p * 4 + 3] = 255; } frames.push({ w, h, d }); }
  const sd = (f: Frame) => { let s = 0, s2 = 0, m = 0; for (let p = 0; p < w * h; p++) { const v = f.d[p * 4]; s += v; s2 += v * v; m++; } return Math.sqrt(s2 / m - (s / m) ** 2); };
  const before = sd(frames[4]);
  for (const [method, protect, maxRatio] of [["mean", false, 0.5], ["mean", true, 0.55], ["gaussian", true, 0.6], ["median", true, 0.65]] as const) {
    const ratio = sd(await smoothFrame(getter(frames), 4, n, o(5, method, protect, 12))) / before;
    check(`static noise reduced (size 5, ${method}${protect ? ", protected" : ""})`, ratio < maxRatio, `noise × ${ratio.toFixed(3)} (ideal mean ${(1 / Math.sqrt(5)).toFixed(3)})`);
  }
  // a clip of identical frames passes through unchanged (every method, protected or not)
  const same = Array.from({ length: 5 }, () => frames[0]);
  let changed = 0;
  for (const method of ["mean", "gaussian", "median"] as const) for (const protect of [false, true]) {
    const out = await smoothFrame(getter(same), 2, 5, o(5, method, protect));
    for (let k = 0; k < out.d.length; k++) if (Math.abs(out.d[k] - frames[0].d[k]) > 1e-4 * Math.max(1, Math.abs(frames[0].d[k]))) { changed++; break; }
  }
  check("identical frames are left as they are", changed === 0, `${changed} settings changed the image`);
}

// ---------------------------------------------------------------- the filter as wired in the engine
{
  const frames = makeClip(12, 31, 19, 11, 6), s = streamOf(frames);
  const defs = defaultParams(FILTERS.temporal_smoothing);
  check("defaults: size 5, mean, protection on at 12 levels, no tint",
    JSON.stringify(smoothOptions(defs)) === JSON.stringify({ size: 5, method: "mean", protect: true, threshold: 12, showMask: false }), JSON.stringify(defs));
  check("registered in the Integrate category as a temporal filter", FILTERS.temporal_smoothing.category === "Integrate" && FILTERS.temporal_smoothing.temporal === true && !!FILTERS.temporal_smoothing.reference);
  const ts = await temporalFilters.temporal_smoothing(s, defs, ctx);
  check("frame count, size and timing unchanged", ts.info.frameCount === 12 && ts.info.width === 31 && ts.info.height === 19 && ts.meta(7).pts === 7 / 25);
  let bad = 0;
  for (let i = 0; i < 12; i++) if (diffCount((await ts.getFrame(i)).d, reference(frames, i, smoothOptions(defs)).d)) bad++;
  check("engine filter (defaults) == reference on every frame", bad === 0, `${bad} frames differ`);
  // Mean without protection == Frame Averaging's Moving Window wherever the two windows coincide (not at the start,
  // where Frame Averaging shifts its window instead of shrinking it)
  for (const size of [3, 4, 5, 8]) {
    const tsm = await temporalFilters.temporal_smoothing(s, { size, method: "mean", protect: false, threshold: 12, showMask: false }, ctx);
    const fa = await temporalFilters.frame_averaging(s, { mode: "window", window: size, method: "mean", sigma: 2 }, ctx);
    let eq = 0, total = 0;
    for (let i = Math.floor((size - 1) / 2); i < 12; i++) { total++; if (!diffCount((await tsm.getFrame(i)).d, (await fa.getFrame(i)).d)) eq++; }
    check(`mean, unprotected, size ${size} == Frame Averaging moving window`, eq === total, `${eq}/${total} frames identical`);
  }
  // deterministic: same input, same output, every time
  const run = async () => { const t = await temporalFilters.temporal_smoothing(s, { ...defs, method: "gaussian" }, ctx); return (await t.getFrame(6)).d; };
  check("bit-exact on repeated runs", diffCount(await run(), await run()) === 0);
  // a still image (one frame) is returned untouched
  const one = streamOf([frames[0]]), still = await temporalFilters.temporal_smoothing(one, defs, ctx);
  check("single frame: output is the input", (await still.getFrame(0)) === frames[0]);
  // cancellation is honoured between frames
  let stale = false;
  const ts2 = await temporalFilters.temporal_smoothing(s, defs, { isStale: () => stale, progress: () => {} } as never);
  stale = true;
  let msg = "";
  try { await ts2.getFrame(5); } catch (e) { msg = (e as Error).message; }
  check("stops when the render is superseded", msg === "Cancelled", msg);
}

// ---------------------------------------------------------------- speed (informative)
{
  const w = 1920, h = 1080, frames: Frame[] = [];
  for (let k = 0; k < 5; k++) { const d = new Float32Array(w * h * 4); for (let p = 0; p < d.length; p++) d[p] = (p * 7 + k * 13) % 251; frames.push({ w, h, d }); }
  for (const [method, protect] of [["mean", false], ["mean", true], ["median", true]] as const) {
    const t0 = performance.now();
    await smoothFrame(getter(frames), 2, 5, o(5, method, protect));
    console.log(`info  1080p, size 5, ${method}${protect ? ", protected" : ""}: ${(performance.now() - t0).toFixed(0)} ms per frame`);
  }
}

console.log(fail ? `${fail} FAILED` : "temporal: all tests passed");
process.exit(fail ? 1 : 0);
