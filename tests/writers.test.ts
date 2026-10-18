// Uncompressed writers: TIFF/PNG/BMP codecs, OpenDML AVI, stored ZIP/ZIP64, sinks and size estimates.
import { deflateSync, inflateSync, crc32 as zcrc32 } from "node:zlib";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { AviWriter, fpsRational } from "../src/shared/codecs/avi";
import { adler32, crc32, decodeBMP, decodePNG, decodeTIFF, dib24, dib24FromRGBA, encodeBMP, encodePNG, encodeTIFF, pngSize, rgbFromDib24, rgbFromRGBA, tiffSize, bmpSize } from "../src/shared/codecs/image";
import { BlobSink, FileSink, type ByteSink } from "../src/shared/codecs/sink";
import { readZipEntries, ZipWriter } from "../src/shared/codecs/zip";
import { estimateBytes, sequenceName } from "../src/shared/formats";
import { parseAvi } from "../src/engine/sources/avi";
import { decodeStill, encodeStill, rgb16, rgb8, rgbf32 } from "../src/engine/writers/writers";
import { md5 } from "../src/engine/hash";

let fail = 0, pass = 0;
const ok = (cond: unknown, msg: string) => { if (cond) pass++; else { fail++; console.log("FAIL", msg); } };
const eq = (a: ArrayLike<number>, b: ArrayLike<number>) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return false; return true; };
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const rand8 = (n: number) => Uint8Array.from({ length: n }, () => (rnd() * 256) | 0);
const rand16 = (n: number) => Uint16Array.from({ length: n }, () => (rnd() * 65536) | 0);

// ---- checksums against zlib
{
  const d = rand8(200_001);
  ok(crc32(d) === zcrc32(d), "crc32 matches zlib");
  ok(crc32(d.subarray(100)) === zcrc32(d.subarray(100)) && crc32(d.subarray(50_000), crc32(d.subarray(0, 50_000))) === crc32(d), "crc32 continues a running checksum");
  const z = deflateSync(d);
  ok(adler32(d) === new DataView(z.buffer, z.byteOffset + z.length - 4).getUint32(0), "adler32 matches zlib");
}

// ---- PNG: stored blocks, independent inflate
for (const [w, h, bits] of [[37, 23, 8], [37, 23, 16], [300, 250, 8], [1, 1, 16], [700, 50, 16]] as const) {
  const s = bits === 8 ? rand8(w * h * 3) : rand16(w * h * 3);
  const png = encodePNG(w, h, s);
  ok(png.length === pngSize(w, h, bits === 8 ? 1 : 2), `PNG ${w}x${h}x${bits} size`);
  ok(eq(decodePNG(png).samples, s), `PNG ${w}x${h}x${bits} round trip`);
  // collect IDAT and inflate with zlib (an independent decoder)
  const dv = new DataView(png.buffer); let p = 8; const parts: Uint8Array[] = []; let ihdr = 0;
  while (p < png.length) { const len = dv.getUint32(p), id = String.fromCharCode(...png.subarray(p + 4, p + 8)); if (id === "IDAT") parts.push(png.subarray(p + 8, p + 8 + len)); if (id === "IHDR") ihdr = png[p + 16]; p += 12 + len; }
  const raw = inflateSync(Buffer.concat(parts));
  const row = 1 + w * 3 * (bits / 8);
  let good = raw.length === row * h && ihdr === bits;
  for (let y = 0; y < h && good; y++) {
    if (raw[y * row] !== 0) good = false;
    for (let i = 0; i < w * 3 && good; i++) {
      const v = bits === 8 ? raw[y * row + 1 + i] : (raw[y * row + 1 + i * 2] << 8) | raw[y * row + 2 + i * 2];
      if (v !== s[y * w * 3 + i]) good = false;
    }
  }
  ok(good, `PNG ${w}x${h}x${bits} decodes with zlib to the same samples`);
  // every deflate block is stored (BTYPE 00): walk the blocks
  const zs = Buffer.concat(parts); let q = 2, stored = true, last = 0;
  while (!last) { const hd = zs[q]; last = hd & 1; if ((hd >> 1) & 3) { stored = false; break; } const len = zs[q + 1] | (zs[q + 2] << 8); q += 5 + len; }
  ok(stored && q + 4 === zs.length, `PNG ${w}x${h}x${bits} uses only stored (uncompressed) blocks`);
}

