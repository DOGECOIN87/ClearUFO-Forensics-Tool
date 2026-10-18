// Incremental MD5, SHA-1 and SHA-256 in pure TypeScript (no secure-context requirement),
// used for evidence file hashing and per-frame integrity hashes.

const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");

abstract class BlockHash {
  protected buf = new Uint8Array(64);
  protected bufLen = 0;
  protected total = 0;
  protected abstract block(b: Uint8Array, off: number): void;
  update(data: Uint8Array): this {
    let i = 0;
    const n = data.length;
    this.total += n;
    if (this.bufLen) {
      const take = Math.min(64 - this.bufLen, n);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      i = take;
      if (this.bufLen === 64) { this.block(this.buf, 0); this.bufLen = 0; }
    }
    for (; i + 64 <= n; i += 64) this.block(data, i);
    if (i < n) { this.buf.set(data.subarray(i), 0); this.bufLen = n - i; }
    return this;
  }
  protected pad(bigEndian: boolean) {
    const bits = this.total * 8;
    const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
    const p = new Uint8Array(padLen + 8);
    p[0] = 0x80;
    const lo = bits >>> 0, hi = Math.floor(bits / 4294967296) >>> 0;
    const dv = new DataView(p.buffer);
    if (bigEndian) { dv.setUint32(padLen, hi); dv.setUint32(padLen + 4, lo); }
    else { dv.setUint32(padLen, lo, true); dv.setUint32(padLen + 4, hi, true); }
    const saved = this.total;
    this.update(p);
    this.total = saved;
  }
  abstract digest(): string;
}

// ---------------------------------------------------------------- MD5
const MD5_K = new Int32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0);
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];

export class MD5 extends BlockHash {
  private h = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]);
  private m = new Int32Array(16);
  protected block(b: Uint8Array, off: number) {
    const m = this.m;
    for (let i = 0; i < 16; i++) { const j = off + i * 4; m[i] = b[j] | (b[j + 1] << 8) | (b[j + 2] << 16) | (b[j + 3] << 24); }
    let a = this.h[0], bb = this.h[1], c = this.h[2], d = this.h[3];
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (bb & c) | (~bb & d); g = i; }
      else if (i < 32) { f = (d & bb) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = bb ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (bb | ~d); g = (7 * i) & 15; }
      const t = d;
      d = c;
      c = bb;
      const x = (a + f + MD5_K[i] + m[g]) | 0;
      bb = (bb + ((x << MD5_S[i]) | (x >>> (32 - MD5_S[i])))) | 0;
      a = t;
    }
    this.h[0] = (this.h[0] + a) | 0; this.h[1] = (this.h[1] + bb) | 0; this.h[2] = (this.h[2] + c) | 0; this.h[3] = (this.h[3] + d) | 0;
  }
  digest(): string {
    this.pad(false);
    let s = "";
    for (let i = 0; i < 4; i++) { const v = this.h[i]; s += [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255].map((x) => x.toString(16).padStart(2, "0")).join(""); }
    return s;
  }
}

// ---------------------------------------------------------------- SHA-1
export class SHA1 extends BlockHash {
  private h = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0]);
  private w = new Int32Array(80);
  protected block(b: Uint8Array, off: number) {
    const w = this.w;
    for (let i = 0; i < 16; i++) { const j = off + i * 4; w[i] = (b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3]; }
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = this.h[0], bb = this.h[1], c = this.h[2], d = this.h[3], e = this.h[4];
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (bb & c) | (~bb & d); k = 0x5a827999; }
      else if (i < 40) { f = bb ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (bb & c) | (bb & d) | (c & d); k = 0x8f1bbcdc | 0; }
      else { f = bb ^ c ^ d; k = 0xca62c1d6 | 0; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (bb << 30) | (bb >>> 2); bb = a; a = t;
    }
    this.h[0] = (this.h[0] + a) | 0; this.h[1] = (this.h[1] + bb) | 0; this.h[2] = (this.h[2] + c) | 0; this.h[3] = (this.h[3] + d) | 0; this.h[4] = (this.h[4] + e) | 0;
  }
  digest(): string { this.pad(true); return Array.from(this.h, hex).join(""); }
}

// ---------------------------------------------------------------- SHA-256
const K256 = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class SHA256 extends BlockHash {
  private h = new Int32Array([0x6a09e667, 0xbb67ae85 | 0, 0x3c6ef372, 0xa54ff53a | 0, 0x510e527f, 0x9b05688c | 0, 0x1f83d9ab, 0x5be0cd19]);
  private w = new Int32Array(64);
  protected block(b: Uint8Array, off: number) {
    const w = this.w;
    for (let i = 0; i < 16; i++) { const j = off + i * 4; w[i] = (b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3]; }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = this.h[0], bb = this.h[1], c = this.h[2], d = this.h[3], e = this.h[4], f = this.h[5], g = this.h[6], hh = this.h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + mj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    const H = this.h;
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + hh) | 0;
  }
  digest(): string { this.pad(true); return Array.from(this.h, hex).join(""); }
}

export function md5(data: Uint8Array): string { return new MD5().update(data).digest(); }

/** Hash a Blob/File incrementally, reporting progress (0..1). */
export async function hashBlob(blob: Blob, onProgress?: (v: number) => void, isCancelled?: () => boolean): Promise<{ md5: string; sha1: string; sha256: string }> {
  const a = new MD5(), b = new SHA1(), c = new SHA256();
  const CH = 8 * 1024 * 1024;
  for (let off = 0; off < blob.size; off += CH) {
    if (isCancelled?.()) throw new Error("Cancelled");
    const buf = new Uint8Array(await blob.slice(off, Math.min(blob.size, off + CH)).arrayBuffer());
    a.update(buf); b.update(buf); c.update(buf);
    onProgress?.(Math.min(1, (off + CH) / blob.size));
  }
  return { md5: a.digest(), sha1: b.digest(), sha256: c.digest() };
}
