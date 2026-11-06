// Baseline JPEG decoder (ITU-T T.81, sequential DCT, Huffman coding).
//
// The browser reference lets the browser decode JPEG evidence (through a canvas), which loses the
// stored precision and differs between platforms. The native app decodes the file itself, so the
// samples are the ones stored in the file: no colour management, no chroma smoothing beyond the
// standard upsampling, and an explicit error for the formats this decoder does not cover
// (progressive JPEG, arithmetic coding, 12-bit samples, CMYK/YCCK).
//
// Supported: baseline sequential JPEG, 8-bit samples, 1 (grayscale), 3 (YCbCr) and 4 (CMYK/YCCK is
// refused) components, any sampling factors (4:4:4, 4:2:2, 4:2:0, 4:1:1), restart intervals.

export interface DecodedJpeg {
  w: number;
  h: number;
  /** RGBA, 0..255 scale. */
  rgba: Float32Array;
  /** Number of components of the file (1 = grayscale, 3 = YCbCr). */
  components: number;
  /** True when the file carries a JFIF/Adobe APP0 marker. */
  progressive: boolean;
}

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

interface HuffTable {
  /** Huffman code -> value, decoded bit by bit with the canonical tables. */
  minCode: Int32Array;
  maxCode: Int32Array;
  valPtr: Int32Array;
  values: Uint8Array;
}

interface Component {
  id: number;
  /** Position of the component in the file (predictor index). */
  index: number;
  h: number;
  v: number;
  tq: number;
  td: number;
  ta: number;
  /** Per-component sample plane (blocks wide). */
  data: Uint8Array;
  bw: number;
  bh: number;
}

const buildHuffTable = (bits: Uint8Array, values: Uint8Array): HuffTable => {
  const minCode = new Int32Array(17);
  const maxCode = new Int32Array(17).fill(-1);
  const valPtr = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    valPtr[l] = k;
    minCode[l] = code;
    code += bits[l];
    k += bits[l];
    maxCode[l] = bits[l] ? code - 1 : -1;
    code <<= 1;
  }
  return { minCode, maxCode, valPtr, values };
};

/** AAN-free float IDCT (the same reference implementation as the classic jidctflt). */
const IDCT_C = new Float32Array(64);
for (let u = 0; u < 8; u++) IDCT_C[u] = u === 0 ? Math.SQRT1_2 : 1;

function idct8x8(block: Float32Array, out: Uint8Array, outStride: number, outOffset: number) {
  const tmp = new Float32Array(64);
  // rows
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += IDCT_C[u] * block[y * 8 + u] * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
      tmp[y * 8 + x] = s / 2;
    }
  }
  // columns
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += IDCT_C[v] * tmp[v * 8 + x] * Math.cos(((2 * y + 1) * v * Math.PI) / 16);
      const val = Math.round(s / 2) + 128;
      out[outOffset + y * outStride + x] = val < 0 ? 0 : val > 255 ? 255 : val;
    }
  }
}

class BitReader {
  pos = 0;
  bits = 0;
  count = 0;
  eof = false;
  constructor(private d: Uint8Array) {}
  readBit(): number {
    if (this.count === 0) {
      if (this.pos >= this.d.length) { this.eof = true; return 0; }
      let b = this.d[this.pos++];
      if (b === 0xff) {
        const next = this.d[this.pos];
        if (next === 0x00) this.pos++;
        else { this.eof = true; return 0; }  // marker: treat as padding
      }
      this.bits = b;
      this.count = 8;
    }
    this.count--;
    return (this.bits >> this.count) & 1;
  }
  receive(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.readBit();
    return v;
  }
  decodeHuff(t: HuffTable): number {
    let code = this.readBit();
    let l = 1;
    while (l <= 16 && (t.maxCode[l] < 0 || code > t.maxCode[l])) {
      code = (code << 1) | this.readBit();
      l++;
    }
    if (l > 16) return 0;
    const idx = t.valPtr[l] + code - t.minCode[l];
    return idx >= 0 && idx < t.values.length ? t.values[idx] : 0;
  }
  reset() { this.bits = 0; this.count = 0; }
}

const extend = (v: number, n: number) => (n === 0 ? 0 : v < 1 << (n - 1) ? v - (1 << n) + 1 : v);

