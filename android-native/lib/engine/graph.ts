// The processing graph of the native workbench: chains of filters, lazy evaluation with a bounded
// cache, progress and cancellation.
//
// The browser reference runs the graph in a Web Worker; the native app runs it on the device (the
// filters are the same functions, so the results are the same). Intermediate frames are cached with a
// byte budget, so scrubbing a timeline does not decode the same frame again and again.
import { FILTER_LIST, FILTERS, normalizeParams, type FilterDef } from "../shared/filters";
import type { ChainDoc, FilterInstance, FrameMeta, ParamValues, StreamInfo } from "../shared/types";
import { FILTERS_IMPL } from "./filters/registry";
import type { Frame } from "./frame";
import type { SourceProvider } from "./sources/types";
import { mapStream, needInput, type BuildCtx, type FilterImpl, type Stream } from "./stream";

/** Placeholder definition for a filter the catalog does not know (its parameters are kept as they are). */
const EMPTY_DEF = { id: "unknown", name: "Unknown filter", category: "Edit", kind: "filter", description: "", params: [] } as unknown as FilterDef;

export interface GraphOptions {
  /** Progress of the running job (label and 0..1). */
  onProgress?: (label: string, value: number) => void;
  /** True when the job was cancelled; the filters check it while they work. */
  isCancelled?: () => boolean;
}

/** Byte-bounded cache of decoded frames. */
class FrameCache {
  private map = new Map<string, Frame>();
  private bytes = 0;
  constructor(private limit = 96 * 1024 * 1024) {}
  get(key: string): Frame | undefined {
    const f = this.map.get(key);
    if (f) { this.map.delete(key); this.map.set(key, f); }
    return f;
  }
  set(key: string, f: Frame) {
    if (this.map.has(key)) return;
    this.map.set(key, f);
    this.bytes += f.d.byteLength;
    while (this.bytes > this.limit && this.map.size > 1) {
      const first = this.map.keys().next().value as string;
      const v = this.map.get(first)!;
      this.bytes -= v.d.byteLength;
      this.map.delete(first);
    }
  }
  clear() { this.map.clear(); this.bytes = 0; }
}

export interface RenderedFrame {
  frame: Frame;
  info: StreamInfo;
  meta: FrameMeta;
  /** Filters that ran for this frame (for the provenance report). */
  applied: string[];
}

export class Workbench {
  private sources = new Map<string, SourceProvider>();
  private chains = new Map<string, ChainDoc>();
  private generation = new Map<string, number>();
  private cache = new FrameCache();
  private streams = new Map<string, { gen: number; stream: Stream }>();
  private building = new Map<string, Promise<Stream>>();

  constructor(private options: GraphOptions = {}) {}

  setOptions(o: GraphOptions) { this.options = { ...this.options, ...o }; }

  addSource(id: string, provider: SourceProvider) { this.sources.set(id, provider); }
  getSource(id: string) { return this.sources.get(id); }
  removeSource(id: string) { this.sources.delete(id); this.cache.clear(); }

  setChain(chain: ChainDoc) {
    this.chains.set(chain.id, chain);
    this.generation.set(chain.id, (this.generation.get(chain.id) ?? 0) + 1);
    this.streams.delete(chain.id);
  }
  removeChain(id: string) {
    this.chains.delete(id);
    this.streams.delete(id);
    this.generation.delete(id);
  }
  getChain(id: string) { return this.chains.get(id); }
  chainName(id: string) { return this.chains.get(id)?.name ?? "?"; }

  /** Drops the cached frames (after a parameter change). */
  invalidate(chainId?: string) {
    this.cache.clear();
    if (chainId) this.streams.delete(chainId);
  }

  private gen(chainId: string) { return this.generation.get(chainId) ?? 0; }

  /** Builds (or reuses) the output stream of a chain. */
  async stream(chainId: string): Promise<Stream> {
    const chain = this.chains.get(chainId);
    if (!chain) throw new Error(`The chain "${chainId}" does not exist`);
    const gen = this.gen(chainId);
    const cached = this.streams.get(chainId);
    if (cached && cached.gen === gen) return cached.stream;
    const pending = this.building.get(chainId);
    if (pending) return pending;
    const p = this.build(chain).then((s) => {
      this.streams.set(chainId, { gen: this.gen(chainId), stream: s });
      this.building.delete(chainId);
      return s;
    }).catch((e) => { this.building.delete(chainId); throw e; });
    this.building.set(chainId, p);
    return p;
  }