// ---- TIFF 8/16/32f and BMP
{
  const w = 61, h = 17;
  const s8 = rand8(w * h * 3), s16 = rand16(w * h * 3), sf = Float32Array.from({ length: w * h * 3 }, () => rnd() * 1.2 - 0.1);
  for (const [s, b] of [[s8, 1], [s16, 2], [sf, 4]] as const) {
    const t = encodeTIFF(w, h, s);
    ok(t.length === tiffSize(w, h, b), `TIFF ${b * 8}-bit size`);
    const d = decodeTIFF(t);
    ok(d.w === w && d.h === h && eq(d.samples, s) && d.samples.constructor === s.constructor, `TIFF ${b * 8}-bit round trip`);
  }
  const bmp = encodeBMP(w, h, s8);
  ok(bmp.length === bmpSize(w, h) && eq(decodeBMP(bmp).samples, s8), "BMP round trip");
  ok(eq(rgbFromDib24(dib24(w, h, s8), w, h), s8), "DIB rows round trip");
  const rgba = rand8(w * h * 4);
  ok(eq(dib24FromRGBA(rgba, w, h), dib24(w, h, rgbFromRGBA(rgba, w, h))), "RGBA → DIB in one pass");
}

// ---- frame packing (8-bit like the viewer, 16-bit ×257, float /255)
{
  const vals = [0, 0.5, 1.5, 2.5, 1, 127.5, 254.4, 255, 300, -5, NaN, 77.25];
  const d = new Float32Array(vals.length * 4);
  vals.forEach((v, i) => { d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255; });
  const f = { w: vals.length, h: 1, d };
  const r8 = rgb8(f), r16 = rgb16(f), rf = rgbf32(f);
  ok(eq(Array.from(r8).filter((_, i) => i % 3 === 0), [0, 0, 2, 2, 1, 128, 254, 255, 255, 0, 0, 77]), "8-bit rounding matches Uint8ClampedArray (ties to even)");
  ok(eq(Array.from(r16).filter((_, i) => i % 3 === 0), [0, 129, 386, 643, 257, 32768, 65381, 65535, 65535, 0, 0, 19853]), "16-bit mapping (×257, clamped)");
  ok(Math.abs(rf[7 * 3] - 1) < 1e-7 && Math.abs(rf[8 * 3] - 300 / 255) < 1e-6 && rf[10 * 3] === 0, "float mapping (/255, range kept, NaN → 0)");
  // 16-bit is exact for 8-bit levels and keeps fractions
  const lv = new Float32Array(256 * 4); for (let v = 0; v < 256; v++) lv[v * 4] = lv[v * 4 + 1] = lv[v * 4 + 2] = v;
  const l16 = rgb16({ w: 256, h: 1, d: lv });
  ok(Array.from({ length: 256 }, (_, v) => l16[v * 3] === v * 257).every(Boolean), "16-bit: every 8-bit level maps to level × 257");
}

// ---- encodeStill / decodeStill for all lossless formats
{
  const w = 33, h = 21, d = new Float32Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : rnd() * 255));
  const f = { w, h, d };
  for (const fmt of ["tiff16", "tiff", "tiff32f", "png16", "png", "bmp"] as const) {
    const e = await encodeStill(f, fmt, 1, true);
    const s = decodeStill(fmt, e.bytes);
    const bytes = new Uint8Array(s.buffer, s.byteOffset, s.byteLength);
    ok(e.hash === md5(bytes), `${fmt}: decoded samples hash equals the written hash`);
    ok(estimateBytes(fmt, w, h, 0, 0) === e.bytes.length, `${fmt}: size estimate is exact`);
  }
  ok((await encodeStill(f, "png", 1, true)).hash === md5(rgb8(f)), "8-bit export hash equals the frame hash (MD5 of RGB)");
}