/** Decode a baseline JPEG file into RGBA samples. */
export function decodeJpeg(bytes: Uint8Array): DecodedJpeg {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Not a JPEG file");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 2;
  const qt: (Int32Array | null)[] = new Array(4).fill(null);
  const dcTables: (HuffTable | null)[] = new Array(4).fill(null);
  const acTables: (HuffTable | null)[] = new Array(4).fill(null);
  let width = 0, height = 0;
  let comps: Component[] = [];
  let progressive = false;
  let restartInterval = 0;
  let adobeTransform = -1;
  let jfif = false;

  const readUint16 = (at: number) => dv.getUint16(at);

  while (p < bytes.length - 1) {
    if (bytes[p] !== 0xff) { p++; continue; }
    let marker = bytes[p + 1];
    while (marker === 0xff) { p++; marker = bytes[p + 1]; }
    p += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    if (p + 2 > bytes.length) break;
    const len = readUint16(p);
    const segEnd = p + len;
    const seg = p + 2;
    if (marker === 0xe0 && bytes[seg] === 0x4a && bytes[seg + 1] === 0x46) jfif = true;
    else if (marker === 0xee && bytes[seg] === 0x41 && bytes[seg + 1] === 0x64 && bytes[seg + 2] === 0x6f && bytes[seg + 3] === 0x62) {
      adobeTransform = bytes[seg + 11];
    } else if (marker === 0xdb) {
      let q = seg;
      while (q < segEnd) {
        const pq = bytes[q] >> 4, tq = bytes[q] & 15;
        q++;
        const table = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          if (pq) { table[ZIGZAG[i]] = readUint16(q); q += 2; }
          else { table[ZIGZAG[i]] = bytes[q]; q++; }
        }
        qt[tq] = table;
      }
    } else if (marker === 0xc4) {
      let q = seg;
      while (q < segEnd) {
        const tc = bytes[q] >> 4, th = bytes[q] & 15;
        q++;
        const bits = new Uint8Array(17);
        let total = 0;
        for (let i = 1; i <= 16; i++) { bits[i] = bytes[q + i - 1]; total += bits[i]; }
        q += 16;
        const values = bytes.subarray(q, q + total);
        q += total;
        const table = buildHuffTable(bits, values);
        if (tc === 0) dcTables[th] = table; else acTables[th] = table;
      }
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      progressive = marker === 0xc2;
      height = readUint16(seg + 1);
      width = readUint16(seg + 3);
      const nc = bytes[seg + 5];
      comps = [];
      for (let i = 0; i < nc; i++) {
        const o = seg + 6 + i * 3;
        comps.push({ id: bytes[o], index: i, h: bytes[o + 1] >> 4, v: bytes[o + 1] & 15, tq: bytes[o + 2], td: 0, ta: 0, data: new Uint8Array(0), bw: 0, bh: 0 });
      }
      if (progressive) throw new Error("Progressive JPEG files are not supported by the native decoder; convert the file to baseline JPEG first.");
    } else if (marker === 0xc9 || marker === 0xca) {
      // arithmetic coding: not supported
      if (marker === 0xc9) throw new Error("Arithmetic-coded JPEG files are not supported by the native decoder.");
      break;
    } else if (marker === 0xdd) {
      restartInterval = readUint16(seg);
    } else if (marker === 0xda) {
      const ns = bytes[seg];
      for (let i = 0; i < ns; i++) {
        const cs = bytes[seg + 1 + i * 2];
        const t = bytes[seg + 2 + i * 2];
        const comp = comps.find((c) => c.id === cs);
        if (!comp) throw new Error("The JPEG file refers to an unknown component");
        comp.td = t >> 4;
        comp.ta = t & 15;
      }
      const scanStart = segEnd;
      // entropy coded data runs until the next marker (not RST)
      let e = scanStart;
      while (e < bytes.length - 1) {
        if (bytes[e] === 0xff && bytes[e + 1] !== 0x00 && !(bytes[e + 1] >= 0xd0 && bytes[e + 1] <= 0xd7)) break;
        e++;
      }
      const scan = bytes.subarray(scanStart, e);
      decodeScan(scan, comps, qt, dcTables, acTables, width, height, restartInterval);
      p = e;
      continue;
    }
    p = segEnd;
  }

  if (!width || !height || !comps.length) throw new Error("The JPEG file has no image data");
  if (comps.length === 4) throw new Error("CMYK JPEG files are not supported by the native decoder.");
  if (adobeTransform === 2 && comps.length === 3) {
    // Adobe YCCK: the chroma is stored inverted; not covered by this decoder
    throw new Error("YCCK JPEG files are not supported by the native decoder.");
  }

  const rgba = new Float32Array(width * height * 4);
  const hmax = Math.max(...comps.map((c) => c.h));
  const vmax = Math.max(...comps.map((c) => c.v));
  const mcusX = Math.ceil(width / (8 * hmax));
  const mcusY = Math.ceil(height / (8 * vmax));
  /** Stored sample of a component at its own resolution (edges replicated). */
  const stored = (c: Component, cx: number, cy: number): number => {
    const x = Math.min(c.bw - 1, Math.max(0, cx));
    const y = Math.min(c.bh - 1, Math.max(0, cy));
    return c.data[y * c.bw + x];
  };

  /**
   * Chroma sample at the output pixel (x, y), with the "fancy" (triangle) reconstruction libjpeg uses:
   * the chroma samples are combined 3:1 with their neighbours in both directions, which is what the
   * reference decoders of the platform do. Without it the chroma of a 4:2:0 file would show the hard
   * 2x2 blocks of the stored samples.
   */
  const chromaAt = (c: Component, x: number, y: number): number => {
    const cw = Math.ceil((width * c.h) / hmax);
    const ch = Math.ceil((height * c.v) / vmax);
    const cx = Math.min(cw - 1, Math.floor((x * c.h) / hmax));
    const cy = Math.min(ch - 1, Math.floor((y * c.v) / vmax));
    const horizontal = c.h < hmax;
    const vertical = c.v < vmax;
    if (!horizontal && !vertical) return stored(c, cx, cy);
    const clampX = (v: number) => Math.min(cw - 1, Math.max(0, v));
    const clampY = (v: number) => Math.min(ch - 1, Math.max(0, v));
    // vertical triangle: 3 * near + far (four times the value)
    const nearY = cy, farY = vertical ? clampY((y % 2) === 0 ? cy - 1 : cy + 1) : cy;
    const col = (colX: number): number => 3 * stored(c, clampX(colX), nearY) + stored(c, clampX(colX), farY);
    if (!horizontal) return col(cx) / 4;
    // horizontal triangle on the combined column (sixteen times the value)
    const even = (x % 2) === 0;
    const neighbour = clampX(even ? cx - 1 : cx + 1);
    return (3 * col(cx) + col(neighbour)) / 16;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (comps.length === 1) {
        const v = stored(comps[0], x, y);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
      } else {
        const Y = stored(comps[0], x, y);
        const cb = chromaAt(comps[1], x, y) - 128;
        const cr = chromaAt(comps[2], x, y) - 128;
        rgba[o] = Y + 1.402 * cr;
        rgba[o + 1] = Y - 0.344136 * cb - 0.714136 * cr;
        rgba[o + 2] = Y + 1.772 * cb;
      }
      rgba[o + 3] = 255;
    }
  }
  return { w: width, h: height, rgba, components: comps.length, progressive };
}

