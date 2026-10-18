// LRU frame cache with a byte budget and in-flight request de-duplication.
import type { Frame } from "./frame";

interface Entry { frame: Frame; bytes: number }

export class FrameCache {
  private map = new Map<string, Entry>();
  private inflight = new Map<string, Promise<Frame>>();
  bytes = 0;
  hits = 0;
  misses = 0;

  constructor(public limit = 512 * 1024 * 1024) {}

  get(key: string): Frame | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.frame;
  }

  set(key: string, frame: Frame) {
    const bytes = frame.d.byteLength + 64;
    const old = this.map.get(key);
    if (old) { this.bytes -= old.bytes; this.map.delete(key); }
    if (bytes > this.limit) return;
    this.map.set(key, { frame, bytes });
    this.bytes += bytes;
    this.evict();
  }

  private evict() {
    while (this.bytes > this.limit && this.map.size) {
      const k = this.map.keys().next().value as string;
      const e = this.map.get(k)!;
      this.map.delete(k);
      this.bytes -= e.bytes;
    }
  }

  async getOrCompute(key: string, fn: () => Promise<Frame>): Promise<Frame> {
    const hit = this.get(key);
    if (hit) { this.hits++; return hit; }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    this.misses++;
    const p = fn().then(
      (f) => { this.inflight.delete(key); this.set(key, f); return f; },
      (e) => { this.inflight.delete(key); throw e; },
    );
    this.inflight.set(key, p);
    return p;
  }

  setLimit(bytes: number) { this.limit = bytes; this.evict(); }
  clear() { this.map.clear(); this.bytes = 0; }
  get size() { return this.map.size; }
}
