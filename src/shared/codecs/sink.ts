// Output targets for the writers. Uncompressed video is large (about 155 MB per second at 1080p25), so
// files are never assembled with one big copy:
// - FileSink streams straight to disk through a writable file handle: a file the user picked (File System
//   Access, Chrome and Edge on computers) or a staging file in the browser's own storage.
// - SyncHandleSink writes a staging file in the browser's storage (Origin Private File System) through a
//   synchronous access handle: dedicated workers in Chrome, Edge, Firefox and Safari.
// - RemoteSink sends positioned writes to a staging file opened by the engine worker (live recordings).
// - BlobSink keeps the file as a list of Blob parts. Chromium moves large Blob data out of the page and
//   onto disk when memory runs short; other browsers keep it in memory.
// All support reserve() + patch(), used for headers whose sizes are only known at the end.

export interface ByteSink {
  /** Bytes written so far (the offset of the next write). */
  readonly pos: number;
  write(d: Uint8Array): Promise<void>;
  /** Writes `size` placeholder bytes and returns their offset; fill them in later with patch(). */
  reserve(size: number): Promise<number>;
  /** Overwrites a region returned by reserve() (same size). */
  patch(at: number, d: Uint8Array): Promise<void>;
  /** Completes the file: memory sinks return it as a Blob, disk sinks return null. */
  close(mime: string): Promise<Blob | null>;
  /** Discards a partial file. */
  abort(): Promise<void>;
}

const SMALL = 256 * 1024;   // writes below this size are coalesced
const BATCH = 4 * 1024 * 1024;

/** Recognizable message for a full storage quota (the error crosses threads as text). */
export const STORAGE_FULL = "The browser's storage is full";

/** Turns a quota error into a clear message; other errors pass through. */
export function storageError(e: unknown): Error {
  const err = e as { name?: string; message?: string } | null;
  if (err?.name === "QuotaExceededError" || /quota/i.test(err?.message ?? "")) return new Error(`${STORAGE_FULL} (${err?.message || "quota exceeded"})`);
  return e instanceof Error ? e : new Error(String(e));
}

/** A sink that can also write at any offset (staging files written from another thread). */
export interface PositionedSink extends ByteSink {
  writeAt(at: number, d: Uint8Array): Promise<void>;
}

/** Coalesces small writes (chunk headers, index entries) into larger blocks. */
class Coalescer {
  private buf = new Uint8Array(BATCH);
  private n = 0;
  get size() { return this.n; }
  add(d: Uint8Array): boolean {
    if (this.n + d.length > this.buf.length) return false;
    this.buf.set(d, this.n);
    this.n += d.length;
    return true;
  }
  take(): Uint8Array { const out = this.buf.slice(0, this.n); this.n = 0; return out; }
}

export class BlobSink implements ByteSink {
  pos = 0;
  private parts: (Blob | Uint8Array)[] = [];
  private reserved = new Map<number, { index: number; size: number }>();
  private small = new Coalescer();
  private closed = false;

  private flush() { if (this.small.size) this.parts.push(new Blob([this.small.take() as Uint8Array<ArrayBuffer>])); }

  async write(d: Uint8Array) {
    if (this.closed) throw new Error("The output is already closed");
    if (d.length < SMALL && this.small.add(d)) { this.pos += d.length; return; }
    this.flush();
    if (d.length < SMALL) this.small.add(d);
    // Copy into a Blob right away: the caller may reuse its buffer, and the browser can page Blob data out.
    else this.parts.push(new Blob([d as Uint8Array<ArrayBuffer>]));
    this.pos += d.length;
  }

  async reserve(size: number): Promise<number> {
    this.flush();
    const at = this.pos;
    this.reserved.set(at, { index: this.parts.length, size });
    this.parts.push(new Uint8Array(size));
    this.pos += size;
    return at;
  }

  async patch(at: number, d: Uint8Array) {
    const r = this.reserved.get(at);
    if (!r || r.size !== d.length) throw new Error("Internal error: patch outside a reserved region");
    this.parts[r.index] = d.slice();
  }

  async close(mime: string): Promise<Blob> {
    this.flush();
    this.closed = true;
    const blob = new Blob(this.parts as BlobPart[], { type: mime });
    this.parts = [];
    if (blob.size !== this.pos) throw new Error(`Internal error: the output has ${blob.size} bytes instead of ${this.pos}`);
    return blob;
  }

  async abort() { this.parts = []; this.closed = true; }
}

