// Multi-core processing: a pool of kernel workers for the heavy filters.
//
// Kernel workers run this same engine script; the worker name selects the role (worker.ts). They execute
// registered kernels: pure functions from typed arrays to typed arrays. Work is split only where every output
// value is computed by the same code from the same inputs as in a single thread (row bands that carry the
// rows a kernel reads, independent channels, independent search positions). So results never depend on the
// number of threads, the machine or the scheduling: tests/perf.test.ts and the filter hash suite check this.
//
// Data moves by message: each job gets a copy of the rows it needs, results are transferred back (no copy).
// That works everywhere (file://, embedded previews, no cross-origin isolation needed), so it is used only for
// kernels whose computation clearly outweighs the copying.

import { autoThreads, MAX_THREADS } from "../shared/threads";

export const KERNEL_WORKER_NAME = "LUCID kernels";
export { MAX_THREADS };

type KernelFn = (args: any) => unknown;
const kernels = new Map<string, KernelFn>();

/** Register a kernel (at module top level, so kernel workers, which load the same script, know it too). */
export function defineKernel<A, R>(name: string, fn: (args: A) => R): (args: A) => R {
  kernels.set(name, fn as KernelFn);
  return fn;
}

/** The ArrayBuffers of the typed arrays in a (plain) result: transferred instead of cloned. */
function buffersOf(v: unknown, out = new Set<ArrayBuffer>()): ArrayBuffer[] {
  if (v && typeof v === "object") {
    if (ArrayBuffer.isView(v)) { if (v.buffer instanceof ArrayBuffer) out.add(v.buffer); }
    else if (Array.isArray(v)) for (const x of v) buffersOf(x, out);
    else for (const x of Object.values(v as object)) buffersOf(x, out);
  }
  return [...out];
}

interface Port { postMessage(m: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null }

/**
 * Kernel worker side: run kernels on request, on the worker's own port (started by the engine) or on a
 * MessagePort the page hands over (`{ connect }`: pages opened from disk, where workers cannot start workers).
 */
export function serveKernels(port: Port) {
  const serve = (p: Port) => {
    p.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m?.connect) { serve(m.connect as Port); return; }
      if (m?.close) { (globalThis as { close?: () => void }).close?.(); return; }
      const { id, name, args } = m;
      try {
        const fn = kernels.get(name);
        if (!fn) throw new Error(`Unknown kernel ${name}`);
        const out = fn(args);
        p.postMessage({ id, ok: true, out }, buffersOf(out));
      } catch (err) {
        p.postMessage({ id, ok: false, error: (err as Error)?.message ?? String(err) });
      }
    };
    p.postMessage({ ready: true });
  };
  serve(port);
}

