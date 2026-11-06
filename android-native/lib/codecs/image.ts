// Uncompressed still images: TIFF (8 or 16 bits per channel, or 32-bit float), PNG (8 or 16 bits per
// channel, written with "stored" deflate blocks, so the file is uncompressed yet readable by every PNG
// decoder) and BMP (24-bit). Every sample is written as is: no compression, no quantization beyond the
// chosen bit depth. Matching decoders read the files back to verify exports.
//
// Samples are packed RGB, rows top to bottom: Uint8Array (8-bit), Uint16Array (16-bit, 0..65535) or
// Float32Array (32-bit float, 0.0..1.0 = black..white; out-of-range values are kept).

export type Samples = Uint8Array | Uint16Array | Float32Array;

// ---------------------------------------------------------------- checksums
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

/** CRC-32 (ZIP, PNG). Pass the previous result as `crc` to continue a running checksum. */
export function crc32(d: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Adler-32 (zlib). Pass the previous result to continue. */
export function adler32(d: Uint8Array, adler = 1): number {
  let a = adler & 0xffff, b = adler >>> 16;
  for (let i = 0; i < d.length;) {
    const end = Math.min(d.length, i + 5552);
    for (; i < end; i++) { a += d[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const bytesOf = (s: Samples) => new Uint8Array(s.buffer, s.byteOffset, s.byteLength);
const sampleBytes = (s: Samples) => (s instanceof Uint8Array ? 1 : s instanceof Uint16Array ? 2 : 4);

function checkSamples(w: number, h: number, s: Samples) {
  if (!(w > 0 && h > 0) || s.length !== w * h * 3) throw new Error(`Image data does not match ${w}×${h} RGB`);
}

// ---------------------------------------------------------------- TIFF
const TIFF_TAGS = 15;
const SOFTWARE = "LUCID Forensic Workbench";

function tiffLayout(w: number, h: number, bps: number, software: string) {
  const sw = new TextEncoder().encode(software + "\0");
  const ifdOff = 8, ifdSize = 2 + TIFF_TAGS * 12 + 4;
  const bpsOff = ifdOff + ifdSize, fmtOff = bpsOff + 6, resOff = fmtOff + 6, swOff = resOff + 16;
  const dataOff = (swOff + sw.length + 15) & ~15; // 16-byte aligned pixel data
  return { sw, ifdOff, bpsOff, fmtOff, resOff, swOff, dataOff, size: dataOff + w * h * 3 * bps };
}

export function tiffSize(w: number, h: number, bytesPerSample: 1 | 2 | 4, software = SOFTWARE): number {
  return tiffLayout(w, h, bytesPerSample, software).size;
}

/** Baseline little-endian RGB TIFF, uncompressed (Compression = 1), one strip. */
export function encodeTIFF(w: number, h: number, s: Samples, software = SOFTWARE): Uint8Array {
  checkSamples(w, h, s);
  const bps = sampleBytes(s), float = s instanceof Float32Array;
  const L = tiffLayout(w, h, bps, software);
  const b = new Uint8Array(L.size), dv = new DataView(b.buffer);
  b[0] = 0x49; b[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, L.ifdOff, true);
  dv.setUint16(L.ifdOff, TIFF_TAGS, true);
  let e = L.ifdOff + 2;
  const tag = (t: number, type: number, count: number, value: number) => {
    dv.setUint16(e, t, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, count, true);
    if (type === 3 && count === 1) dv.setUint16(e + 8, value, true); else dv.setUint32(e + 8, value, true);
    e += 12;
  };
  const SHORT = 3, LONG = 4, RATIONAL = 5, ASCII = 2;
  tag(256, LONG, 1, w);                         // ImageWidth
  tag(257, LONG, 1, h);                         // ImageLength
  tag(258, SHORT, 3, L.bpsOff);                 // BitsPerSample
  tag(259, SHORT, 1, 1);                        // Compression: none
  tag(262, SHORT, 1, 2);                        // PhotometricInterpretation: RGB
  tag(273, LONG, 1, L.dataOff);                 // StripOffsets
  tag(277, SHORT, 1, 3);                        // SamplesPerPixel
  tag(278, LONG, 1, h);                         // RowsPerStrip
  tag(279, LONG, 1, w * h * 3 * bps);           // StripByteCounts
  tag(282, RATIONAL, 1, L.resOff);              // XResolution
  tag(283, RATIONAL, 1, L.resOff + 8);          // YResolution
  tag(284, SHORT, 1, 1);                        // PlanarConfiguration: chunky
  tag(296, SHORT, 1, 2);                        // ResolutionUnit: inch
  tag(305, ASCII, L.sw.length, L.swOff);        // Software
  tag(339, SHORT, 3, L.fmtOff);                 // SampleFormat
  dv.setUint32(e, 0, true);                     // no next IFD
  for (let i = 0; i < 3; i++) {
    dv.setUint16(L.bpsOff + i * 2, bps * 8, true);
    dv.setUint16(L.fmtOff + i * 2, float ? 3 : 1, true);
  }
  dv.setUint32(L.resOff, 72, true); dv.setUint32(L.resOff + 4, 1, true); dv.setUint32(L.resOff + 8, 72, true); dv.setUint32(L.resOff + 12, 1, true);
  b.set(L.sw, L.swOff);
  if (bps === 1 || LE) b.set(bytesOf(s), L.dataOff);
  else if (bps === 2) for (let i = 0; i < s.length; i++) dv.setUint16(L.dataOff + i * 2, s[i], true);
  else for (let i = 0; i < s.length; i++) dv.setFloat32(L.dataOff + i * 4, s[i], true);
  return b;
}

/** Reads uncompressed chunky RGB TIFFs (8/16-bit integer or 32-bit float, either byte order, any strips). */
export function decodeTIFF(b: Uint8Array): { w: number; h: number; samples: Samples } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const le = b[0] === 0x49 && b[1] === 0x49;
  if (!(le || (b[0] === 0x4d && b[1] === 0x4d)) || dv.getUint16(2, le) !== 42) throw new Error("Not a TIFF file");
  const ifd = dv.getUint32(4, le), n = dv.getUint16(ifd, le);
  const tags = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12, t = dv.getUint16(e, le), type = dv.getUint16(e + 2, le), count = dv.getUint32(e + 4, le);
    const size = type === 3 ? 2 : type === 4 ? 4 : type === 1 || type === 2 ? 1 : 8;
    const at = count * size <= 4 ? e + 8 : dv.getUint32(e + 8, le);
    const vals: number[] = [];
    if (type === 3 || type === 4) for (let k = 0; k < Math.min(count, 1 << 20); k++) vals.push(type === 3 ? dv.getUint16(at + k * 2, le) : dv.getUint32(at + k * 4, le));
    tags.set(t, vals);
  }
  const get = (t: number, d?: number) => tags.get(t)?.[0] ?? d;
  const w = get(256)!, h = get(257)!, spp = get(277, 1)!, bits = get(258, 1)!, fmt = get(339, 1)!;
  if (get(259, 1) !== 1) throw new Error("The TIFF file is compressed");
  if (spp !== 3 || get(284, 1) !== 1) throw new Error("Only chunky RGB TIFF files can be verified");
  const offs = tags.get(273) ?? [], counts = tags.get(279) ?? [];
  const bps = bits / 8, total = w * h * 3;
  const raw = new Uint8Array(total * bps);
  let o = 0;
  for (let i = 0; i < offs.length && o < raw.length; i++) { const len = Math.min(counts[i], raw.length - o); raw.set(b.subarray(offs[i], offs[i] + len), o); o += len; }
  if (o !== raw.length) throw new Error("The TIFF file is truncated");
  const rv = new DataView(raw.buffer);
  if (bps === 1) return { w, h, samples: raw };
  if (bps === 2) { const s = new Uint16Array(total); for (let i = 0; i < total; i++) s[i] = rv.getUint16(i * 2, le); return { w, h, samples: s }; }
  if (bps === 4 && fmt === 3) { const s = new Float32Array(total); for (let i = 0; i < total; i++) s[i] = rv.getFloat32(i * 4, le); return { w, h, samples: s }; }
  throw new Error(`Unsupported TIFF sample format (${bits}-bit, format ${fmt})`);
}

// ---------------------------------------------------------------- PNG (stored deflate)
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function pngLayout(w: number, h: number, bps: 1 | 2) {
  const row = 1 + w * 3 * bps, raw = row * h;
  const blocks = Math.ceil(raw / 65535);
  const z = 2 + raw + blocks * 5 + 4;
  return { row, raw, z, size: 8 + 25 + (12 + z) + 12 };
}

export function pngSize(w: number, h: number, bytesPerSample: 1 | 2): number { return pngLayout(w, h, bytesPerSample).size; }

/**
 * RGB PNG, 8 or 16 bits per channel. The image data is wrapped in zlib "stored" blocks (deflate block
 * type 0, which copies bytes verbatim) and every row uses filter type 0 (None): the file holds the
 * samples exactly as they are, uncompressed.
 */
export function encodePNG(w: number, h: number, s: Uint8Array | Uint16Array): Uint8Array {
  checkSamples(w, h, s);
  const bps = s instanceof Uint16Array ? 2 : 1;
  const L = pngLayout(w, h, bps);
  if (L.z > 0x7fffffff) throw new Error("The image is too large for one PNG data chunk");
  const out = new Uint8Array(L.size), dv = new DataView(out.buffer);
  out.set(PNG_SIG, 0);
  // IHDR
  dv.setUint32(8, 13);
  out.set([73, 72, 68, 82], 12);
  dv.setUint32(16, w); dv.setUint32(20, h);
  out[24] = bps * 8; out[25] = 2; out[26] = 0; out[27] = 0; out[28] = 0;
  dv.setUint32(29, crc32(out.subarray(12, 29)));
  // IDAT
  const idat = 33;
  dv.setUint32(idat, L.z);
  out.set([73, 68, 65, 84], idat + 4);
  let p = idat + 8;
  out[p++] = 0x78; out[p++] = 0x01; // zlib header: deflate, 32 KB window, no preset dictionary
  let left = L.raw, inBlock = 0, adler = 1;
  const put = (d: Uint8Array) => {
    adler = adler32(d, adler);
    let i = 0;
    while (i < d.length) {
      if (!inBlock) {
        const len = Math.min(65535, left);
        left -= len;
        out[p] = left === 0 ? 1 : 0; // BFINAL, BTYPE = 00 (stored)
        out[p + 1] = len & 255; out[p + 2] = len >>> 8; out[p + 3] = ~len & 255; out[p + 4] = (~len >>> 8) & 255;
        p += 5; inBlock = len;
      }
      const k = Math.min(inBlock, d.length - i);
      out.set(d.subarray(i, i + k), p);
      p += k; i += k; inBlock -= k;
    }
  };
  const rowBuf = new Uint8Array(L.row);
  for (let y = 0; y < h; y++) {
    rowBuf[0] = 0; // filter: None
    const base = y * w * 3;
    if (bps === 1) rowBuf.set((s as Uint8Array).subarray(base, base + w * 3), 1);
    else for (let i = 0, o = 1; i < w * 3; i++, o += 2) { const v = s[base + i]; rowBuf[o] = v >>> 8; rowBuf[o + 1] = v & 255; }
    put(rowBuf);
  }
  dv.setUint32(p, adler); p += 4;
  dv.setUint32(p, crc32(out.subarray(idat + 4, p))); p += 4;
  // IEND
  dv.setUint32(p, 0); out.set([73, 69, 78, 68], p + 4); dv.setUint32(p + 8, crc32(out.subarray(p + 4, p + 8))); p += 12;
  if (p !== out.length) throw new Error("Internal error: PNG size mismatch");
  return out;
}

/** Reads RGB PNGs written with stored deflate blocks and filter type None (the files written above). */
export function decodePNG(b: Uint8Array): { w: number; h: number; samples: Samples } {
  for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) throw new Error("Not a PNG file");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8, w = 0, h = 0, depth = 8, type = 2;
  const z: Uint8Array[] = [];
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p), id = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const data = b.subarray(p + 8, p + 8 + len);
    if (crc32(b.subarray(p + 4, p + 8 + len)) !== dv.getUint32(p + 8 + len)) throw new Error(`PNG chunk ${id} has a bad CRC`);
    if (id === "IHDR") { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = b[p + 16]; type = b[p + 17]; if (b[p + 20]) throw new Error("Interlaced PNG files cannot be verified"); }
    else if (id === "IDAT") z.push(data);
    else if (id === "IEND") break;
    p += 12 + len;
  }
  if (type !== 2 || (depth !== 8 && depth !== 16)) throw new Error("Only RGB PNG files can be verified");
  let zlen = 0;
  for (const c of z) zlen += c.length;
  const zs = new Uint8Array(zlen);
  zlen = 0;
  for (const c of z) { zs.set(c, zlen); zlen += c.length; }
  const bps = depth / 8, row = 1 + w * 3 * bps;
  const raw = new Uint8Array(row * h);
  let q = 2, o = 0, final = 0;
  while (!final) {
    const hdr = zs[q]; final = hdr & 1;
    if ((hdr >> 1) & 3) throw new Error("The PNG data is compressed");
    const len = zs[q + 1] | (zs[q + 2] << 8);
    raw.set(zs.subarray(q + 5, q + 5 + len), o);
    o += len; q += 5 + len;
  }
  if (o !== raw.length) throw new Error("The PNG data is truncated");
  const a = (zs[q] << 24 | zs[q + 1] << 16 | zs[q + 2] << 8 | zs[q + 3]) >>> 0;
  if (a !== adler32(raw)) throw new Error("The PNG data has a bad checksum");
  const n = w * h * 3, s = bps === 1 ? new Uint8Array(n) : new Uint16Array(n);
  for (let y = 0; y < h; y++) {
    if (raw[y * row] !== 0) throw new Error("PNG row filters cannot be verified");
    const src = y * row + 1, dst = y * w * 3;
    if (bps === 1) (s as Uint8Array).set(raw.subarray(src, src + w * 3), dst);
    else for (let i = 0; i < w * 3; i++) s[dst + i] = (raw[src + i * 2] << 8) | raw[src + i * 2 + 1];
  }
  return { w, h, samples: s };
}

