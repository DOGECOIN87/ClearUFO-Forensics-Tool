// YUV → RGB conversion of decoded video:
//  1. the replicate (Nearest) path is bit-identical to the converter of earlier versions (reproducibility),
//  2. Bilinear and Bicubic chroma reconstruction reproduce linear ramps exactly for all six chroma sitings,
//  3. constant chroma passes through every filter unchanged, edges included,
//  4. the complete conversion (matrix, range, bit depth, siting, filter) matches zimg (ffmpeg zscale), an
//     independent floating point implementation, for 8/10-bit, 4:2:0/4:2:2, BT.601/709/2020, limited/full.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alloc, type Frame } from "../src/engine/frame";
import { formatInfo, SITINGS, yuvToFrame, type ChromaFilter, type Matrix, type Siting, type YuvParams } from "../src/engine/sources/yuv";

let fail = 0, pass = 0;
const ok = (cond: unknown, msg: string) => { if (cond) { pass++; if (process.env.VERBOSE) console.log("ok  ", msg); } else { fail++; console.log("FAIL", msg); } };
let seed = 777;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

interface Planes { buf: Uint8Array; layout: { offset: number; stride: number }[] }
/** Build a frame in a WebCodecs pixel format; strides are padded to exercise the layout handling. */
function makePlanes(format: string, w: number, h: number, sample: (plane: number, x: number, y: number) => number): Planes {
  const { bits, nv12, sx, sy } = formatInfo(format);
  const bps = bits > 8 ? 2 : 1;
  const cw = (w + (1 << sx) - 1) >> sx, ch = (h + (1 << sy) - 1) >> sy;
  const ys = w * bps + 6, cs = (nv12 ? cw * 2 : cw) * bps + 4;
  const planes = nv12 ? [[ys, h], [cs, ch]] : [[ys, h], [cs, ch], [cs, ch]];
  const layout: { offset: number; stride: number }[] = [];
  let size = 0;
  for (const [stride, rows] of planes) { layout.push({ offset: size, stride }); size += stride * rows + 8; }
  const buf = new Uint8Array(size);
  const put = (o: number, v: number) => { if (bps === 1) buf[o] = v; else { buf[o] = v & 255; buf[o + 1] = v >> 8; } };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(layout[0].offset + y * ys + x * bps, sample(0, x, y));
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
    if (nv12) { put(layout[1].offset + j * cs + i * 2, sample(1, i, j)); put(layout[1].offset + j * cs + i * 2 + 1, sample(2, i, j)); }
    else { put(layout[1].offset + j * cs + i * bps, sample(1, i, j)); put(layout[2].offset + j * cs + i * bps, sample(2, i, j)); }
  }
  return { buf, layout };
}

// ---------------------------------------------------------------- 1. verbatim copy of the earlier converter
function legacy(buf: Uint8Array, layout: { offset: number; stride: number }[], format: string, w: number, h: number, p: { matrix: "bt601" | "bt709"; full: boolean }): Frame {
  const out = alloc(w, h, true);
  const d = out.d;
  const [Kr, Kb] = p.matrix === "bt709" ? [0.2126, 0.0722] : [0.299, 0.114];
  const Kg = 1 - Kr - Kb;
  const ys = p.full ? 1 : 255 / 219, yo = p.full ? 0 : 16, cs = p.full ? 1 : 255 / 224;
  const crR = 2 * (1 - Kr) * cs, cbB = 2 * (1 - Kb) * cs;
  const cbG = (-2 * (1 - Kb) * Kb / Kg) * cs, crG = (-2 * (1 - Kr) * Kr / Kg) * cs;
  const highBit = /P1[02]$/.test(format);
  const shift = format.endsWith("P10") ? 4 : format.endsWith("P12") ? 16 : 1;
  const nv12 = format === "NV12";
  const sx = format.startsWith("I444") ? 0 : 1;
  const sy = format.startsWith("I420") || nv12 ? 1 : 0;
  const view16 = highBit ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength) : null;
  const L0 = layout[0], L1 = layout[1], L2 = nv12 ? layout[1] : layout[2];
  if (!highBit) {
    for (let y = 0; y < h; y++) {
      const yRow = L0.offset + y * L0.stride, cy = y >> sy;
      const uRow = L1.offset + cy * L1.stride, vRow = L2.offset + cy * L2.stride;
      let o = y * w * 4;
      for (let x = 0; x < w; x++, o += 4) {
        const cx = x >> sx;
        const yy = (buf[yRow + x] - yo) * ys;
        let u: number, v: number;
        if (nv12) { const k = uRow + cx * 2; u = buf[k] - 128; v = buf[k + 1] - 128; }
        else { u = buf[uRow + cx] - 128; v = buf[vRow + cx] - 128; }
        d[o] = yy + crR * v; d[o + 1] = yy + cbG * u + crG * v; d[o + 2] = yy + cbB * u;
      }
    }
    return out;
  }
  const read = (pl: { offset: number; stride: number }, x: number, y: number) => view16!.getUint16(pl.offset + y * pl.stride + x * 2, true) / shift;
  for (let y = 0; y < h; y++) {
    const cy = y >> sy;
    for (let x = 0; x < w; x++) {
      const cx = x >> sx;
      const Y = read(L0, x, y), U = read(L1, cx, cy), V = read(L2, cx, cy);
      const yy = (Y - yo) * ys, u = U - 128, v = V - 128;
      const i = (y * w + x) * 4;
      d[i] = yy + crR * v; d[i + 1] = yy + cbG * u + crG * v; d[i + 2] = yy + cbB * u;
    }
  }
  return out;
}