// ---- AVI: OpenDML segments, read back with the app's parser
async function writeAvi(sink: ByteSink, w: number, h: number, frames: Uint8Array[], segmentBytes?: number) {
  const avi = new AviWriter(sink, { width: w, height: h, fps: 30000 / 1001, codec: "raw24", segmentBytes });
  await avi.begin();
  for (const fr of frames) await avi.add(fr);
  await avi.finish();
}
const fourccs = (b: Uint8Array) => { const out: string[] = []; for (let i = 0; i + 4 <= b.length; i++) if (b[i] === 0x52 && b[i + 1] === 0x49 && b[i + 2] === 0x46 && b[i + 3] === 0x46) out.push(String.fromCharCode(...b.subarray(i + 8, i + 12))); return out; };
{
  const w = 40, h = 30, n = 100;
  const frames = Array.from({ length: n }, () => dib24(w, h, rand8(w * h * 3)));
  for (const seg of [undefined, 64 * 1024]) {
    const sink = new BlobSink();
    await writeAvi(sink, w, h, frames, seg);
    const blob = await sink.close("video/x-msvideo");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const label = seg ? "multi-segment" : "single-segment";
    ok(bytes.length === AviWriter.rawFileSize(w, h, n, { segmentBytes: seg }), `AVI ${label}: size estimate is exact`);
    const riffs = fourccs(bytes);
    ok(seg ? riffs[0] === "AVI " && riffs.length > 4 && riffs.slice(1).every((x) => x === "AVIX") : riffs.length === 1, `AVI ${label}: RIFF segments ${riffs.length}`);
    const a = await parseAvi(blob);
    ok(a.frames.length === n && a.width === w && a.height === h && a.compression === "BI_RGB" && a.bitCount === 24, `AVI ${label}: header and ${a.frames.length} frames`);
    ok(Math.abs(a.fps - 30000 / 1001) < 1e-9, `AVI ${label}: exact NTSC frame rate`);
    ok(a.notes.some((x) => x.startsWith("OpenDML index")), `AVI ${label}: read through the OpenDML index`);
    let same = true;
    for (let i = 0; i < n; i++) { const fr = a.frames[i]; if (!eq(bytes.subarray(fr.off, fr.off + fr.size), frames[i])) same = false; }
    ok(same, `AVI ${label}: every frame reads back byte-identical`);
    if (seg) {
      // without the super index, readers fall back to idx1 + scanning the AVIX segments
      const copy = bytes.slice();
      const at = Buffer.from(copy).indexOf("indx");
      copy.set([0x4a, 0x55, 0x4e, 0x4b], at); // 'JUNK'
      const b2 = await parseAvi(new Blob([copy]));
      let same2 = b2.frames.length === n;
      for (let i = 0; i < n && same2; i++) { const fr = b2.frames[i]; if (!eq(copy.subarray(fr.off, fr.off + fr.size), frames[i])) same2 = false; }
      ok(same2 && b2.notes.some((x) => x.includes("OpenDML segments")), "AVI without super index: idx1 + AVIX scan finds every frame");
      writeFileSync("/tmp/lucid-test-odml.avi", bytes);
    }
  }
  // FileSink (positioned writes, coalescing) produces the same bytes as BlobSink
  let file = new Uint8Array(0);
  const fake = {
    async write(o: { type: "write"; position: number; data: Uint8Array }) { const end = o.position + o.data.length; if (end > file.length) { const g = new Uint8Array(end); g.set(file); file = g; } file.set(o.data, o.position); },
    async close() {}, async abort() {},
  };
  const fs = new (FileSink as unknown as new (w: typeof fake) => FileSink)(fake);
  await writeAvi(fs, w, h, frames, 64 * 1024);
  await fs.close();
  const bs = new BlobSink();
  await writeAvi(bs, w, h, frames, 64 * 1024);
  const ref = new Uint8Array(await (await bs.close("x")).arrayBuffer());
  ok(eq(file, ref), "FileSink writes the same bytes as BlobSink");
}
ok(eq(fpsRational(29.97), [30000, 1001]) && eq(fpsRational(23.976), [24000, 1001]) && eq(fpsRational(59.94), [60000, 1001]) && eq(fpsRational(25), [25, 1]) && eq(fpsRational(12.5), [25, 2]) && eq(fpsRational(7.5), [15, 2]), "frame rates as exact rationals");

// ---- ZIP (stored) and ZIP64, checked with Python's zipfile
for (const force of [false, true]) {
  const sink = new BlobSink(), zip = new ZipWriter(sink, { forceZip64: force });
  const files = Array.from({ length: 7 }, (_, i) => ({ name: sequenceName("seq", i, 6, "tif"), data: rand8(1000 + i * 777) }));
  for (const f of files) await zip.add(f.name, f.data);
  await zip.finish();
  const blob = await sink.close("application/zip");
  const entries = await readZipEntries(blob);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  ok(entries.length === 7 && entries.every((e, i) => e.name === files[i].name && e.crc === crc32(files[i].data) && eq(bytes.subarray(e.offset, e.offset + e.size), files[i].data)), `ZIP${force ? "64" : ""}: entries read back`);
  ok(!force || bytes.length === ZipWriter.size(files.map((f) => ({ name: f.name, size: f.data.length })), true), "ZIP64 size estimate");
  ok(force || bytes.length === ZipWriter.size(files.map((f) => ({ name: f.name, size: f.data.length }))), "ZIP size estimate");
  const path = `/tmp/lucid-test${force ? "64" : ""}.zip`;
  writeFileSync(path, bytes);
  try {
    const out = execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.infolist()), all(i.compress_type==0 for i in z.infolist()))", path], { encoding: "utf8" }).trim();
    ok(out === "7 True", `ZIP${force ? "64" : ""}: Python zipfile reads every entry, all stored (${out})`);
  } catch (e) { ok(false, `ZIP${force ? "64" : ""}: Python zipfile failed: ${(e as Error).message}`); }
}
// estimate of a sequence matches what the writer produces
{
  const w = 20, h = 10, sink = new BlobSink(), zip = new ZipWriter(sink);
  const f = { w, h, d: new Float32Array(w * h * 4) };
  for (let i = 3; i <= 9; i++) await zip.add(sequenceName("out", i, 9, "tif"), (await encodeStill(f, "tiff16", 1, false)).bytes);
  await zip.finish();
  ok(sink.pos === estimateBytes("tiff16", w, h, 3, 9, "out"), `sequence size estimate is exact (${sink.pos} vs ${estimateBytes("tiff16", w, h, 3, 9, "out")})`);
}

console.log(fail ? `writers: ${fail} failures, ${pass} passed` : `writers: all ${pass} checks OK`);
process.exit(fail ? 1 : 0);