// ---------------------------------------------------------------- BMP
export const bmpSize = (w: number, h: number) => 54 + ((w * 3 + 3) & ~3) * h;

/** 24-bit bottom-up BMP (BI_RGB). */
export function encodeBMP(w: number, h: number, s: Uint8Array): Uint8Array {
  checkSamples(w, h, s);
  const stride = (w * 3 + 3) & ~3, size = 54 + stride * h;
  const b = new Uint8Array(size), dv = new DataView(b.buffer);
  b[0] = 0x42; b[1] = 0x4d; dv.setUint32(2, size, true); dv.setUint32(10, 54, true); dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true); dv.setInt32(22, h, true); dv.setUint16(26, 1, true); dv.setUint16(28, 24, true); dv.setUint32(34, stride * h, true);
  dv.setInt32(38, 2835, true); dv.setInt32(42, 2835, true);
  dib24Into(b, 54, w, h, s);
  return b;
}

export function decodeBMP(b: Uint8Array): { w: number; h: number; samples: Uint8Array } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] !== 0x42 || b[1] !== 0x4d) throw new Error("Not a BMP file");
  const off = dv.getUint32(10, true), w = dv.getInt32(18, true), hh = dv.getInt32(22, true);
  if (dv.getUint16(28, true) !== 24 || dv.getUint32(30, true) !== 0) throw new Error("Only 24-bit uncompressed BMP files can be verified");
  const h = Math.abs(hh);
  return { w, h, samples: rgbFromDib24(b.subarray(off), w, h, hh > 0) };
}