function decodeScan(
  scan: Uint8Array,
  comps: Component[],
  qt: (Int32Array | null)[],
  dcTables: (HuffTable | null)[],
  acTables: (HuffTable | null)[],
  width: number,
  height: number,
  restartInterval: number,
) {
  const hmax = Math.max(...comps.map((c) => c.h));
  const vmax = Math.max(...comps.map((c) => c.v));
  const mcusX = Math.ceil(width / (8 * hmax));
  const mcusY = Math.ceil(height / (8 * vmax));
  for (const c of comps) { c.bw = mcusX * c.h * 8; c.bh = mcusY * c.v * 8; c.data = new Uint8Array(c.bw * c.bh); }

  const br = new BitReader(scan);
  const pred = new Int32Array(comps.length);
  const block = new Float32Array(64);
  const out = new Uint8Array(64);
  let mcu = 0;

  const decodeBlock = (c: Component, bx: number, by: number) => {
    const dct = qt[c.tq];
    const dcT = dcTables[c.td];
    const acT = acTables[c.ta];
    if (!dct || !dcT || !acT) throw new Error("The JPEG file refers to an undefined table");
    block.fill(0);
    const t = br.decodeHuff(dcT);
    const diff = t === 0 ? 0 : extend(br.receive(t), t);
    pred[c.index] = pred[c.index] + diff;
    block[0] = pred[c.index] * dct[0];
    let k = 1;
    while (k < 64) {
      const rs = br.decodeHuff(acT);
      const s = rs & 15, r = rs >> 4;
      if (s === 0) {
        if (r < 15) break;
        k += 16;
        continue;
      }
      k += r;
      if (k > 63) break;
      const z = ZIGZAG[k];
      block[z] = extend(br.receive(s), s) * dct[z];
      k++;
    }
    idct8x8(block, out, 8, 0);
    for (let y = 0; y < 8; y++) {
      const row = (by + y) * c.bw + bx;
      if (row + 8 > c.data.length) break;
      for (let x = 0; x < 8; x++) c.data[row + x] = out[y * 8 + x];
    }
  };

  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      if (restartInterval && mcu > 0 && mcu % restartInterval === 0) {
        // skip the restart marker and reset the predictors
        br.reset();
        while (br.pos < scan.length - 1 && !(scan[br.pos] === 0xff && scan[br.pos + 1] >= 0xd0 && scan[br.pos + 1] <= 0xd7)) br.pos++;
        br.pos += 2;
        pred.fill(0);
      }
      mcu++;
      for (const c of comps) {
        for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) decodeBlock(c, (mx * c.h + h) * 8, (my * c.v + v) * 8);
      }
    }
  }
}