/** Endpoint of a kernel worker: the Worker itself, or a MessagePort connected to one the page started. */
type Endpoint = { postMessage(m: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null; terminate?: () => void; close?: () => void; onerror?: ((e: Event) => void) | null };

let portSpawner: (() => Promise<MessagePort>) | null = null;
/** How to get a kernel worker when this thread cannot start one (the engine asks the page; see rpc.ts). */
export function setPortSpawner(fn: (() => Promise<MessagePort>) | null) { portSpawner = fn; }

// ---------------------------------------------------------------- coordinator side
const WorkerScope = (globalThis as { WorkerGlobalScope?: new () => unknown }).WorkerGlobalScope;
/** True in a worker: this thread then takes jobs too (it would only wait otherwise). In the page it never does. */
const inWorker = !!WorkerScope && self instanceof WorkerScope;

let threadsSetting = 0; // 0: automatic
let forcedBands = 0;    // tests: split into bands even without workers (exercises the band code paths)

/** Threads one heavy filter runs on: automatic = logical CPUs minus one for the interface (2 on dual-core). */
export function threadCount(): number {
  if (threadsSetting > 0) return Math.min(MAX_THREADS, threadsSetting);
  return autoThreads();
}

/** Processing threads: 0 = automatic, 1 = single thread (no kernel workers), n = up to n threads. */
export function setThreads(n: number) {
  threadsSetting = Math.max(0, Math.min(MAX_THREADS, Math.floor(n) || 0));
  current?.trim(helperBudget());
}

/** Tests: always split work into `n` bands (run in this thread when no workers exist). 0 = off. */
export function forceBands(n: number) { forcedBands = Math.max(0, n | 0); }
export const forcedBandCount = () => forcedBands;

/**
 * Whether this thread computes bands itself. With up to 3 threads it does (one core is too much to leave idle);
 * with more it only hands out jobs, so a helper that finishes never waits for this thread to finish a band.
 */
const workHere = () => inWorker && threadCount() <= 3;

/**
 * Threads computing in parallel: the thread count either way. With up to 3 threads in a worker, this thread is one
 * of them (helpers = threads − 1); otherwise (more threads, or the engine in the page) helpers = threads.
 */
export function laneCount(): number { return Math.max(1, threadCount()); }

/** How many bands to cut work into: a few per lane, so faster lanes take more of them. */
export function bandCount(): number {
  if (forcedBands) return forcedBands;
  const t = laneCount();
  return t > 1 ? t * 3 : 1;
}

/** Whether splitting pays off: more than one thread and enough work (`work`: rough count of inner operations). */
export function parallelWorthIt(work: number): boolean {
  if (forcedBands) return true;
  return threadCount() > 1 && work >= 4e6 && (inWorker || canSpawn());
}

const helperBudget = () => Math.max(0, threadCount() - (workHere() ? 1 : 0));

class KernelError extends Error {}

interface Helper {
  w: Endpoint | null;
  ready: Promise<boolean>;
  /** Set when the worker has loaded (lets a call hand it a job synchronously, before this thread starts one). */
  isReady: boolean;
  calls: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  busy: boolean;
}

/** Script the kernel workers run: the engine's own script (a blob: or data: URL), or the one the page passes. */
function scriptUrl(): string | null {
  const given = (globalThis as { __lucidKernelUrl?: string }).__lucidKernelUrl;
  if (typeof given === "string" && given) return given;
  if (inWorker) { try { return String((self as unknown as { location: Location }).location.href); } catch { return null; } }
  return null;
}

function canSpawn(): boolean { return typeof Worker !== "undefined" && !!scriptUrl() && !(current?.broken ?? false); }

const yieldTask = () => new Promise<void>((resolve) => {
  if (typeof MessageChannel === "undefined") { setTimeout(resolve, 0); return; }
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
  ch.port2.postMessage(0);
});

export interface Job { args: unknown; transfer?: Transferable[] }

class Pool {
  helpers: Helper[] = [];
  broken = false;
  private seq = 0;
  private started = 0;
  private failed = 0;
  private jobsHere = 0;
  private jobsHelpers = 0;

  /** Workers cannot start workers here (pages opened from disk): kernel workers come from the page instead. */
  private nestedBlocked = false;

  private spawn(): Helper | null {
    const url = scriptUrl();
    if (this.broken || !url || typeof Worker === "undefined") return null;
    let w: Endpoint | null = null;
    if (!this.nestedBlocked) {
      try { w = new Worker(url, { name: KERNEL_WORKER_NAME }) as unknown as Endpoint; }
      catch { this.nestedBlocked = true; }
    }
    if (!w && !portSpawner) { this.broken = true; return null; }
    let ready!: (ok: boolean) => void;
    const h: Helper = { w: null, calls: new Map(), busy: false, isReady: false, ready: new Promise<boolean>((r) => { ready = r; }) };
    const timer = setTimeout(() => ready(false), 20000);
    const attach = (ep: Endpoint) => {
      h.w = ep;
      ep.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (m?.ready) { clearTimeout(timer); h.isReady = true; ready(true); return; }
        const c = h.calls.get(m.id);
        if (!c) return;
        h.calls.delete(m.id);
        if (m.ok) c.resolve(m.out); else c.reject(new KernelError(m.error));
      };
      if ("onerror" in ep) ep.onerror = (e: Event) => { e.preventDefault?.(); clearTimeout(timer); ready(false); this.retire(h); };
    };
    if (w) attach(w);
    else portSpawner!().then(attach, () => { clearTimeout(timer); ready(false); });
    this.helpers.push(h);
    this.started++;
    void h.ready.then((ok) => { if (!ok) { this.failed++; this.retire(h); if (!this.helpers.length && this.failed >= 2) this.broken = true; } });
    return h;
  }

  private retire(h: Helper) {
    const i = this.helpers.indexOf(h);
    if (i >= 0) this.helpers.splice(i, 1);
    try {
      if (h.w?.terminate) h.w.terminate();
      else if (h.w) { h.w.postMessage({ close: true }); h.w.close?.(); }
    } catch { /* already gone */ }
    for (const c of h.calls.values()) c.reject(new Error("A processing thread stopped (out of memory?)"));
    h.calls.clear();
  }

  /** Stop helpers beyond the budget (idle ones only; busy ones finish their job first). */
  trim(budget: number) {
    for (const h of [...this.helpers]) if (this.helpers.length > budget && !h.busy) this.retire(h);
  }

  /** Idle helpers for one call, spawning up to the budget; never waits for helpers busy with another call. */
  private take(max: number): Helper[] {
    const got: Helper[] = [];
    for (const h of this.helpers) if (got.length < max && !h.busy) { h.busy = true; got.push(h); }
    while (got.length < max && this.helpers.length < helperBudget()) {
      const h = this.spawn();
      if (!h) break;
      h.busy = true;
      got.push(h);
    }
    return got;
  }

  private call(h: Helper, name: string, job: Job): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      h.calls.set(id, { resolve, reject });
      try { h.w!.postMessage({ id, name, args: job.args }, job.transfer ?? []); }
      catch (e) { h.calls.delete(id); reject(e as Error); }
    });
  }

  /**
   * Run `jobs` through kernel `name` and return the results in job order. Helpers that are ready take jobs one
   * at a time; in a worker this thread takes jobs too (yielding between them so finished helpers get new ones).
   * Results are exactly those of calling the kernel here, whichever thread ran each job.
   */
  async map<R>(name: string, jobs: Job[], isCancelled?: () => boolean): Promise<R[]> {
    const fn = kernels.get(name);
    if (!fn) throw new Error(`Unknown kernel ${name}`);
    const n = jobs.length, out = new Array<R>(n);
    let next = 0;
    let failure: Error | null = null;
    const local = workHere() || !canSpawn();
    const helpers = threadCount() > 1 ? this.take(Math.min(helperBudget(), n - (local ? 1 : 0))) : [];
    // Ready helpers get their first jobs right here, synchronously, before this thread starts working on one.
    // Each keeps a second job queued in its inbox: when it finishes one, the next is already there, even while
    // this thread is busy computing a band and cannot hand out work.
    const DEPTH = 2;
    const loops = helpers.map(async (h) => {
      try {
        if (!h.isReady && !(await h.ready)) return;
        const inflight: Promise<void>[] = [];
        const pump = () => {
          while (inflight.length < DEPTH && next < n && !failure) {
            if (isCancelled?.()) { failure = new Error("Cancelled"); break; }
            const i = next++;
            inflight.push(this.call(h, name, jobs[i]).then((r) => { out[i] = r as R; this.jobsHelpers++; }, (e) => { failure = e as Error; }));
          }
        };
        pump();
        while (inflight.length) { await inflight.shift(); pump(); }
      } finally { h.busy = false; }
    });
    if (local || !helpers.length) {
      while (next < n && !failure) {
        if (isCancelled?.()) { failure = new Error("Cancelled"); break; }
        const i = next++;
        out[i] = fn(jobs[i].args) as R;
        this.jobsHere++;
        if (next < n && helpers.length) await yieldTask();
      }
    }
    await Promise.all(loops);
    // helpers that never became ready leave jobs behind: do them here
    while (next < n && !failure) { const i = next++; out[i] = fn(jobs[i].args) as R; this.jobsHere++; }
    if (failure) throw failure;
    return out;
  }

  /** Start the helpers ahead of the first heavy filter (each loads the engine script once, then waits). */
  prewarm() { if (threadCount() > 1) this.trim(helperBudget()); while (threadCount() > 1 && this.helpers.length < helperBudget() && this.spawn()); }

  info() { return { threads: threadCount(), helpers: this.helpers.length, broken: this.broken, inWorker, started: this.started, failed: this.failed, jobsHere: this.jobsHere, jobsHelpers: this.jobsHelpers }; }
}

