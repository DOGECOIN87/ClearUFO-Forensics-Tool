// Output targets for the writers.
//
// The browser reference streams to a Blob or to a file handle. On Android the app writes to a file in
// its own cache directory (the app can write there without any permission) and copies the finished
// file to the folder the examiner picks through the Storage Access Framework. Nothing is uploaded and
// the evidence file is never opened for writing.

export interface ByteSink {
  /** Bytes written so far (the offset of the next write). */
  readonly pos: number;
  write(d: Uint8Array): Promise<void>;
  /** Writes `size` placeholder bytes and returns their offset; fill them in later with patch(). */
  reserve(size: number): Promise<number>;
  /** Overwrites a region returned by reserve() (same size). */
  patch(at: number, d: Uint8Array): Promise<void>;
  /** Completes the file: memory sinks return the bytes, file sinks return null. */
  close(): Promise<Uint8Array | null>;
  /** Discards a partial file. */
  abort(): Promise<void>;
}

/** Sink that keeps the file in memory (used for small outputs and for the tests). */
export class MemorySink implements ByteSink {
  pos = 0;
  private parts: Uint8Array[] = [];
  private reserved = new Map<number, { index: number; size: number }>();
  private closed = false;

  async write(d: Uint8Array) {
    if (this.closed) throw new Error("The output is already closed");
    this.parts.push(d.slice());
    this.pos += d.length;
  }

  async reserve(size: number): Promise<number> {
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

  async close(): Promise<Uint8Array> {
    this.closed = true;
    let n = 0;
    for (const p of this.parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    if (out.length !== this.pos) throw new Error(`Internal error: the output has ${out.length} bytes instead of ${this.pos}`);
    return out;
  }

  async abort() { this.parts = []; this.closed = true; }
}
