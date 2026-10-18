// ZIP archive writer for image sequences, streaming to a ByteSink. Entries are stored (method 0): the
// files inside are byte-for-byte the images, nothing is compressed. ZIP64 records are added
// automatically when the archive passes 4 GB or 65,535 entries. A small reader is included to verify
// archives after writing.
import { crc32 } from "./image";
import type { ByteSink } from "./sink";

const MAX32 = 0xffffffff, MAX16 = 0xffff;

function setU64(dv: DataView, o: number, v: number) { dv.setUint32(o, v % 0x100000000, true); dv.setUint32(o + 4, Math.floor(v / 0x100000000), true); }
function getU64(dv: DataView, o: number) { return dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 0x100000000; }

function dosDateTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export class ZipWriter {
  private central: Uint8Array[] = [];
  private count = 0;
  private any64 = false;

  constructor(private sink: ByteSink, private opts: { forceZip64?: boolean } = {}) {}

  /** Exact size of an archive holding entries of the given name and data lengths. */
  static size(entries: { name: string; size: number }[], forceZip64 = false): number {
    const te = new TextEncoder();
    let pos = 0, cd = 0, z64 = forceZip64 || entries.length >= MAX16;
    for (const e of entries) {
      const nm = te.encode(e.name).length;
      const big = e.size >= MAX32, off64 = forceZip64 || pos >= MAX32;
      pos += 30 + nm + (big ? 20 : 0) + e.size;
      cd += 46 + nm + (big || off64 ? 4 + (big ? 16 : 0) + (off64 ? 8 : 0) : 0);
      if (big || off64) z64 = true;
    }
    if (pos >= MAX32 || cd >= MAX32) z64 = true;
    return pos + cd + (z64 ? 56 + 20 : 0) + 22;
  }

  async add(name: string, data: Uint8Array, date = new Date()) {
    const nm = new TextEncoder().encode(name);
    const crc = crc32(data), { time, date: dd } = dosDateTime(date);
    const off = this.sink.pos, size = data.length;
    const big = size >= MAX32, off64 = !!this.opts.forceZip64 || off >= MAX32;
    // local file header
    const lh = new Uint8Array(30 + nm.length + (big ? 20 : 0)), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, big ? 45 : 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true); lv.setUint16(12, dd, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, big ? MAX32 : size, true); lv.setUint32(22, big ? MAX32 : size, true);
    lv.setUint16(26, nm.length, true); lv.setUint16(28, big ? 20 : 0, true);
    lh.set(nm, 30);
    if (big) { const x = 30 + nm.length; lv.setUint16(x, 1, true); lv.setUint16(x + 2, 16, true); setU64(lv, x + 4, size); setU64(lv, x + 12, size); }
    await this.sink.write(lh);
    await this.sink.write(data);
    // central directory entry
    const extra = big || off64 ? 4 + (big ? 16 : 0) + (off64 ? 8 : 0) : 0;
    const ch = new Uint8Array(46 + nm.length + extra), cv = new DataView(ch.buffer);
    const ver = big || off64 ? 45 : 20;
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, ver, true); cv.setUint16(6, ver, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true); cv.setUint16(14, dd, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, big ? MAX32 : size, true); cv.setUint32(24, big ? MAX32 : size, true);
    cv.setUint16(28, nm.length, true); cv.setUint16(30, extra, true);
    cv.setUint32(42, off64 ? MAX32 : off, true);
    ch.set(nm, 46);
    if (extra) {
      let x = 46 + nm.length;
      cv.setUint16(x, 1, true); cv.setUint16(x + 2, extra - 4, true); x += 4;
      if (big) { setU64(cv, x, size); setU64(cv, x + 8, size); x += 16; }
      if (off64) setU64(cv, x, off);
      this.any64 = true;
    }
    this.central.push(ch);
    this.count++;
  }

  async finish() {
    const cdAt = this.sink.pos;
    for (const c of this.central) await this.sink.write(c);
    const cdSize = this.sink.pos - cdAt;
    const z64 = !!this.opts.forceZip64 || this.any64 || this.count >= MAX16 || cdAt >= MAX32 || cdSize >= MAX32;
    if (z64) {
      const zAt = this.sink.pos;
      const r = new Uint8Array(56 + 20), rv = new DataView(r.buffer);
      rv.setUint32(0, 0x06064b50, true); setU64(rv, 4, 44); rv.setUint16(12, 45, true); rv.setUint16(14, 45, true);
      rv.setUint32(16, 0, true); rv.setUint32(20, 0, true);
      setU64(rv, 24, this.count); setU64(rv, 32, this.count); setU64(rv, 40, cdSize); setU64(rv, 48, cdAt);
      rv.setUint32(56, 0x07064b50, true); rv.setUint32(60, 0, true); setU64(rv, 64, zAt); rv.setUint32(72, 1, true);
      await this.sink.write(r);
    }
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, z64 ? MAX16 : this.count, true); ev.setUint16(10, z64 ? MAX16 : this.count, true);
    ev.setUint32(12, z64 ? MAX32 : cdSize, true); ev.setUint32(16, z64 ? MAX32 : cdAt, true);
    await this.sink.write(end);
  }
}

export interface ZipEntry { name: string; offset: number; size: number; crc: number }

/** Lists the stored entries of an archive (reads only the end of the file and the central directory). */
export async function readZipEntries(file: Blob): Promise<ZipEntry[]> {
  const tailLen = Math.min(file.size, 22 + 0xffff + 76);
  const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
  const tv = new DataView(tail.buffer);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("Not a ZIP archive");
  let count = tv.getUint16(e + 10, true), cdSize = tv.getUint32(e + 12, true), cdAt = tv.getUint32(e + 16, true);
  if (e >= 20 && tv.getUint32(e - 20, true) === 0x07064b50) {
    const zAt = getU64(tv, e - 20 + 8);
    const z = new DataView(await file.slice(zAt, zAt + 56).arrayBuffer());
    if (z.getUint32(0, true) !== 0x06064b50) throw new Error("Damaged ZIP64 record");
    count = getU64(z, 32); cdSize = getU64(z, 40); cdAt = getU64(z, 48);
  }
  const cd = new Uint8Array(await file.slice(cdAt, cdAt + cdSize).arrayBuffer()), cv = new DataView(cd.buffer);
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cv.getUint32(p, true) !== 0x02014b50) throw new Error("Damaged ZIP central directory");
    if (cv.getUint16(p + 10, true) !== 0) throw new Error("The ZIP entry is compressed");
    const crc = cv.getUint32(p + 16, true);
    let size = cv.getUint32(p + 24, true), lho = cv.getUint32(p + 42, true);
    const nl = cv.getUint16(p + 28, true), xl = cv.getUint16(p + 30, true), cl = cv.getUint16(p + 32, true);
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nl));
    let x = p + 46 + nl;
    const xEnd = x + xl;
    while (x + 4 <= xEnd) {
      const id = cv.getUint16(x, true), len = cv.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (size === MAX32) { size = getU64(cv, q + 8); q += 16; }
        if (lho === MAX32) lho = getU64(cv, q);
      }
      x += 4 + len;
    }
    const lh = new DataView(await file.slice(lho, lho + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error("Damaged ZIP entry");
    out.push({ name, offset: lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true), size, crc });
    p += 46 + nl + xl + cl;
  }
  return out;
}