let current: Pool | null = null;

/** The engine's kernel pool (created on first use). */
export function pool(): Pool {
  if (!current) current = new Pool();
  return current;
}

/** Run jobs through a kernel: in parallel when worth it, else in order in this thread. Same results either way. */
export async function runJobs<R>(name: string, jobs: Job[], isCancelled?: () => boolean): Promise<R[]> {
  return pool().map<R>(name, jobs, isCancelled);
}

/** Start kernel workers in the background (no-op with one thread or when workers are unavailable). */
export function prewarmPool() { if (threadCount() > 1 && canSpawn()) pool().prewarm(); }

export function poolInfo() { return current ? current.info() : { threads: threadCount(), helpers: 0, broken: false, inWorker, started: 0, failed: 0, jobsHere: 0, jobsHelpers: 0 }; }

// ---------------------------------------------------------------- band helpers
/** Split [0, h) into about `parts` row bands of at least `minRows` rows. */
export function rowBands(h: number, parts: number, minRows = 8): [number, number][] {
  const n = Math.max(1, Math.min(parts, Math.floor(h / minRows) || 1));
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) out.push([Math.floor((k * h) / n), Math.floor(((k + 1) * h) / n)]);
  return out;
}

/** Rows [y0, y1) widened by `halo` rows on each side, clamped to the image. */
export const windowOf = (h: number, y0: number, y1: number, halo: number): [number, number] => [Math.max(0, y0 - halo), Math.min(h, y1 + halo)];
