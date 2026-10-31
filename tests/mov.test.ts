// Uncompressed QuickTime: 16-bit RGB video + 32-bit float PCM audio writer, the reader, size estimates, and
// (when ffmpeg is installed) an independent decode of the written file.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameTiming, MovWriter, parseMov, rgb48be } from "../src/shared/codecs/mov";
import { BlobSink } from "../src/shared/codecs/sink";
import { estimateBytes } from "../src/shared/formats";

let fail = 0, pass = 0;
const ok = (cond: unknown, msg: string) => { if (cond) pass++; else { fail++; console.log("FAIL", msg); } };
let seed = 777;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const rand16 = (n: number) => Uint16Array.from({ length: n }, () => (rnd() * 65536) | 0);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- frame timing is exact for common rates
for (const [fps, ts, d] of [[25, 25, 1], [30000 / 1001, 30000, 1001], [24000 / 1001, 24000, 1001], [60, 60, 1], [12.5, 1_000_000, 80000]] as const) {
  const t = frameTiming(fps);
  ok(t.timescale === ts && t.delta === d, `timing for ${fps.toFixed(3)} fps: ${t.timescale}/${t.delta}`);
}

// ---- big-endian packing
ok(sameBytes(rgb48be(Uint16Array.of(0x1234, 0xffff, 0)), Uint8Array.of(0x12, 0x34, 0xff, 0xff, 0, 0)), "rgb48be packs big-endian");

async function write(w: number, h: number, frames: Uint16Array[], fps: number, audio?: { rate: number; ch: number; chunks: Float32Array[] }) {
  const sink = new BlobSink();
  const mov = new MovWriter(sink, { width: w, height: h, fps, audio: audio ? { sampleRate: audio.rate, channels: audio.ch } : null });
  await mov.begin();
  for (let i = 0; i < frames.length; i++) {
    await mov.addVideo(rgb48be(frames[i]));
    if (audio) await mov.addAudio(audio.chunks[i]);
  }
  await mov.finish();
  return (await sink.close("video/quicktime"))!;
}

// ---- video only: reader finds every frame, size estimate is exact
{
  const w = 33, h = 17, n = 7, frames = Array.from({ length: n }, () => rand16(w * h * 3));
  const blob = await write(w, h, frames, 25);
  ok(blob.size === MovWriter.fileSize(w, h, n) && blob.size === estimateBytes("mov-rgb48", w, h, 0, n - 1), `size estimate is exact (${blob.size} vs ${MovWriter.fileSize(w, h, n)})`);
  const m = await parseMov(blob);
  ok(m.codec === "b48r" && m.width === w && m.height === h && m.depth === 48 && m.frames.length === n && Math.abs(m.fps - 25) < 1e-9 && !m.audio, `reader: header ${m.codec} ${m.width}x${m.height} ${m.frames.length} frames ${m.fps} fps`);
  let same = true;
  for (let i = 0; i < n; i++) same &&= sameBytes(new Uint8Array(await blob.slice(m.frames[i].off, m.frames[i].off + m.frames[i].size).arrayBuffer()), rgb48be(frames[i]));
  ok(same, "reader: every frame's samples read back unchanged");
}

// ---- with audio: uneven chunk sizes, stereo
{
  const w = 16, h = 9, n = 6, rate = 44100, ch = 2, fps = 30000 / 1001;
  const frames = Array.from({ length: n }, () => rand16(w * h * 3));
  const per = (k: number) => Math.round(((k + 1) * rate) / fps) - Math.round((k * rate) / fps);
  const chunks = Array.from({ length: n }, (_, k) => Float32Array.from({ length: per(k) * ch }, () => rnd() * 2 - 1));
  const blob = await write(w, h, frames, fps, { rate, ch, chunks });
  const m = await parseMov(blob);
  ok(m.frames.length === n && m.audio?.codec === "lpcm" && m.audio.sampleRate === rate && m.audio.channels === ch && Math.abs(m.fps - fps) < 1e-9, `reader with audio: ${JSON.stringify(m.audio)} ${m.fps}`);
  let same = true;
  for (let i = 0; i < n; i++) same &&= sameBytes(new Uint8Array(await blob.slice(m.frames[i].off, m.frames[i].off + m.frames[i].size).arrayBuffer()), rgb48be(frames[i]));
  ok(same, "reader with audio: video samples unchanged between audio chunks");

  // independent decoder: ffmpeg must see the same pixels and the same audio samples
  let ff = "";
  try { ff = execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }) ? "ffmpeg" : ""; } catch { /* not installed */ }
  if (ff) {
    const dir = mkdtempSync(join(tmpdir(), "mov-")), path = join(dir, "t.mov");
    writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
    const vid = execFileSync(ff, ["-v", "error", "-i", path, "-map", "0:v", "-f", "rawvideo", "-pix_fmt", "rgb48be", "-"], { maxBuffer: 1 << 28 });
    ok(sameBytes(new Uint8Array(vid), Uint8Array.from(frames.flatMap((f) => [...rgb48be(f)]))), "ffmpeg decodes the video bit for bit");
    const aud = execFileSync(ff, ["-v", "error", "-i", path, "-map", "0:a", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
    const want = new Float32Array(chunks.reduce((s, c) => s + c.length, 0)); let k = 0; for (const c of chunks) { want.set(c, k); k += c.length; }
    ok(sameBytes(new Uint8Array(aud), new Uint8Array(want.buffer)), `ffmpeg decodes the audio bit for bit (${aud.length / 4} samples)`);
  } else console.log("SKIP ffmpeg cross-check: ffmpeg is not installed");
}

console.log(fail ? `mov: ${fail} failures, ${pass} passed` : `mov: all ${pass} checks OK`);
process.exit(fail ? 1 : 0);
