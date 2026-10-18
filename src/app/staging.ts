// Downloads staged on disk (see shared/staging.ts and engine/staging.ts).
//
// Where the browser cannot write to a file the user picks, large exports and live recordings are written
// by the engine to the browser's storage for this site — on disk, not in memory — and downloaded from
// there. The browser copies the staged file into the Downloads folder; it must stay in place until that
// copy has finished, so staged files are kept until the user frees them (Settings › Export) or LUCID
// starts again. Each tab holds a Web Lock for its own staged files, so another LUCID tab never removes a
// file that is still being written or downloaded.
import { RemoteSink } from "../shared/codecs/sink";
import { STAGE_LOCK, STAGING_DIR, stagedEntryName, stagedEntryTime } from "../shared/staging";
import type { EngineClient } from "./engineClient";

export type StagedKind = "export" | "recording";

export interface StagedDownload {
  entry: string;
  /** File name of the download. */
  name: string;
  bytes: number;
  kind: StagedKind;
  file: File | null;
  url: string | null;
  created: number;
}

export interface StagingStatus {
  /** Staging works in this browser (a test file was written and read back by the engine). */
  ok: boolean;
  api?: "sync" | "writable";
  reason?: string;
  quota: number | null;
  usage: number | null;
  /** Bytes the site may still store (quota − usage), when the browser reports them. */
  room: number | null;
  persisted: boolean;
  /** The browser raises the quota of sites allowed to store data persistently (Firefox). */
  canPersist: boolean;
}

/** Staging files of closed tabs are removed at startup once they are this old. */
const ORPHAN_AGE = 60 * 60 * 1000;

interface LockLike { request(name: string, cb: () => Promise<void>): Promise<unknown>; query?(): Promise<{ held?: { name?: string }[]; pending?: { name?: string }[] }> }
const locks = (): LockLike | null => (navigator as { locks?: LockLike }).locks ?? null;

export class Staging {
  /** Exports smaller than this are assembled in memory (nothing to clean up). Tests lower it. */
  minBytes = 32 * 1048576;
  private items = new Map<string, StagedDownload>();
  private releases = new Map<string, () => void>();
  private probe: Promise<{ ok: boolean; api?: "sync" | "writable"; reason?: string }> | null = null;

  constructor(private engine: EngineClient) {
    // the engine moved into the page (Safari, pages opened from disk): its storage access differs
    engine.on("mode", () => { this.probe = null; });
  }

  async status(): Promise<StagingStatus> {
    const p = await (this.probe ??= this.engine.call<{ ok: boolean; api?: "sync" | "writable"; reason?: string }>("stageProbe").catch((e: Error) => ({ ok: false, reason: e.message })));
    const storage = navigator.storage as StorageManager | undefined;
    let quota: number | null = null, usage: number | null = null, persisted = false;
    try { const est = await storage?.estimate?.(); if (est) { quota = est.quota ?? null; usage = est.usage ?? null; } } catch { /* not reported */ }
    try { persisted = (await storage?.persisted?.()) ?? false; } catch { /* not reported */ }
    const room = quota !== null && usage !== null ? Math.max(0, quota - usage) : null;
    // Firefox limits sites to 10% of the disk (at most 10 GiB) unless they may store data persistently
    const canPersist = p.ok && !persisted && typeof storage?.persist === "function" && /Firefox\//.test(navigator.userAgent);
    return { ...p, quota, usage, room, persisted, canPersist };
  }

  /** Asks the browser to let the site store data persistently (Firefox shows a prompt). */
  async requestPersistence(): Promise<boolean> {
    try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
  }

  /** Names a new staging file for `name` and takes its lock. */
  async reserve(name: string, kind: StagedKind): Promise<string> {
    const entry = stagedEntryName(name);
    await this.lock(entry);
    this.items.set(entry, { entry, name, bytes: 0, kind, file: null, url: null, created: Date.now() });
    return entry;
  }

  private lock(entry: string): Promise<void> {
    const lm = locks();
    if (!lm) return Promise.resolve();
    return new Promise<void>((acquired) => {
      lm.request(STAGE_LOCK + entry, () => new Promise<void>((release) => { this.releases.set(entry, release); acquired(); })).catch(() => acquired());
    });
  }

  private forget(entry: string) {
    const it = this.items.get(entry);
    if (it?.url) URL.revokeObjectURL(it.url);
    this.items.delete(entry);
    this.releases.get(entry)?.();
    this.releases.delete(entry);
  }

  /** Records a completed staging file. */
  done(entry: string, file: File, bytes: number) {
    const it = this.items.get(entry);
    if (it) { it.file = file; it.bytes = bytes; }
  }

  /** Starts (or repeats) the download of a staged file. The link stays valid until the file is freed. */
  download(entry: string) {
    const it = this.items.get(entry);
    if (!it?.file) return;
    it.url ??= URL.createObjectURL(it.file);
    const a = document.createElement("a");
    a.href = it.url; a.download = it.name; a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /** Completed staged files of this tab, newest first. */
  list(): StagedDownload[] { return [...this.items.values()].filter((i) => i.file).sort((a, b) => b.created - a.created); }

  /** Removes staged files (once their downloads have finished); returns the bytes freed. */
  async free(entries: string[]): Promise<number> {
    if (!entries.length) return 0;
    const gone = await this.engine.call<string[]>("stageRemove", entries).catch(() => [] as string[]);
    let freed = 0;
    for (const e of gone) { freed += this.items.get(e)?.bytes ?? 0; this.forget(e); }
    return freed;
  }

  /** Gives up a staging file whose writing failed or was cancelled. */
  async discard(entry: string) {
    await this.engine.call("stageRemove", [entry]).catch(() => { /* engine gone: removed at the next start */ });
    this.forget(entry);
  }

  /** Removes staging files left by LUCID tabs that are closed (no lock) and older than an hour. */
  async sweep(): Promise<number> {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(STAGING_DIR, { create: false });
      const lm = locks();
      const q = lm?.query ? await lm.query() : null;
      const held = new Set([...(q?.held ?? []), ...(q?.pending ?? [])].map((l) => l.name));
      const names: string[] = [];
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
      let removed = 0;
      for (const name of names) {
        if (this.items.has(name) || held.has(STAGE_LOCK + name)) continue;
        const t = stagedEntryTime(name);
        if (t !== null && Date.now() - t < ORPHAN_AGE) continue;
        // without Web Locks, only age tells whether another tab may still use the file
        if (!lm?.query && t === null) continue;
        try { await dir.removeEntry(name); removed++; } catch { /* in use */ }
      }
      return removed;
    } catch { return 0; }
  }

  /** Opens a staging file written piece by piece from the page (live recordings). */
  async openSink(name: string, kind: StagedKind): Promise<RemoteSink> {
    const entry = await this.reserve(name, kind);
    try { await this.engine.call("stageOpen", entry); }
    catch (e) { await this.discard(entry); throw e; }
    return new RemoteSink((method, args, transfer) => this.engine.callTransfer(method, args, transfer), entry);
  }
}
