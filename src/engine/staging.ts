// Staging files in the browser's storage (Origin Private File System): disk space that Chrome, Edge,
// Firefox and Safari give every site without a prompt, up to a quota. Exports are written there when the
// browser cannot write to a file the user picks, then downloaded, so their size is limited by the disk
// instead of memory. See shared/staging.ts.
//
// Writing prefers a synchronous access handle (dedicated workers; in-place writes, no temporary copy) and
// falls back to a writable stream. Some engines expose access handles without supporting them (WebKitGTK:
// "Backend does not support this operation"), and the failed attempt leaves that file unusable for a
// writable stream too. So the probe tries each way on its own scratch file, and staging files are only
// opened the way the probe validated.
import { FileSink, SyncHandleSink, type PositionedSink } from "../shared/codecs/sink";
import { STAGING_DIR, stagedEntryName } from "../shared/staging";

type Api = "sync" | "writable";
export interface StagedFile { entry: string; handle: FileSystemFileHandle; sink: PositionedSink; api: Api }
export interface StagingProbe { ok: boolean; api?: Api; reason?: string }

const message = (e: unknown) => (e as Error)?.message || (e as { name?: string })?.name || String(e);

async function stagingDir(): Promise<FileSystemDirectoryHandle> {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage;
  if (!storage?.getDirectory) throw new Error("This browser gives pages no file storage (Origin Private File System)");
  const root = await storage.getDirectory();
  return root.getDirectoryHandle(STAGING_DIR, { create: true });
}

async function openWith(api: Api, entry: string): Promise<StagedFile> {
  const dir = await stagingDir();
  const handle = await dir.getFileHandle(entry, { create: true });
  try {
    const sink = api === "sync" ? await SyncHandleSink.open(handle) : await FileSink.open(handle);
    return { entry, handle, sink, api };
  } catch (e) {
    await dir.removeEntry(entry).catch(() => { /* locked by the failed attempt: swept later */ });
    throw e;
  }
}

/** Removes staging files; returns the entries that no longer exist. Files still open elsewhere are kept. */
export async function removeStaged(entries: string[]): Promise<string[]> {
  let dir: FileSystemDirectoryHandle;
  try { dir = await stagingDir(); } catch { return []; }
  const gone: string[] = [];
  for (const e of entries) {
    try { await dir.removeEntry(e); gone.push(e); }
    catch (err) { if ((err as { name?: string })?.name === "NotFoundError") gone.push(e); }
  }
  return gone;
}

/** Writes, patches and reads back a small scratch file the given way. */
async function tryApi(api: Api): Promise<string | null> {
  const entry = stagedEntryName(`probe-${api}.tmp`);
  try {
    const st = await openWith(api, entry);
    try {
      const at = await st.sink.reserve(4);
      await st.sink.write(new Uint8Array([5, 6, 7, 8]));
      await st.sink.patch(at, new Uint8Array([1, 2, 3, 4]));
      await st.sink.close("application/octet-stream");
      const back = new Uint8Array(await (await st.handle.getFile()).arrayBuffer());
      return back.join() === "1,2,3,4,5,6,7,8" ? null : "a test file read back differently";
    } catch (e) { await st.sink.abort(); throw e; }
  } catch (e) { return message(e); }
  finally { await removeStaged([entry]); }
}

let probed: Promise<StagingProbe> | null = null;

/** Whether staging works here, and which way files are written (cached). */
export function probeStaging(): Promise<StagingProbe> {
  return (probed ??= (async (): Promise<StagingProbe> => {
    try { await stagingDir(); }
    catch (e) {
      // e.g. Chromium refuses storage to pages opened from disk (file://) with a cryptic SecurityError
      const blocked = (e as { name?: string })?.name === "SecurityError";
      return { ok: false, reason: blocked ? "the browser gives this page no storage (pages opened from disk, or storage blocked in the browser settings)" : message(e) };
    }
    const failures: string[] = [];
    if (SyncHandleSink.supported()) {
      const err = await tryApi("sync");
      if (!err) return { ok: true, api: "sync" };
      failures.push(`access handle: ${err}`);
    }
    if (FileSink.supported()) {
      const err = await tryApi("writable");
      if (!err) return { ok: true, api: "writable" };
      failures.push(`writable stream: ${err}`);
    }
    return { ok: false, reason: `This browser cannot write files to its storage${failures.length ? ` (${failures.join("; ")})` : ""}` };
  })());
}

/** Creates (or empties) the staging file `entry` and opens it the way the probe validated. */
export async function openStaged(entry: string): Promise<StagedFile> {
  const p = await probeStaging();
  if (!p.ok || !p.api) throw new Error(p.reason ?? "This browser cannot write files to its storage");
  return openWith(p.api, entry);
}
