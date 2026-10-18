// Exact PNG decoding: every color type, bit depths 1 to 16, palettes with transparency (tRNS) and
// Adam7 interlacing, inflated with the browser's DecompressionStream.
//
// Browsers decode PNG files to 8 bits per channel and hand the pixels over through a canvas, so 16-bit
// evidence loses precision and fingerprinting protections that perturb canvas readback can alter it.
// This decoder returns the stored samples themselves; 16-bit values keep their full precision. Gamma
// and ICC profiles are ignored, like everywhere in LUCID (pixels "as stored").
import { crc32 } from "./image";

export interface DecodedPng {
  w: number;
  h: number;
  /** Bits per sample as stored (1, 2, 4, 8 or 16). */
  depth: number;
  /** 0 gray, 2 RGB, 3 palette, 4 gray + alpha, 6 RGB + alpha. */
  colorType: number;
  interlaced: boolean;
  /** An animated PNG (only its default image is decoded here). */
  animated: boolean;
  /** RGBA, 0–255 scale (16-bit samples divided by 257, so fractions are kept). */
  rgba: Float32Array;
}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
// Adam7 passes: first column, first row, column step, row step
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

export const isPng = (b: Uint8Array) => b.length >= 8 && SIG.every((v, i) => b[i] === v);

/** zlib inflate with the platform's DecompressionStream (browsers, workers and Node 18+). */
export async function inflate(z: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) throw new Error("This browser cannot inflate PNG data (DecompressionStream)");
  const stream = new Blob([z as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DS("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodePngExact(b: Uint8Array): Promise<DecodedPng> {
  if (!isPng(b)) throw new Error("Not a PNG file");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let w = 0, h = 0, depth = 0, ct = -1, interlaced = false, animated = false;
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let p = 8, seenEnd = false;
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p);
    const id = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (p + 12 + len > b.length) throw new Error(`PNG chunk ${id} is truncated`);
    const data = b.subarray(p + 8, p + 8 + len);
    const critical = (b[p + 4] & 0x20) === 0;
    if (critical && crc32(b.subarray(p + 4, p + 8 + len)) !== dv.getUint32(p + 8 + len)) throw new Error(`PNG chunk ${id} has a bad checksum`);
    if (id === "IHDR") {
      w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = b[p + 16]; ct = b[p + 17];
      if (b[p + 18] !== 0 || b[p + 19] !== 0 || b[p + 20] > 1) throw new Error("Unknown PNG compression, filter or interlace method");
      interlaced = b[p + 20] === 1;
      if (!DEPTHS[ct]?.includes(depth)) throw new Error(`Invalid PNG color type ${ct} with ${depth}-bit samples`);
    } else if (id === "PLTE") palette = data.slice();
    else if (id === "tRNS") trns = data.slice();
    else if (id === "acTL") animated = true;
    else if (id === "IDAT") idat.push(data);
    else if (id === "IEND") { seenEnd = true; break; }
    p += 12 + len;
  }
  if (!w || !h) throw new Error("The PNG file has no image header");
  if (!idat.length) throw new Error("The PNG file has no image data");
  if (ct === 3 && !palette) throw new Error("The PNG file has no palette");
  if (!seenEnd && !idat.length) throw new Error("The PNG file is truncated");
  let zlen = 0;
  for (const c of idat) zlen += c.length;
  const z = new Uint8Array(zlen);
  zlen = 0;
  for (const c of idat) { z.set(c, zlen); zlen += c.length; }
  const raw = await inflate(z);

  const ch = CHANNELS[ct], bitsPP = ch * depth, bpp = Math.max(1, bitsPP >> 3);
  const out = new Float32Array(w * h * 4);
  const max = (1 << depth) - 1;
  // value = sample × mul / div: 16-bit ÷ 257 (fractions kept), 8-bit as is, 1–4-bit stretched to 0–255
  const mul = depth < 8 ? 255 : 1, div = depth === 16 ? 257 : depth === 8 ? 1 : max;
  // transparency of gray / RGB images: one color is fully transparent (compared as stored)
  const tGray = trns && ct === 0 && trns.length >= 2 ? (trns[0] << 8) | trns[1] : -1;
  const tRgb = trns && ct === 2 && trns.length >= 6 ? [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]] : null;
  const nPal = palette ? Math.floor(palette.length / 3) : 0;

  let pos = 0;
  for (const [x0, y0, dx, dy] of interlaced ? ADAM7 : [[0, 0, 1, 1]]) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bitsPP) / 8);
    let prev = new Uint8Array(rowBytes), cur = new Uint8Array(rowBytes);
    for (let r = 0; r < ph; r++) {
      if (pos + 1 + rowBytes > raw.length) throw new Error("The PNG image data is truncated");
      const ft = raw[pos];
      cur.set(raw.subarray(pos + 1, pos + 1 + rowBytes));
      pos += 1 + rowBytes;
      switch (ft) {
        case 0: break;
        case 1: for (let i = bpp; i < rowBytes; i++) cur[i] = (cur[i] + cur[i - bpp]) & 255; break;
        case 2: for (let i = 0; i < rowBytes; i++) cur[i] = (cur[i] + prev[i]) & 255; break;
        case 3: for (let i = 0; i < rowBytes; i++) cur[i] = (cur[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 255; break;
        case 4: for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0, bb = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
          const pa = Math.abs(bb - c), pb = Math.abs(a - c), pc = Math.abs(a + bb - 2 * c);
          cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c)) & 255;
        } break;
        default: throw new Error(`Invalid PNG row filter ${ft}`);
      }
      const y = y0 + r * dy;
      for (let i = 0; i < pw; i++) {
        const o = ((y * w) + x0 + i * dx) * 4;
        // samples of this pixel, as stored
        let s0: number, s1 = 0, s2 = 0, s3 = 0;
        if (depth === 16) {
          const q = i * ch * 2;
          s0 = (cur[q] << 8) | cur[q + 1];
          if (ch > 1) s1 = (cur[q + 2] << 8) | cur[q + 3];
          if (ch > 2) { s2 = (cur[q + 4] << 8) | cur[q + 5]; }
          if (ch > 3) s3 = (cur[q + 6] << 8) | cur[q + 7];
        } else if (depth === 8) {
          const q = i * ch;
          s0 = cur[q]; s1 = cur[q + 1]; s2 = cur[q + 2]; s3 = cur[q + 3];
        } else {
          const bit = i * depth;
          s0 = (cur[bit >> 3] >> (8 - depth - (bit & 7))) & max;
        }
        if (ct === 3) {
          if (s0 < nPal) { out[o] = palette![s0 * 3]; out[o + 1] = palette![s0 * 3 + 1]; out[o + 2] = palette![s0 * 3 + 2]; }
          out[o + 3] = trns && s0 < trns.length ? trns[s0] : 255;
        } else if (ct === 0) {
          out[o] = out[o + 1] = out[o + 2] = (s0 * mul) / div;
          out[o + 3] = s0 === tGray ? 0 : 255;
        } else if (ct === 4) {
          out[o] = out[o + 1] = out[o + 2] = s0 / div;
          out[o + 3] = s1 / div;
        } else if (ct === 2) {
          out[o] = s0 / div; out[o + 1] = s1 / div; out[o + 2] = s2 / div;
          out[o + 3] = tRgb && s0 === tRgb[0] && s1 === tRgb[1] && s2 === tRgb[2] ? 0 : 255;
        } else {
          out[o] = s0 / div; out[o + 1] = s1 / div; out[o + 2] = s2 / div; out[o + 3] = s3 / div;
        }
      }
      const t = prev; prev = cur; cur = t;
    }
  }
  return { w, h, depth, colorType: ct, interlaced, animated, rgba: out };
}
