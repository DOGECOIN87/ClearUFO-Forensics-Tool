// Staging sinks (browser storage on disk): SyncHandleSink and RemoteSink must write exactly the bytes of
// the in-memory BlobSink for every writer (OpenDML AVI with patched headers, stored ZIP), survive short
// writes, report a full quota clearly, and never let the caller's buffers be moved or changed.
import { AviWriter } from "../src/shared/codecs/avi";
import { dib24 } from "../src/shared/codecs/image";
import { BlobSink, RemoteSink, STORAGE_FULL, storageError, SyncHandleSink, type ByteSink } from "../src/shared/codecs/sink";
import { readZipEntries, ZipWriter } from "../src/shared/codecs/zip";
import { stagedEntryName, stagedEntryTime } from "../src/shared/staging";
import { parseAvi } from "../src/engine/sources/avi";

let fail = 0, pass = 0;
const ok = (cond: unknown, msg: string) => { if (cond) pass++; else { fail++; console.log("FAIL", msg); } };
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
let seed = 777;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const rand8 = (n: number) => Uint8Array.from({ length: n }, () => (rnd() * 256) | 0);

/** A growing in-memory file with positioned writes. */
class MemFile {
  data = new Uint8Array(0);
  writes = 0;
  put(at: number, d: Uint8Array) {
    const end = at + d.length;
    if (end > this.data.length) { const g = new Uint8Array(Math.max(end, this.data.length * 2)); g.set(this.data); this.data = g; this.size = Math.max(this.size, end); }
    this.size = Math.max(this.size, end);
    this.data.set(d, at);
    this.writes++;
  }
  size = 0;
  bytes() { return this.data.slice(0, this.size); }
}

/** Fake synchronous access handle; `maxWrite` simulates short writes, `quota` a full storage. */
function fakeSyncHandle(f: MemFile, opts: { maxWrite?: number; quota?: number; asyncMethods?: boolean } = {}) {
  const ret = <T>(v: T) => (opts.asyncMethods ? Promise.resolve(v) : v);
  let closed = false, flushed = 0;
  return {
    get closed() { return closed; }, get flushed() { return flushed; },
    write(d: Uint8Array, o?: { at?: number }) {
      if (closed) throw new Error("closed");
      const at = o?.at ?? 0;
      if (opts.quota !== undefined && at + d.length > opts.quota) { const e = new Error("The operation failed because it would cause the application to exceed its storage quota."); (e as { name: string }).name = "QuotaExceededError"; throw e; }
      const n = Math.min(d.length, opts.maxWrite ?? Infinity);
      f.put(at, d.subarray(0, n));
      return n;
    },
    truncate(n: number) { f.size = n; return ret(undefined); },
    flush() { flushed++; return ret(undefined); },
    close() { closed = true; return ret(undefined); },
  };
}
const syncSink = (h: ReturnType<typeof fakeSyncHandle>) => new (SyncHandleSink as unknown as new (x: typeof h) => SyncHandleSink)(h);

async function writeAvi(sink: ByteSink, frames: Uint8Array[], w: number, h: number, segmentBytes?: number) {
  const avi = new AviWriter(sink, { width: w, height: h, fps: 25, codec: "raw24", segmentBytes });
  await avi.begin();
  for (const fr of frames) await avi.add(fr);
  await avi.finish();
}
const ZIP_DATE = new Date(2026, 9, 16, 12, 0, 0); // fixed: entries carry their time (2-second steps)
async function writeZip(sink: ByteSink, files: Uint8Array[]) {
  const zip = new ZipWriter(sink);
  for (let i = 0; i < files.length; i++) await zip.add(`f_${i}.bin`, files[i], ZIP_DATE);
  await zip.finish();
}
const blobBytes = async (b: Blob | null) => new Uint8Array(await b!.arrayBuffer());

const w = 64, h = 48, n = 40;
const frames = Array.from({ length: n }, () => dib24(w, h, rand8(w * h * 3)));
const ref = new BlobSink();
await writeAvi(ref, frames, w, h, 128 * 1024);
const refBytes = await blobBytes(await ref.close("video/x-msvideo"));
const files = [rand8(10), rand8(300_000), rand8(1), rand8(5_000_000), rand8(17)];
const zref = new BlobSink();
await writeZip(zref, files);
const zrefBytes = await blobBytes(await zref.close("application/zip"));

