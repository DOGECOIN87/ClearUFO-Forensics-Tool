// Manual test: writes an uncompressed 1080p AVI larger than 4 GB through FileSink (positioned writes
// to a real file), then reads it back with the app's AVI parser. Run:
//   npx esbuild tests/manual/large-avi.ts --bundle --platform=node --format=esm --external:mediabunny --external:utif2 --outfile=node_modules/.lucid-tests/large-avi.mjs && node node_modules/.lucid-tests/large-avi.mjs /path/out.avi [frames]
// Verify independently: python3 tests/manual/check_avi.py /path/out.avi
import { openSync, writeSync, closeSync, readSync, statSync, writeFileSync } from "node:fs";
import { AviWriter } from "../../src/shared/codecs/avi";
import { dib24 } from "../../src/shared/codecs/image";
import { FileSink } from "../../src/shared/codecs/sink";
import { parseAvi } from "../../src/engine/sources/avi";
import { md5 } from "../../src/engine/hash";

const path = process.argv[2] ?? "/tmp/large.avi";
const n = Number(process.argv[3] ?? 750);
const w = 1920, h = 1080;
/** Deterministic frame i: a gradient whose phase depends on i, plus the frame number in the first row. */
export function frameRGB(i: number): Uint8Array {
  const s = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 3; s[o] = (x + i) & 255; s[o + 1] = (y + 3 * i) & 255; s[o + 2] = (x ^ y ^ i) & 255; }
  for (let k = 0; k < 4; k++) s[k] = (i >> (8 * k)) & 255;
  return s;
}
/** File-backed Blob stand-in: Node 20's fs.openAsBlob returns empty slices beyond about 1 GB. */
class FileBlob {
  constructor(private fd: number, readonly size: number, private start = 0) {}
  slice(a = 0, b = this.size) { const s = Math.min(this.size, Math.max(0, a)), e = Math.min(this.size, Math.max(s, b)); return new FileBlob(this.fd, e - s, this.start + s); }
  async arrayBuffer() { const buf = new Uint8Array(this.size); let done = 0; while (done < this.size) done += readSync(this.fd, buf, done, this.size - done, this.start + done); return buf.buffer; }
}
const verifyOnly = process.argv.includes("--verify");
const hashes: string[] = [];
if (!verifyOnly) {
const fd = openSync(path, "w");
const writable = {
  async write(o: { type: "write"; position: number; data: Uint8Array }) { let done = 0; while (done < o.data.length) done += writeSync(fd, o.data, done, o.data.length - done, o.position + done); },
  async close() { closeSync(fd); }, async abort() { closeSync(fd); },
};
const sink = new (FileSink as unknown as new (x: typeof writable) => FileSink)(writable);
const avi = new AviWriter(sink, { width: w, height: h, fps: 25, codec: "raw24" });
const t0 = Date.now();
await avi.begin();
for (let i = 0; i < n; i++) {
  const rgb = frameRGB(i);
  hashes.push(md5(rgb));
  await avi.add(dib24(w, h, rgb));
}
await avi.finish();
await sink.close();
console.log(`wrote ${n} frames, ${(sink.pos / 2 ** 30).toFixed(2)} GiB in ${((Date.now() - t0) / 1000).toFixed(1)} s; expected size ${AviWriter.rawFileSize(w, h, n)} actual ${sink.pos}`);
writeFileSync(path + ".md5", hashes.join("\n") + "\n");
}
const hashes2 = Array.from({ length: n }, (_, i) => md5(frameRGB(i)));
const blob = new FileBlob(openSync(path, "r"), statSync(path).size) as unknown as Blob;
const a = await parseAvi(blob);
let bad = 0;
console.log(`parseAvi: ${a.frames.length} frames, ${a.notes.join("; ")}`);
console.log(a.frames.length === n ? `frame count ${n}: OK` : `FAILED: ${a.frames.length} frames instead of ${n}`);
if (a.frames.length !== n) bad++;
for (const i of [0, 1, 159, 160, 161, Math.floor(n / 2), 640, 690, n - 2, n - 1].filter((i) => i < a.frames.length)) {
  const fr = a.frames[i];
  const d = new Uint8Array(await blob.slice(fr.off, fr.off + fr.size).arrayBuffer());
  const rgb = new Uint8Array(w * h * 3), stride = w * 3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (h - 1 - y) * stride + x * 3, o = (y * w + x) * 3; rgb[o] = d[s + 2]; rgb[o + 1] = d[s + 1]; rgb[o + 2] = d[s]; }
  const ok = md5(rgb) === hashes2[i];
  if (!ok) bad++;
  console.log(`frame ${i} at offset ${fr.off} (${fr.off > 2 ** 32 ? "beyond 4 GB" : "below 4 GB"}): ${ok ? "identical" : "DIFFERENT"}`);
}
console.log(bad ? `FAILED: ${bad} frames differ` : "all sampled frames identical");