interface Writable {
  write(d: { type: "write"; position: number; data: Uint8Array } | Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export class FileSink implements PositionedSink {
  pos = 0;
  private small = new Coalescer();
  private smallAt = 0;
  private constructor(private w: Writable) {}

  /** True when this context can write to a file handle (File System Access API). */
  static supported(): boolean {
    const H = (globalThis as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle;
    return !!H && "createWritable" in H.prototype;
  }

  static async open(handle: FileSystemFileHandle): Promise<FileSink> {
    const w = await (handle as unknown as { createWritable(o?: { keepExistingData?: boolean }): Promise<Writable> }).createWritable({ keepExistingData: false });
    return new FileSink(w);
  }

  private async put(position: number, data: Uint8Array) {
    try { await this.w.write({ type: "write", position, data }); } catch (e) { throw storageError(e); }
  }

  private async flush() {
    if (!this.small.size) return;
    const at = this.smallAt, data = this.small.take();
    await this.put(at, data);
  }

  async write(d: Uint8Array) {
    if (d.length < SMALL) {
      if (!this.small.size) this.smallAt = this.pos;
      if (!this.small.add(d)) { await this.flush(); this.smallAt = this.pos; this.small.add(d); }
      this.pos += d.length;
      return;
    }
    await this.flush();
    await this.put(this.pos, d);
    this.pos += d.length;
  }

  async reserve(size: number): Promise<number> {
    const at = this.pos;
    await this.write(new Uint8Array(size));
    return at;
  }

  async patch(at: number, d: Uint8Array) {
    await this.flush();
    await this.put(at, d);
  }

  writeAt(at: number, d: Uint8Array) { return this.patch(at, d); }

  async close(): Promise<null> {
    await this.flush();
    try { await this.w.close(); } catch (e) { throw storageError(e); }
    return null;
  }

  async abort() { try { await this.w.abort(); } catch { /* already closed */ } }
}

/** Synchronous access handle of a file in the browser's storage (dedicated workers only). truncate, flush
 *  and close returned promises in early implementations, so their results are awaited. */
interface SyncAccessHandle {
  write(d: Uint8Array, o?: { at?: number }): number;
  truncate(size: number): unknown;
  flush(): unknown;
  close(): unknown;
}

export class SyncHandleSink implements PositionedSink {
  pos = 0;
  private small = new Coalescer();
  private smallAt = 0;
  private open = true;
  constructor(private h: SyncAccessHandle) {}

  /** True when this context can create synchronous access handles (a dedicated worker). */
  static supported(): boolean {
    const H = (globalThis as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle;
    return !!H && "createSyncAccessHandle" in H.prototype;
  }

  static async open(handle: FileSystemFileHandle): Promise<SyncHandleSink> {
    const h = await (handle as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> }).createSyncAccessHandle();
    try { await h.truncate(0); } catch (e) { try { await h.close(); } catch { /* ignore */ } throw e; }
    return new SyncHandleSink(h);
  }

  private put(at: number, d: Uint8Array) {
    if (!this.open) throw new Error("The output is already closed");
    let done = 0;
    try {
      while (done < d.length) {
        const n = this.h.write(done ? d.subarray(done) : d, { at: at + done });
        if (!(n > 0)) throw new Error(`the browser stored ${done} of ${d.length} bytes`);
        done += n;
      }
    } catch (e) { throw storageError(e); }
  }

  private flushSmall() { if (this.small.size) { const at = this.smallAt; this.put(at, this.small.take()); } }

  async write(d: Uint8Array) {
    if (d.length < SMALL) {
      if (!this.small.size) this.smallAt = this.pos;
      if (!this.small.add(d)) { this.flushSmall(); this.smallAt = this.pos; this.small.add(d); }
      this.pos += d.length;
      return;
    }
    this.flushSmall();
    this.put(this.pos, d);
    this.pos += d.length;
  }

  async reserve(size: number): Promise<number> {
    const at = this.pos;
    await this.write(new Uint8Array(size));
    return at;
  }

  async patch(at: number, d: Uint8Array) { this.flushSmall(); this.put(at, d); }

  writeAt(at: number, d: Uint8Array) { return this.patch(at, d); }

  async close(): Promise<null> {
    this.flushSmall();
    try { await this.h.flush(); } catch (e) { throw storageError(e); }
    this.open = false;
    await this.h.close();
    return null;
  }

  async abort() {
    if (!this.open) return;
    this.open = false;
    try { await this.h.close(); } catch { /* already closed */ }
  }
}

/** Calls a method of the thread that owns the staging file; `transfer` moves buffers instead of copying. */
export type RemoteCall = (method: string, args: unknown[], transfer?: Transferable[]) => Promise<any>;

/**
 * A staging file owned by the engine worker, written from this thread (live recordings): positions are
 * tracked here and every write carries its offset (stageWrite), so the worker needs no state but the file.
 */
export class RemoteSink implements ByteSink {
  pos = 0;
  /** The completed file (after close). */
  file: File | null = null;
  private small = new Coalescer();
  private smallAt = 0;
  constructor(private call: RemoteCall, readonly entry: string) {}

  private async send(at: number, d: Uint8Array) {
    // the caller may reuse its buffer: move a copy
    const copy = d.slice();
    await this.call("stageWrite", [this.entry, at, copy], [copy.buffer]);
  }

  private async flush() {
    if (!this.small.size) return;
    const at = this.smallAt;
    await this.send(at, this.small.take());
  }

  async write(d: Uint8Array) {
    if (d.length < SMALL) {
      if (!this.small.size) this.smallAt = this.pos;
      if (!this.small.add(d)) { await this.flush(); this.smallAt = this.pos; this.small.add(d); }
      this.pos += d.length;
      return;
    }
    await this.flush();
    await this.send(this.pos, d);
    this.pos += d.length;
  }

  async reserve(size: number): Promise<number> {
    const at = this.pos;
    await this.write(new Uint8Array(size));
    return at;
  }

  async patch(at: number, d: Uint8Array) { await this.flush(); await this.send(at, d); }

  async close(): Promise<null> {
    await this.flush();
    this.file = await this.call("stageClose", [this.entry]);
    return null;
  }

  async abort() { try { await this.call("stageAbort", [this.entry]); } catch { /* the worker is gone */ } }
}
