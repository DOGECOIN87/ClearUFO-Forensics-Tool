// Exact PNG decoder: every color type and bit depth, all five row filters, Adam7 interlacing, palettes
// with transparency, checked against a reference encoder written here and against files written and
// decoded by Python's PIL (an independent implementation).
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { crc32 } from "../src/shared/codecs/image";
import { decodePngExact } from "../src/shared/codecs/pngdecode";

let fail = 0, pass = 0;
const ok = (cond: unknown, msg: string) => { if (cond) pass++; else { fail++; console.log("FAIL", msg); } };
let seed = 4242;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

const CH: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

function chunk(id: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = id.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Reference encoder: `s` holds w*h*channels samples; filters cycle through 0..4 per row when filter < 0. */
function encodeRef(w: number, h: number, ct: number, depth: number, s: number[], o: { interlace?: boolean; filter?: number; plte?: number[]; trns?: number[] } = {}): Uint8Array {
  const ch = CH[ct], bitsPP = ch * depth, bpp = Math.max(1, bitsPP >> 3);
  const rows: number[] = [];
  let rowNo = 0;
  for (const [x0, y0, dx, dy] of o.interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rb = Math.ceil((pw * bitsPP) / 8);
    let prev = new Uint8Array(rb);
    for (let r = 0; r < ph; r++) {
      const raw = new Uint8Array(rb);
      for (let i = 0; i < pw; i++) {
        const px = ((y0 + r * dy) * w + x0 + i * dx) * ch;
        for (let c = 0; c < ch; c++) {
          const v = s[px + c];
          if (depth === 16) { raw[(i * ch + c) * 2] = v >> 8; raw[(i * ch + c) * 2 + 1] = v & 255; }
          else if (depth === 8) raw[i * ch + c] = v;
          else { const bit = i * depth; raw[bit >> 3] |= v << (8 - depth - (bit & 7)); }
        }
      }
      const ft = o.filter === undefined ? 0 : o.filter < 0 ? rowNo++ % 5 : o.filter;
      const f = new Uint8Array(rb);
      for (let i = 0; i < rb; i++) {
        const a = i >= bpp ? raw[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        f[i] = (raw[i] - pred) & 255;
      }
      rows.push(ft, ...f);
      prev = raw;
    }
  }
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = depth; ihdr[9] = ct; ihdr[12] = o.interlace ? 1 : 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
  if (o.plte) parts.push(chunk("PLTE", Uint8Array.from(o.plte)));
  if (o.trns) parts.push(chunk("tRNS", Uint8Array.from(o.trns)));
  const z = deflateSync(Uint8Array.from(rows));
  // split the data over two IDAT chunks
  const cut = z.length >> 1;
  parts.push(chunk("IDAT", z.subarray(0, cut)), chunk("IDAT", z.subarray(cut)), chunk("IEND", new Uint8Array(0)));
  const total = parts.reduce((n, p) => n + p.length, 0), out = new Uint8Array(total);
  let p = 0;
  for (const x of parts) { out.set(x, p); p += x.length; }
  return out;
}

/** Expected RGBA (0–255 scale) of the reference samples. */
function expected(w: number, h: number, ct: number, depth: number, s: number[], plte?: number[], trns?: number[]): Float32Array {
  const ch = CH[ct], out = new Float32Array(w * h * 4), max = (1 << depth) - 1;
  const sc = (v: number) => (depth === 16 ? v / 257 : depth === 8 ? v : (v * 255) / max);
  for (let i = 0; i < w * h; i++) {
    const q = s.slice(i * ch, i * ch + ch), o = i * 4;
    if (ct === 3) { out[o] = plte![q[0] * 3]; out[o + 1] = plte![q[0] * 3 + 1]; out[o + 2] = plte![q[0] * 3 + 2]; out[o + 3] = trns && q[0] < trns.length ? trns[q[0]] : 255; }
    else if (ct === 0) { out[o] = out[o + 1] = out[o + 2] = sc(q[0]); out[o + 3] = trns && q[0] === ((trns[0] << 8) | trns[1]) ? 0 : 255; }
    else if (ct === 4) { out[o] = out[o + 1] = out[o + 2] = sc(q[0]); out[o + 3] = sc(q[1]); }
    else if (ct === 2) { out[o] = sc(q[0]); out[o + 1] = sc(q[1]); out[o + 2] = sc(q[2]); out[o + 3] = trns && q[0] === ((trns[0] << 8) | trns[1]) && q[1] === ((trns[2] << 8) | trns[3]) && q[2] === ((trns[4] << 8) | trns[5]) ? 0 : 255; }
    else { out[o] = sc(q[0]); out[o + 1] = sc(q[1]); out[o + 2] = sc(q[2]); out[o + 3] = sc(q[3]); }
  }
  return out;
}

const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const f32 = (a: Float32Array) => Float32Array.from(a); // expected values rounded like the decoder's output

for (const [ct, depths] of [[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]] as [number, number[]][]) {
  for (const depth of depths) {
    for (const [w, h] of [[1, 1], [3, 5], [17, 9], [33, 2]]) {
      for (const interlace of [false, true]) {
        const ch = CH[ct], max = ct === 3 ? Math.min((1 << depth) - 1, 9) : (1 << depth) - 1;
        const s = Array.from({ length: w * h * ch }, () => Math.round(rnd() * max));
        const plte = ct === 3 ? Array.from({ length: 30 }, () => (rnd() * 256) | 0) : undefined;
        const trns = ct === 3 ? [0, 128, 255, 7] : undefined;
        const png = encodeRef(w, h, ct, depth, s, { interlace, filter: -1, plte, trns });
        const d = await decodePngExact(png);
        ok(d.w === w && d.h === h && d.depth === depth && d.colorType === ct && d.interlaced === interlace && same(d.rgba, f32(expected(w, h, ct, depth, s, plte, trns))), `color type ${ct}, ${depth}-bit, ${w}×${h}${interlace ? ", Adam7" : ""}`);
      }
    }
  }
}
{
  // 16-bit samples keep their full precision (fractions of 8-bit levels)
  const s = [0, 1, 257, 32768, 65534, 65535];
  const d = await decodePngExact(encodeRef(2, 1, 2, 16, s));
  ok(d.rgba[1] === Math.fround(1 / 257) && d.rgba[3] === 255 && d.rgba[5] === Math.fround(65534 / 257) && d.rgba[6] === 255, "16-bit: 1/257 and 65534/257 are kept, not rounded to 8 bits");
  // tRNS for gray and RGB
  const g = await decodePngExact(encodeRef(3, 1, 0, 8, [5, 9, 5], { trns: [0, 5] }));
  ok(g.rgba[3] === 0 && g.rgba[7] === 255 && g.rgba[11] === 0, "tRNS: gray value 5 is transparent");
  const c = await decodePngExact(encodeRef(2, 1, 2, 16, [1, 2, 3, 1, 2, 4], { trns: [0, 1, 0, 2, 0, 3] }));
  ok(c.rgba[3] === 0 && c.rgba[7] === 255, "tRNS: one 16-bit RGB color is transparent");
  // damaged files are refused (the browser's decoder is then used)
  const good = encodeRef(4, 4, 2, 8, Array.from({ length: 48 }, (_, i) => i));
  const bad = good.slice(); bad[40] ^= 0xff;
  let msg = "";
  try { await decodePngExact(bad); } catch (e) { msg = (e as Error).message; }
  ok(/checksum/.test(msg), `a damaged chunk is reported (${msg})`);
  msg = "";
  try { await decodePngExact(good.subarray(0, good.length - 30)); } catch (e) { msg = (e as Error).message; }
  ok(msg !== "", `a truncated file is reported (${msg})`);
}

// ---- PIL: files written by an independent encoder (with its own filter choices), compared with PIL's pixels
{
  const dir = mkdtempSync("/tmp/lucid-png-");
  try {
    const script = `
import sys, json, numpy as np
from PIL import Image
d = sys.argv[1]; rng = np.random.default_rng(7); out = []
def save(name, im, **kw): im.save(f"{d}/{name}.png", **kw); out.append(name)
save("rgb8", Image.fromarray(rng.integers(0, 256, (37, 23, 3), dtype=np.uint8), "RGB"), optimize=True)
save("rgba8", Image.fromarray(rng.integers(0, 256, (19, 41, 4), dtype=np.uint8), "RGBA"), optimize=True)
save("gray8", Image.fromarray(rng.integers(0, 256, (30, 30), dtype=np.uint8), "L"))
save("gray16", Image.fromarray(rng.integers(0, 65536, (25, 31), dtype=np.uint16)))
save("la8", Image.fromarray(rng.integers(0, 256, (12, 9, 2), dtype=np.uint8), "LA"))
save("bw1", Image.fromarray(rng.integers(0, 2, (13, 21), dtype=np.uint8) * 255, "L").convert("1"))
p = Image.fromarray(rng.integers(0, 16, (20, 20), dtype=np.uint8), "P"); p.putpalette(list(rng.integers(0, 256, 48))); save("pal4", p, bits=4, transparency=3)
for n in out:
    im = Image.open(f"{d}/{n}.png"); im.load()
    m = im.mode
    if m == "1": a = np.array(im.convert("L"), dtype=np.float64)
    elif m == "P": a = np.array(im.convert("RGBA"), dtype=np.float64)
    else: a = np.array(im, dtype=np.float64)
    if a.ndim == 2: a = a[..., None]
    if m in ("I;16", "I;16B", "I"): a = a / 257
    h, w = a.shape[:2]
    rgba = np.zeros((h, w, 4)); rgba[..., 3] = 255
    if a.shape[2] == 1: rgba[..., 0:3] = a
    elif a.shape[2] == 2: rgba[..., 0:3] = a[..., 0:1]; rgba[..., 3] = a[..., 1]
    elif a.shape[2] == 3: rgba[..., 0:3] = a
    else: rgba[...] = a
    rgba.astype("<f4").tofile(f"{d}/{n}.f32")
print(json.dumps(out))`;
    const names = JSON.parse(execFileSync("python3", ["-c", script, dir], { encoding: "utf8" }).trim()) as string[];
    for (const n of names) {
      const d = await decodePngExact(new Uint8Array(readFileSync(`${dir}/${n}.png`)));
      const raw = readFileSync(`${dir}/${n}.f32`); // small files share Node's buffer pool: honor the offset
      const ref = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      ok(same(d.rgba, ref), `PIL ${n}: identical to PIL's decoded pixels (${d.depth}-bit, type ${d.colorType})`);
    }
  } catch (e) { ok(false, `PIL cross-check failed: ${(e as Error).message}`); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(fail ? `pngdecode: ${fail} failures, ${pass} passed` : `pngdecode: all ${pass} checks OK`);
process.exit(fail ? 1 : 0);
