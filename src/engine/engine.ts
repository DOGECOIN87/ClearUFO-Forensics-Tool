// Processing engine (runs inside a Web Worker).
// Each chain is evaluated lazily: every active filter becomes a node whose key is a hash of
// its type, parameters and upstream key. Changing a parameter only invalidates the nodes
// downstream of it; frames of every node are cached in a byte-budgeted LRU.
import { FILTERS, normalizeParams } from "../shared/filters";
import type { ChainDoc, FrameTable, RenderRequest, RenderResult, SourceInfo, SourceKind, WriteRequest, WriteResult, DvrScanResult } from "../shared/types";
import { FrameCache } from "./cache";
import { toRGBA8 } from "./frame";
import { convertToU8, wasmActive } from "./wasm/px";
import { laneCount, poolInfo, prewarmPool, setThreads } from "./pool";

/** Filters that run on the multi-core pool (their kernel workers are started when a project uses them). */
const POOLED_FILTERS = new Set(["nl_means", "bilateral_filter", "median_filter", "gaussian_filter", "unsharp_mask", "high_pass_sharpening",
  "wiener_filter", "motion_deblurring", "optical_deblurring", "gaussian_deblurring", "nonlinear_deblurring", "local_stabilization", "frame_averaging"]);
import { hashBlob, md5, MD5 } from "./hash";
import { basicFilters } from "./filters/basic";
import { linkFilters } from "./filters/link";
import { presentationFilters } from "./filters/presentation";
import { temporalFilters } from "./filters/temporal";
import { MediaElementSource, openDvr, openSource } from "./sources";
import type { SourceProvider } from "./sources/types";
import type { BuildCtx, FilterImpl, Stream } from "./stream";
import { writeStream } from "./writers/writers";
import { openStaged, probeStaging, removeStaged, type StagedFile } from "./staging";
import { canvasReadbackExact, videoFrameReadbackExact } from "./pixelcheck";
import { resize } from "./kernels/geometry";

const IMPLS: Record<string, FilterImpl> = { ...basicFilters, ...temporalFilters, ...linkFilters, ...presentationFilters };

export type Emit = (event: string, data: unknown) => void;
export type CallMain = (method: string, args: unknown) => Promise<any>;

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => !k.startsWith("_")).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