  private async build(chain: ChainDoc): Promise<Stream> {
    let input: Stream | null = null;
    const applied: string[] = [];
    for (const f of chain.filters) {
      if (!f.enabled) continue;
      const def: FilterDef | undefined = FILTERS[f.type];
      const impl: FilterImpl | undefined = FILTERS_IMPL[f.type];
      if (!impl) throw new Error(`The filter "${f.type}" is not available in this version of the app`);
      const params = normalizeParams(def ?? EMPTY_DEF, f.params ?? {});
      const ctx = this.context(chain, f, applied);
      try {
        input = await impl(input, params, ctx);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(`${def?.name ?? f.type}: ${message}`);
      }
      applied.push(f.type);
    }
    if (!input) throw new Error("The chain has no filter that produces an image: add a loader first.");
    const out = input;
    const gen = this.gen(chain.id);
    const prefix = `${chain.id}/${gen}`;
    return {
      info: out.info,
      meta: (i) => out.meta(i),
      getFrame: async (i) => {
        const key = `${prefix}/out/${i}`;
        const hit = this.cache.get(key);
        if (hit) return hit;
        const f = await out.getFrame(i);
        this.cache.set(key, f);
        return f;
      },
    };
  }

  private context(chain: ChainDoc, filter: FilterInstance, applied: string[]): BuildCtx {
    const gen = this.gen(chain.id);
    const prefix = `${chain.id}/${gen}/${filter.id}`;
    return {
      chainId: chain.id,
      filterId: filter.id,
      key: prefix,
      source: (id) => {
        const s = this.sources.get(id);
        if (!s) throw new Error(`The source "${id}" is not available`);
        return s;
      },
      mediaSource: async (id) => {
        const s = this.sources.get(id);
        if (!s) throw new Error(`The source "${id}" is not available`);
        return s;
      },
      chainStream: async (id) => {
        if (id === chain.id) return this.stream(chain.id);
        return this.stream(id);
      },
      chainName: (id) => this.chainName(id),
      originalStream: async () => {
        // the output of the first filter of the chain (the source of the evidence)
        const first = chain.filters[0];
        if (!first) throw new Error("The chain has no source");
        return this.chainOutput(chain.id, first.id);
      },
      sourceOfChain: () => {
        const sid = chain.filters[0]?.params?.source;
        return sid ? this.sources.get(sid) ?? null : null;
      },
      progress: (label, value) => this.options.onProgress?.(label, Math.max(0, Math.min(1, value))),
      isStale: () => this.options.isCancelled?.() ?? false,
    };
  }

  /** The output of one filter of a chain (used to show the input of a filter while editing it). */
  async chainOutput(chainId: string, filterId: string): Promise<Stream> {
    const chain = this.chains.get(chainId);
    if (!chain) throw new Error(`The chain "${chainId}" does not exist`);
    const gen = this.gen(chainId);
    const key = `${chainId}/${gen}/${filterId}/out`;
    const cached = this.streams.get(key);
    if (cached && cached.gen === gen) return cached.stream;
    let input: Stream | null = null;
    for (const f of chain.filters) {
      const impl = FILTERS_IMPL[f.type];
      if (!impl) continue;
      const def = FILTERS[f.type];
      const params = normalizeParams(def ?? EMPTY_DEF, f.params ?? {});
      input = await impl(input, params, this.context(chain, f, []));
      if (f.id === filterId) break;
    }
    if (!input) throw new Error("The filter has no input yet");
    this.streams.set(key, { gen, stream: input });
    return input;
  }

  /** Renders one frame of a chain (through the cache). */
  async render(chainId: string, frame: number, filterId?: string | null, input = false): Promise<RenderedFrame> {
    const chain = this.chains.get(chainId);
    if (!chain) throw new Error(`The chain "${chainId}" does not exist`);
    const stream = filterId ? await this.chainOutput(chainId, filterId) : await this.stream(chainId);
    const applied = chain.filters.filter((f: FilterInstance) => f.enabled).map((f: FilterInstance) => f.type);
    const f = await stream.getFrame(frame);
    return { frame: f, info: stream.info, meta: stream.meta(frame), applied };
  }
}

/** Filter definitions of the catalog that have an implementation in this build. */
export function implementedFilters(): FilterDef[] {
  return FILTER_LIST.filter((f: FilterDef) => !!FILTERS_IMPL[f.id]);
}

/** Human readable parameter value (the report and the history use it). */
export { formatParam } from "../shared/filters";
export { mapStream, needInput };
export type { ParamValues };