const identical = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
for (const format of ["I420", "I422", "I444", "NV12", "I420P10", "I422P10", "I444P12", "I420AP10"]) {
  const { bits } = formatInfo(format);
  const max = (1 << bits) - 1;
  for (const matrix of ["bt601", "bt709"] as const) for (const full of bits === 8 ? [false, true] : [false]) {
    const w = 37, h = 23; // odd sizes: chroma planes round up
    const pl = makePlanes(format, w, h, () => Math.floor(rnd() * (max + 1)));
    const a = yuvToFrame(pl.buf, pl.layout, format, w, h, { matrix, full, chroma: "nearest", siting: "left" }).d;
    const b = legacy(pl.buf, pl.layout, format, w, h, { matrix, full }).d;
    ok(identical(a, b), `Nearest is bit-identical to the earlier converter: ${format} ${matrix} ${full ? "full" : "limited"}`);
  }
}
// 4:4:4 has nothing to upsample: every filter gives the replicate result exactly
{
  const pl = makePlanes("I444", 20, 12, () => Math.floor(rnd() * 256));
  const n = yuvToFrame(pl.buf, pl.layout, "I444", 20, 12, { matrix: "bt709", full: false, chroma: "nearest", siting: "left" }).d;
  for (const chroma of ["bilinear", "bicubic"] as const) ok(identical(n, yuvToFrame(pl.buf, pl.layout, "I444", 20, 12, { matrix: "bt709", full: false, chroma, siting: "center" }).d), `4:4:4 ${chroma} = replicate`);
}
// full range 10/12-bit: white is 2^n − 1 (H.273), not 255 × 2^(n−8)
for (const [format, white] of [["I420P10", 1023], ["I420P12", 4095]] as const) {
  const pl = makePlanes(format, 8, 8, (p) => (p === 0 ? white : 1 << (formatInfo(format).bits - 1)));
  const f = yuvToFrame(pl.buf, pl.layout, format, 8, 8, { matrix: "bt709", full: true, chroma: "bicubic", siting: "left" });
  ok(Math.abs(f.d[0] - 255) < 1e-4 && Math.abs(f.d[1] - 255) < 1e-4 && Math.abs(f.d[2] - 255) < 1e-4, `${format} full-range white maps to 255 (${f.d[0]})`);
}

// ---------------------------------------------------------------- 2. linear ramps are reproduced exactly
const SITE: Record<Siting, [number, number]> = { left: [0, 0.5], center: [0.5, 0.5], topleft: [0, 0], top: [0.5, 0], bottomleft: [0, 1], bottom: [0.5, 1] };
function coef(matrix: Matrix) {
  const [Kr, Kb] = matrix === "bt709" ? [0.2126, 0.0722] : matrix === "bt2020" ? [0.2627, 0.0593] : [0.299, 0.114];
  return { crR: 2 * (1 - Kr) * 255 / 224, cbB: 2 * (1 - Kb) * 255 / 224 };
}
for (const format of ["I420", "I422", "NV12", "I420P10"]) for (const chroma of ["bilinear", "bicubic"] as const) for (const siting of SITINGS) {
  const { bits, sx, sy } = formatInfo(format);
  const k = bits === 10 ? 4 : 1, w = 40, h = 26;
  const U = (i: number, j: number) => 60 + 3 * i + 2 * j, V = (i: number, j: number) => 200 - 2 * i - 3 * j;
  const pl = makePlanes(format, w, h, (p, i, j) => (p === 0 ? 128 * k : p === 1 ? U(i, j) * k : V(i, j) * k));
  const P: YuvParams = { matrix: "bt601", full: false, chroma, siting };
  const f = yuvToFrame(pl.buf, pl.layout, format, w, h, P);
  const { crR, cbB } = coef("bt601"), yy = (128 - 16) * 255 / 219;
  const [ox, oy] = SITE[siting];
  let worst = 0;
  for (let y = 4; y < h - 4; y++) for (let x = 4; x < w - 4; x++) {
    const cx = sx ? (x - ox) / 2 : x, cy = sy ? (y - oy) / 2 : y;
    const o = (y * w + x) * 4;
    const u = (f.d[o + 2] - yy) / cbB + 128, v = (f.d[o] - yy) / crR + 128;
    worst = Math.max(worst, Math.abs(u - U(cx, cy)), Math.abs(v - V(cx, cy)));
  }
  ok(worst < 2e-3, `${chroma} ${siting} ${format}: linear chroma ramp reproduced (max error ${worst.toExponential(2)})`);
}