// ---------------------------------------------------------------- DIB rows (BMP, uncompressed AVI)
export const dibStride = (w: number) => (w * 3 + 3) & ~3;

/** Packed top-down RGB → bottom-up BGR rows padded to 4 bytes, written into `out` at `at`. */
export function dib24Into(out: Uint8Array, at: number, w: number, h: number, s: Uint8Array) {
  const stride = dibStride(w);
  for (let y = 0; y < h; y++) {
    let o = at + (h - 1 - y) * stride, i = y * w * 3;
    for (let x = 0; x < w; x++, o += 3, i += 3) { out[o] = s[i + 2]; out[o + 1] = s[i + 1]; out[o + 2] = s[i]; }
  }
}

export function dib24(w: number, h: number, s: Uint8Array): Uint8Array {
  const out = new Uint8Array(dibStride(w) * h);
  dib24Into(out, 0, w, h, s);
  return out;
}

/** BGR DIB rows (bottom-up unless `bottomUp` is false) → packed top-down RGB. */
export function rgbFromDib24(d: Uint8Array, w: number, h: number, bottomUp = true): Uint8Array {
  const stride = dibStride(w), s = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    let i = (bottomUp ? h - 1 - y : y) * stride, o = y * w * 3;
    for (let x = 0; x < w; x++, i += 3, o += 3) { s[o] = d[i + 2]; s[o + 1] = d[i + 1]; s[o + 2] = d[i]; }
  }
  return s;
}