// ---- SyncHandleSink: same bytes as BlobSink, also with short writes and promise-returning methods
for (const opts of [{}, { maxWrite: 1000 }, { asyncMethods: true }, { maxWrite: 65536, asyncMethods: true }]) {
  const label = JSON.stringify(opts);
  const f = new MemFile(), hd = fakeSyncHandle(f, opts), sink = syncSink(hd);
  await writeAvi(sink, frames, w, h, 128 * 1024);
  ok(sink.pos === refBytes.length, `SyncHandleSink ${label}: position ${sink.pos}`);
  ok((await sink.close("x")) === null && hd.closed && hd.flushed === 1, `SyncHandleSink ${label}: flushed and closed, no Blob`);
  ok(eq(f.bytes(), refBytes), `SyncHandleSink ${label}: OpenDML AVI identical to the in-memory file`);
  const zf = new MemFile(), zs = syncSink(fakeSyncHandle(zf, opts));
  await writeZip(zs, files);
  await zs.close("x");
  ok(eq(zf.bytes(), zrefBytes), `SyncHandleSink ${label}: stored ZIP identical`);
}
{
  // the staged file reads back through the app's AVI parser
  const f = new MemFile(), sink = syncSink(fakeSyncHandle(f));
  await writeAvi(sink, frames, w, h, 128 * 1024);
  await sink.close("x");
  const a = await parseAvi(new Blob([f.bytes()]));
  ok(a.frames.length === n && a.frames.every((fr, i) => eq(f.bytes().subarray(fr.off, fr.off + fr.size), frames[i])), "staged AVI: every frame reads back through the app's parser");
  // small writes are coalesced (few positioned writes for many chunk headers)
  ok(f.writes < n + 20, `small writes coalesced: ${f.writes} positioned writes for ${n} frames`);
}
{
  // a full quota surfaces as a recognizable message; abort closes the handle once
  const f = new MemFile(), hd = fakeSyncHandle(f, { quota: 200_000 }), sink = syncSink(hd);
  let msg = "";
  try { await writeAvi(sink, frames, w, h); } catch (e) { msg = (e as Error).message; }
  ok(msg.startsWith(STORAGE_FULL) && msg.includes("quota"), `quota error reported clearly: "${msg.slice(0, 70)}…"`);
  await sink.abort(); await sink.abort();
  ok(hd.closed, "abort closes the access handle");
  let after = "";
  try { await sink.write(new Uint8Array(300_000)); } catch (e) { after = (e as Error).message; }
  ok(/closed/.test(after), "writes after abort are refused");
}
{
  const plain = new Error("disk unplugged");
  ok(storageError(plain) === plain, "other errors pass through unchanged");
  const q = Object.assign(new Error(""), { name: "QuotaExceededError" });
  ok(storageError(q).message.startsWith(STORAGE_FULL), "QuotaExceededError by name");
  ok(storageError("text").message === "text", "non-Error values become Errors");
}

// ---- RemoteSink: positioned writes sent to another thread
{
  const f = new MemFile();
  const moved: ArrayBuffer[] = [];
  let calls = 0, closed = false, aborted = false;
  const call = async (method: string, args: unknown[], transfer?: Transferable[]) => {
    calls++;
    if (method === "stageWrite") {
      const [entry, at, data] = args as [string, number, Uint8Array];
      if (entry !== "e1") throw new Error("wrong entry");
      if (!transfer || transfer[0] !== data.buffer) throw new Error("buffer not transferred");
      moved.push(data.buffer as ArrayBuffer);
      f.put(at, data);
      return undefined;
    }
    if (method === "stageClose") { closed = true; return new File([f.bytes()], "staged.avi"); }
    if (method === "stageAbort") { aborted = true; return undefined; }
    throw new Error(method);
  };
  const sink = new RemoteSink(call, "e1");
  const copies = frames.map((fr) => fr.slice());
  await writeAvi(sink, frames, w, h, 128 * 1024);
  ok(frames.every((fr, i) => eq(fr, copies[i])) && !moved.some((b) => frames.some((fr) => fr.buffer === b)), "RemoteSink never moves or changes the caller's buffers");
  ok((await sink.close("x")) === null && closed && sink.file instanceof File, "RemoteSink: close returns the staged File");
  ok(eq(f.bytes(), refBytes), "RemoteSink: OpenDML AVI identical to the in-memory file");
  ok(eq(new Uint8Array(await sink.file!.arrayBuffer()), refBytes), "RemoteSink: the returned File holds the same bytes");
  ok(calls < n + 25, `RemoteSink: ${calls} calls for ${n} frames (small writes coalesced)`);
  await sink.abort();
  ok(aborted, "RemoteSink: abort asks the worker to discard the file");
  const zf = new MemFile();
  const zs = new RemoteSink(async (m, a) => { if (m === "stageWrite") { const [, at, d] = a as [string, number, Uint8Array]; zf.put(at, d); } return m === "stageClose" ? new File([zf.bytes()], "z") : undefined; }, "e2");
  await writeZip(zs, files);
  await zs.close("x");
  ok(eq(zf.bytes(), zrefBytes) && (await readZipEntries(new Blob([zf.bytes()]))).length === files.length, "RemoteSink: stored ZIP identical and readable");
}

// ---- staging entry names
{
  const t = Date.UTC(2026, 9, 16, 12, 0, 0);
  const e = stagedEntryName("Case 12/exhibit:3.avi", t);
  ok(!/[\\/:]/.test(e) && e.endsWith("Case 12_exhibit_3.avi"), `entry name is a safe file name: ${e}`);
  ok(stagedEntryTime(e) === t, "creation time read back from the entry name");
  ok(stagedEntryTime("notes.txt") === null && stagedEntryTime("zz-1-x") === null, "names LUCID did not create have no time");
  ok(stagedEntryName("x".repeat(500)).length < 140, "long names are shortened");
  ok(stagedEntryName("a.avi") !== stagedEntryName("a.avi"), "entries are unique");
}

console.log(fail ? `staging: ${fail} failures, ${pass} passed` : `staging: all ${pass} checks OK`);
process.exit(fail ? 1 : 0);