// ---------------------------------------------------------------- 3. constant chroma is untouched (weights sum to one, edges too)
for (const format of ["I420", "I422P10"]) for (const chroma of ["bilinear", "bicubic"] as const) {
  const { bits } = formatInfo(format), k = bits === 10 ? 4 : 1;
  const pl = makePlanes(format, 23, 17, (p) => (p === 0 ? Math.floor(rnd() * 220 + 16) * k : p === 1 ? 90 * k : 170 * k));
  const a = yuvToFrame(pl.buf, pl.layout, format, 23, 17, { matrix: "bt709", full: false, chroma, siting: "left" }).d;
  const b = yuvToFrame(pl.buf, pl.layout, format, 23, 17, { matrix: "bt709", full: false, chroma: "nearest", siting: "left" }).d;
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  ok(worst < 1e-4, `${chroma} ${format}: constant chroma unchanged at every pixel (max ${worst.toExponential(2)})`);
}

// ---------------------------------------------------------------- 4. independent reference: zimg (ffmpeg zscale)
function ffmpegPath(): string | null {
  try { return execFileSync("python3", ["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"], { encoding: "utf8" }).trim() || null; } catch { return null; }
}
const FF = ffmpegPath();
if (!FF) console.log("SKIP zimg cross-check: ffmpeg (imageio-ffmpeg) is not installed");
else {
  const dir = mkdtempSync(join(tmpdir(), "lucid-yuv-"));
  const ZMAT: Record<Matrix, string> = { bt601: "470bg", bt709: "709", bt2020: "2020_ncl" };
  const cases: { format: string; pix: string; matrix: Matrix; full: boolean; sitings: Siting[] }[] = [
    { format: "I420", pix: "yuv420p", matrix: "bt601", full: false, sitings: [...SITINGS] },
    { format: "I420", pix: "yuv420p", matrix: "bt709", full: true, sitings: ["left", "center"] },
    { format: "I422", pix: "yuv422p", matrix: "bt709", full: false, sitings: ["left", "center"] },
    { format: "I420P10", pix: "yuv420p10le", matrix: "bt2020", full: false, sitings: ["left", "topleft"] },
    { format: "I420P10", pix: "yuv420p10le", matrix: "bt709", full: true, sitings: ["left"] },
  ];
  const w = 48, h = 32;
  for (const c of cases) {
    const { bits, sx, sy } = formatInfo(c.format), max = (1 << bits) - 1;
    // tightly packed planes for ffmpeg's rawvideo reader, the same samples for our converter
    const cw = w >> sx, ch = h >> sy, bps = bits > 8 ? 2 : 1;
    const raw = new Uint8Array((w * h + 2 * cw * ch) * bps);
    const put = (o: number, v: number) => { if (bps === 1) raw[o] = v; else { raw[o] = v & 255; raw[o + 1] = v >> 8; } };
    for (let i = 0; i < w * h + 2 * cw * ch; i++) put(i * bps, Math.floor(rnd() * (max + 1)));
    writeFileSync(join(dir, "in.yuv"), raw);
    const layout = [{ offset: 0, stride: w * bps }, { offset: w * h * bps, stride: cw * bps }, { offset: (w * h + cw * ch) * bps, stride: cw * bps }];
    for (const siting of c.sitings) for (const chroma of ["bilinear", "bicubic"] as ChromaFilter[]) {
      const zf = chroma === "bicubic" ? "filter=bicubic:param_a=0:param_b=0.5" : "filter=bilinear";
      const vf = `zscale=rangein=${c.full ? "full" : "limited"}:matrixin=${ZMAT[c.matrix]}:chromalin=${siting}:${zf}:dither=none:transferin=709:transfer=709:primariesin=709:primaries=709,format=gbrpf32le`;
      let ref: Buffer;
      try { ref = execFileSync(FF, ["-v", "error", "-f", "rawvideo", "-pix_fmt", c.pix, "-s", `${w}x${h}`, "-i", join(dir, "in.yuv"), "-vf", vf, "-f", "rawvideo", "-"], { maxBuffer: 1 << 26 }); }
      catch (e) { ok(false, `zscale failed for ${c.pix} ${siting}: ${(e as Error).message.slice(0, 200)}`); continue; }
      const z = new Float32Array(ref.buffer.slice(ref.byteOffset, ref.byteOffset + ref.byteLength));
      const f = yuvToFrame(raw, layout, c.format, w, h, { matrix: c.matrix, full: c.full, chroma, siting });
      let worst = 0, sum = 0, n = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { // the whole frame: edges are extended the same way
        const i = y * w + x, o = i * 4;
        // gbrp plane order: G, B, R; zimg works on 0..1
        const dg = Math.abs(f.d[o + 1] - z[i] * 255), db = Math.abs(f.d[o + 2] - z[w * h + i] * 255), dr = Math.abs(f.d[o] - z[2 * w * h + i] * 255);
        worst = Math.max(worst, dg, db, dr); sum += dg + db + dr; n += 3;
      }
      ok(worst < 0.02, `zimg agrees: ${c.pix} ${c.matrix} ${c.full ? "full" : "limited"} ${siting} ${chroma} (max |Δ| ${worst.toFixed(4)}, mean ${(sum / n).toFixed(5)} on 0..255)`);
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`yuv: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