/** RGBA (canvas ImageData) → bottom-up BGR DIB rows, in one pass (live capture). */
export function dib24FromRGBA(rgba: ArrayLike<number>, w: number, h: number): Uint8Array {
  const stride = dibStride(w), out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    let o = (h - 1 - y) * stride, k = y * w * 4;
    for (let x = 0; x < w; x++, o += 3, k += 4) { out[o] = rgba[k + 2]; out[o + 1] = rgba[k + 1]; out[o + 2] = rgba[k]; }
  }
  return out;
}

/** RGBA (canvas ImageData, 8-bit) → packed RGB. */
export function rgbFromRGBA(rgba: ArrayLike<number>, w: number, h: number): Uint8Array {
  const s = new Uint8Array(w * h * 3);
  for (let i = 0, k = 0; i < s.length; i += 3, k += 4) { s[i] = rgba[k]; s[i + 1] = rgba[k + 1]; s[i + 2] = rgba[k + 2]; }
  return s;
}

/** Bytes of packed samples in little-endian order (what verification hashes). */
export function sampleBytesLE(s: Samples): Uint8Array {
  if (s instanceof Uint8Array || LE) return bytesOf(s);
  const out = new Uint8Array(s.byteLength), dv = new DataView(out.buffer);
  if (s instanceof Uint16Array) for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s[i], true);
  else for (let i = 0; i < s.length; i++) dv.setFloat32(i * 4, s[i], true);
  return out;
}