function hashStr(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

class FilterError extends Error {
  constructor(message: string, public filterId: string) { super(message); }
}

interface Node { key: string; promise: Promise<Stream> }

export class Engine {
  private sources = new Map<string, SourceProvider>();
  private media = new Map<string, Promise<SourceProvider>>();
  private chains = new Map<string, ChainDoc>();
  private nodes = new Map<string, Node>();
  private keyMemo = new Map<string, string[]>();
  private cache = new FrameCache(512 * 1024 * 1024);
  private tokens = new Map<string, number>();
  private cancelled = new Set<string>();
  private lastProgress = 0;
  private nodeTasks = new Set<string>();

  constructor(private emit: Emit, private callMain: CallMain) {}

  // ------------------------------------------------------------ sources
  async openSource(id: string, files: File[], kind: SourceKind | "auto", options: Record<string, any> = {}): Promise<SourceInfo> {
    const taskId = `open:${id}`;
    const src = await openSource(id, files, kind, options, (label, v) => this.progress(taskId, label, v));
    this.sources.get(id)?.dispose();
    this.sources.set(id, src);
    this.media.delete(id);
    this.progress(taskId, "", 1, true);
    if (src.analyze && !src.info.frameTypesReady) {
      // background GOP analysis (frame types and sizes)
      setTimeout(() => {
        src.analyze!((v) => this.progress(`analyze:${id}`, "Analyzing frame types", v))
          .then(() => { this.progress(`analyze:${id}`, "", 1, true); this.emit("source", src.info); })
          .catch(() => undefined);
      }, 50);
    }
    return src.info;
  }

  closeSource(id: string) {
    this.sources.get(id)?.dispose();
    this.sources.delete(id);
    this.media.delete(id);
  }

  sourceInfo(id: string): SourceInfo | null { return this.sources.get(id)?.info ?? null; }

  frameTable(id: string): FrameTable | null {
    const s = this.sources.get(id);
    if (!s) return null;
    if (s.table) return { ...s.table, types: s.table.types.slice(), bytes: s.table.bytes.slice(), pts: s.table.pts.slice() };
    const n = s.info.frameCount;
    const t: FrameTable = { sourceId: id, count: n, types: new Uint8Array(n), bytes: new Uint32Array(n), pts: new Float64Array(n), ready: true };
    for (let i = 0; i < n; i++) { const m = s.meta(i); t.types[i] = m.type === "I" ? 1 : m.type === "P" ? 2 : m.type === "B" ? 3 : 0; t.bytes[i] = m.bytes ?? 0; t.pts[i] = m.pts ?? i / s.info.fps; }
    return t;
  }

  async convertedFile(id: string): Promise<{ name: string; buffer: ArrayBuffer } | null> {
    const s = this.sources.get(id);
    if (!s?.converted) return null;
    return { name: s.converted.name, buffer: s.converted.buffer.slice(0) };
  }

  async scanDvr(id: string, file: File, options: Record<string, any>): Promise<{ info: SourceInfo; scan: DvrScanResult }> {
    const r = await openDvr(id, file, { codec: options.codec ?? "auto", fps: options.fps ?? 0, container: options.container ?? "auto" }, (l, v) => this.progress(`dvr:${id}`, l, v));
    this.sources.get(id)?.dispose();
    this.sources.set(id, r.provider);
    this.progress(`dvr:${id}`, "", 1, true);
    return { info: r.provider.info, scan: r.scan };
  }

  async hashFile(file: File, taskId: string) {
    const r = await hashBlob(file, (v) => this.progress(taskId, `Hashing ${file.name}`, v), () => this.cancelled.has(taskId));
    this.progress(taskId, "", 1, true);
    return r;
  }

  private mediaSource(id: string): Promise<SourceProvider> {
    let p = this.media.get(id);
    if (!p) {
      p = (async () => {
        const meta = await this.callMain("mtOpen", { sourceId: id });
        return new MediaElementSource(id, meta, this.sources.get(id), (time) => this.callMain("mtFrame", { sourceId: id, time }), (patch) => {
          const base = this.sources.get(id);
          if (base) { Object.assign(base.info, patch); this.emit("source", base.info); }
        });
      })();
      this.media.set(id, p);
      p.catch(() => this.media.delete(id));
    }
    return p;
  }

  // ------------------------------------------------------------ project
  setProject(chains: ChainDoc[]) {
    this.chains = new Map(chains.map((c) => [c.id, c]));
    this.maybePrewarm(1500);
    this.keyMemo.clear();
    const alive = new Set<string>();
    for (const c of chains) for (const f of c.filters) alive.add(f.id);
    for (const id of [...this.nodes.keys()]) if (!alive.has(id)) this.nodes.delete(id);
  }

  private chainKeys(chainId: string, visiting = new Set<string>()): string[] {
    const memo = this.keyMemo.get(chainId);
    if (memo) return memo;
    if (visiting.has(chainId)) throw new Error("Circular reference between chains (a chain uses itself as input)");
    const chain = this.chains.get(chainId);
    if (!chain) throw new Error("Linked chain not found");
    visiting.add(chainId);
    const keys: string[] = [];
    let key = "root";
    chain.filters.forEach((f, i) => {
      const def = FILTERS[f.type];
      if (def && (i === 0 || f.enabled) && def.kind !== "writer") {
        let deps = "";
        for (const pd of def.params) {
          if (pd.type === "chain" && f.params[pd.key]) deps += "|" + this.lastKey(f.params[pd.key], visiting);
          if (pd.type === "chains") for (const id of f.params[pd.key] || []) if (id !== chainId) deps += "|" + this.lastKey(id, visiting);
        }
        const src = f.params.source ? `|src:${f.params.source}:${this.sources.has(f.params.source) ? "1" : "0"}` : "";
        key = hashStr(`${key}>${f.type}:${stable(f.params)}${deps}${src}`);
      }
      keys.push(key);
    });
    visiting.delete(chainId);
    this.keyMemo.set(chainId, keys);
    return keys;
  }

  private lastKey(chainId: string, visiting: Set<string>): string {
    const k = this.chainKeys(chainId, visiting);
    return k[k.length - 1] ?? "empty";
  }

  private makeCtx(chain: ChainDoc, filterId: string, key: string): BuildCtx {
    return {
      chainId: chain.id,
      filterId,
      key,
      source: (id) => {
        const s = this.sources.get(id);
        if (!s) throw new Error("The media file of this loader is not available: use Browse to relink it");
        return s;
      },
      mediaSource: (id) => this.mediaSource(id),
      chainStream: (id) => this.chainOutput(id),
      chainName: (id) => this.chains.get(id)?.name ?? "?",
      originalStream: () => this.streamAt(chain.id, 0),
      sourceOfChain: () => { const sid = chain.filters[0]?.params?.source; return sid ? this.sources.get(sid) ?? null : null; },
      progress: (label, v) => { this.nodeTasks.add(`node:${filterId}`); this.progress(`node:${filterId}`, label, v, v >= 1); },
      isStale: () => this.nodes.get(filterId)?.key !== key,
    };
  }

  private wrap(s: Stream, key: string, filterId: string, name: string): Stream {
    return {
      info: s.info,
      meta: (i) => s.meta(i),
      getFrame: (i) => {
        const n = s.info.frameCount;
        const fi = Math.max(0, Math.min(n - 1, i | 0));
        return this.cache.getOrCompute(`${key}#${fi}`, () => s.getFrame(fi).catch((e) => {
          throw e instanceof FilterError ? e : new FilterError(`${name}: ${(e as Error)?.message ?? e}`, filterId);
        }));
      },
    };
  }

  async streamAt(chainId: string, idx: number): Promise<Stream> {
    const chain = this.chains.get(chainId);
    if (!chain) throw new Error("Chain not found");
    if (!chain.filters.length) throw new Error("The chain is empty");
    const keys = this.chainKeys(chainId);
    let stream: Stream | null = null;
    for (let i = 0; i <= Math.min(idx, chain.filters.length - 1); i++) {
      const f = chain.filters[i];
      const def = FILTERS[f.type];
      if (!def) throw new FilterError(`Unknown filter type "${f.type}"`, f.id);
      if ((i > 0 && !f.enabled) || def.kind === "writer") continue;
      if (i === 0 && def.kind !== "loader" && def.kind !== "link") throw new FilterError(`The first filter of a chain must be a loader (found "${def.name}")`, f.id);
      if (i > 0 && def.kind === "loader") throw new FilterError(`"${def.name}" can only be the first filter of a chain`, f.id);
      const impl = IMPLS[f.type];
      if (!impl) throw new FilterError(`"${def.name}" is not implemented`, f.id);
      const key = keys[i];
      let node = this.nodes.get(f.id);
      if (!node || node.key !== key) {
        const input = stream;
        const params = { ...normalizeParams(def, f.params), __type: f.type };
        const ctx = this.makeCtx(chain, f.id, key);
        const n: Node = { key, promise: Promise.resolve().then(() => impl(input, params, ctx)).then((s) => this.wrap(s, key, f.id, def.name)) };
        n.promise.catch(() => { if (this.nodes.get(f.id) === n) this.nodes.delete(f.id); });
        this.nodes.set(f.id, n);
        node = n;
      }
      try { stream = await node.promise; }
      catch (e) { throw e instanceof FilterError ? e : new FilterError(`${def.name}: ${(e as Error)?.message ?? e}`, f.id); }
    }
    if (!stream) throw new Error("No active filters");
    return stream;
  }

  chainOutput(chainId: string): Promise<Stream> {
    const c = this.chains.get(chainId);
    if (!c) return Promise.reject(new Error("Linked chain not found"));
    return this.streamAt(chainId, c.filters.length - 1);
  }

  private indexFor(chain: ChainDoc, filterId: string | null | undefined, input: boolean): number {
    let idx = filterId ? chain.filters.findIndex((f) => f.id === filterId) : chain.filters.length - 1;
    if (idx < 0) idx = chain.filters.length - 1;
    if (input) {
      idx--;
      while (idx > 0 && (!chain.filters[idx].enabled || FILTERS[chain.filters[idx].type]?.kind === "writer")) idx--;
    }
    return idx;
  }

  async streamInfo(chainId: string, filterId: string | null, input = false) {
    const chain = this.chains.get(chainId);
    if (!chain) return null;
    const idx = this.indexFor(chain, filterId, input);
    if (idx < 0) return null;
    try { return (await this.streamAt(chainId, idx)).info; } catch { return null; }
  }

  // ------------------------------------------------------------ rendering
  /** Start the kernel workers ahead of time when the project has work for them (idempotent). */
  private maybePrewarm(delay: number) {
    const needs = [...this.chains.values()].some((c) => c.filters.some((f) => f.enabled && (POOLED_FILTERS.has(f.type) || (f.type === "video_loader" && laneCount() >= 3))));
    if (needs) setTimeout(() => prewarmPool(), delay);
  }

  async render(req: RenderRequest): Promise<RenderResult> {
    try { return await this.renderInner(req); }
    finally {
      for (const t of this.nodeTasks) this.progress(t, "", 1, true);
      this.nodeTasks.clear();
      if (req.prefetch?.length) this.schedulePrefetch(req);
    }
  }

  /**
   * Playback read-ahead: compute the frames the player will ask for next in a later task (after the reply to
   * this render has been posted), so processing of frame n+1 overlaps the drawing of frame n. The frame cache
   * de-duplicates: a render request arriving meanwhile joins the running computation instead of repeating it.
   * Results are the same frames a normal render computes; only the timing changes.
   */
  private schedulePrefetch(req: RenderRequest) {
    const token = this.tokens.get(req.channel);
    setTimeout(async () => {
      if (this.tokens.get(req.channel) !== token) return; // a newer request on this channel: the guess is stale
      const chain = this.chains.get(req.chainId);
      if (!chain) return;
      const idx = this.indexFor(chain, req.filterId ?? null, !!req.input);
      if (idx < 0) return;
      try {
        const stream = await this.streamAt(req.chainId, idx);
        const n = stream.info.frameCount;
        for (const f of req.prefetch!.slice(0, 2)) {
          if (f < 0 || f >= n || this.tokens.get(req.channel) !== token) continue;
          await stream.getFrame(f);
        }
      } catch { /* a failing frame is reported when it is actually requested */ }
    }, 0);
  }

  private async renderInner(req: RenderRequest): Promise<RenderResult> {
    const token = (this.tokens.get(req.channel) ?? 0) + 1;
    this.tokens.set(req.channel, token);
    const stale = () => this.tokens.get(req.channel) !== token;
    const chain = this.chains.get(req.chainId);
    if (!chain) return { ok: false, error: "Chain not found" };
    const idx = this.indexFor(chain, req.filterId, !!req.input);
    if (idx < 0) return { ok: false, error: "No input: this is the first filter of the chain" };
    try {
      const stream = await this.streamAt(req.chainId, idx);
      if (stale()) return { ok: false, superseded: true, error: "" };
      const n = stream.info.frameCount;
      const fi = Math.max(0, Math.min(n - 1, req.frame | 0));
      const t0 = performance.now();
      const frame = await stream.getFrame(fi);
      const ms = performance.now() - t0;
      if (stale()) return { ok: false, superseded: true, error: "" };
      // 8-bit display copy and, when asked, its histogram in the same pass (WebAssembly SIMD when available)
      const rgba = new Uint8ClampedArray(frame.d.length);
      const H = convertToU8(frame.d, rgba, !!req.want?.hist);
      const out: RenderResult = { ok: true, frame: fi, width: frame.w, height: frame.h, rgba, info: { ...stream.info, width: frame.w, height: frame.h }, meta: stream.meta(fi), ms };
      if (H) {
        const { hist, low, high } = H;
        const total = frame.w * frame.h;
        out.hist = hist;
        out.saturated = { low, high };
        out.stats = [0, 1, 2, 3].map((c) => {
          let mn = 255, mx = 0, s = 0, s2 = 0;
          for (let v = 0; v < 256; v++) { const k = hist[c * 256 + v]; if (!k) continue; if (v < mn) mn = v; if (v > mx) mx = v; s += v * k; s2 += v * v * k; }
          const mean = s / total;
          return { min: mn, max: mx, mean, std: Math.sqrt(Math.max(0, s2 / total - mean * mean)) };
        });
      }
      if (req.want?.hash) {
        const n2 = frame.w * frame.h;
        const rgb = new Uint8Array(n2 * 3), R = new Uint8Array(n2), G = new Uint8Array(n2), B = new Uint8Array(n2);
        for (let i = 0, k = 0; i < n2; i++, k += 4) { rgb[i * 3] = R[i] = rgba[k]; rgb[i * 3 + 1] = G[i] = rgba[k + 1]; rgb[i * 3 + 2] = B[i] = rgba[k + 2]; }
        out.md5 = md5(rgb);
        out.chMd5 = [md5(R), md5(G), md5(B)];
      }
      return out;
    } catch (e) {
      if (stale()) return { ok: false, superseded: true, error: "" };
      return { ok: false, error: (e as Error)?.message ?? String(e), filterId: e instanceof FilterError ? e.filterId : undefined };
    }
  }

  /** A copy of the float frame a filter receives (the WebGPU preview applies the filter to it). */
  async inputFrame(req: { chainId: string; filterId: string; frame: number }) {
    const chain = this.chains.get(req.chainId);
    if (!chain) return { ok: false };
    const idx = this.indexFor(chain, req.filterId, true);
    if (idx < 0) return { ok: false };
    try {
      const s = await this.streamAt(req.chainId, idx);
      const f = await s.getFrame(Math.max(0, Math.min(s.info.frameCount - 1, req.frame | 0)));
      return { ok: true, w: f.w, h: f.h, floats: f.d.slice() };
    } catch (e) { return { ok: false, error: (e as Error)?.message ?? String(e) }; }
  }

  /** Statistics of the input of a filter (used by "Auto Levels"). */
  async inputStats(chainId: string, filterId: string, frame: number) {
    const chain = this.chains.get(chainId);
    if (!chain) return null;
    const idx = this.indexFor(chain, filterId, true);
    if (idx < 0) return null;
    const s = await this.streamAt(chainId, idx);
    const f = await s.getFrame(frame);
    const hist = new Uint32Array(256);
    for (let i = 0; i < f.d.length; i += 4) hist[Math.max(0, Math.min(255, Math.round(0.299 * f.d[i] + 0.587 * f.d[i + 1] + 0.114 * f.d[i + 2])))]++;
    return { hist, total: f.w * f.h };
  }

  /** Thumbnail of a filter output (for reports). */
  async snapshot(chainId: string, filterId: string | null, frame: number, maxSize: number, input = false): Promise<{ w: number; h: number; rgba: Uint8ClampedArray } | null> {
    const chain = this.chains.get(chainId);
    if (!chain) return null;
    const idx = this.indexFor(chain, filterId, input);
    if (idx < 0) return null;
    try {
      const s = await this.streamAt(chainId, idx);
      const f = await s.getFrame(Math.min(s.info.frameCount - 1, frame));
      // maxSize <= 0: the full frame, pixel for pixel (lossless reports)
      const k = maxSize > 0 ? Math.min(1, maxSize / Math.max(f.w, f.h)) : 1;
      const w = Math.max(1, Math.round(f.w * k)), h = Math.max(1, Math.round(f.h * k));
      return { w, h, rgba: toRGBA8(k < 1 ? resize(f, w, h, "bilinear") : f) };
    } catch { return null; }
  }

  /** MD5 of every output frame of a chain (integrity listing). */
  async hashFrames(chainId: string, taskId: string): Promise<string[]> {
    const s = await this.chainOutput(chainId);
    const out: string[] = [];
    for (let i = 0; i < s.info.frameCount; i++) {
      if (this.cancelled.has(taskId)) throw new Error("Cancelled");
      const rgba = toRGBA8(await s.getFrame(i));
      const h = new MD5();
      const rgb = new Uint8Array((rgba.length / 4) * 3);
      for (let p = 0, k = 0; k < rgba.length; k += 4) { rgb[p++] = rgba[k]; rgb[p++] = rgba[k + 1]; rgb[p++] = rgba[k + 2]; }
      out.push(h.update(rgb).digest());
      this.progress(taskId, "Hashing frames", (i + 1) / s.info.frameCount);
    }
    this.progress(taskId, "", 1, true);
    return out;
  }

  // ------------------------------------------------------------ writing
  async write(req: WriteRequest): Promise<WriteResult> {
    const chain = this.chains.get(req.chainId);
    if (!chain) throw new Error("Chain not found");
    const idx = this.indexFor(chain, req.filterId, false);
    const s = await this.streamAt(req.chainId, idx);
    try {
      return await writeStream(s, req, (phase, v) => this.progress(req.taskId, `${phase} ${req.handle?.name ?? req.name}`, v), () => this.cancelled.has(req.taskId));
    } finally {
      this.progress(req.taskId, "", 1, true);
      this.cancelled.delete(req.taskId);
    }
  }

  cancel(taskId: string) { this.cancelled.add(taskId); }

  // ------------------------------------------------------------ staging files (browser storage, on disk)
  private staged = new Map<string, StagedFile>();
  stageProbe() { return probeStaging(); }
  /** Opens a staging file that the page writes piece by piece (live recordings, RemoteSink). */
  async stageOpen(entry: string) {
    const st = await openStaged(entry);
    this.staged.set(entry, st);
    return { api: st.api };
  }
  async stageWrite(entry: string, at: number, data: Uint8Array) {
    const st = this.staged.get(entry);
    if (!st) throw new Error("The staging file is not open");
    await st.sink.writeAt(at, data);
  }
  async stageClose(entry: string): Promise<File> {
    const st = this.staged.get(entry);
    if (!st) throw new Error("The staging file is not open");
    this.staged.delete(entry);
    await st.sink.close("");
    return st.handle.getFile();
  }
  async stageAbort(entry: string) {
    const st = this.staged.get(entry);
    this.staged.delete(entry);
    if (st) await st.sink.abort();
    await removeStaged([entry]);
  }
  stageRemove(entries: string[]) { return removeStaged(entries.filter((e) => !this.staged.has(e))); }

  // ------------------------------------------------------------ misc
  /** Whether pixels read back from canvases and VideoFrames are exact here (fingerprinting protections). */
  async pixelCheck() { return { canvas: await canvasReadbackExact(), videoFrame: await videoFrameReadbackExact() }; }
  clearCache() { this.cache.clear(); this.nodes.clear(); this.keyMemo.clear(); }
  setCacheLimit(mb: number) { this.cache.setLimit(Math.max(64, mb) * 1024 * 1024); }
  /** Processing threads of the multi-core pool (0 = automatic). Results do not depend on it. */
  setThreads(n: number) { setThreads(n); this.maybePrewarm(0); return poolInfo(); }
  stats() { return { cacheBytes: this.cache.bytes, cacheEntries: this.cache.size, cacheLimit: this.cache.limit, hits: this.cache.hits, misses: this.cache.misses, sources: this.sources.size, wasm: wasmActive(), pool: poolInfo() }; }

  private progress(taskId: string, label: string, value: number, done = false) {
    const now = performance.now();
    if (!done && value < 1 && now - this.lastProgress < 80) return;
    this.lastProgress = now;
    this.emit("progress", { taskId, label, value, done });
  }
}
