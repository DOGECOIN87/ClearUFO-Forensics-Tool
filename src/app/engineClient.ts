// UI-thread client of the processing engine.
//
// The engine normally runs in a Web Worker. Safari does not let workers of pages opened from disk
// (file://) read any Blob — evidence files, encoder output, images — so when the worker reports that,
// the same engine code runs in the page instead, behind a MessageChannel with the identical protocol.
// Processing then shares the page's thread (the interface can pause during heavy filters).
import engineCode from "virtual:engine-code";
import type { ProgressEvent, SourceInfo } from "../shared/types";
import { Emitter } from "../ui/dom";

type Events = { progress: [ProgressEvent]; source: [SourceInfo]; ready: []; crash: [string]; mode: ["worker" | "page"] };
interface Port { postMessage(m: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null }

function startWorker(): { port: Worker; url: string | null } {
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([engineCode], { type: "text/javascript" }));
    return { port: new Worker(url, { name: "LUCID engine" }), url };
  } catch {
    if (url) URL.revokeObjectURL(url);
    return { port: new Worker(`data:text/javascript;charset=utf-8,${encodeURIComponent(engineCode)}`, { name: "LUCID engine" }), url: null };
  }
}

/**
 * Runs the engine script in this page. Its `self` and `globalThis` are a scope whose postMessage/onmessage
 * are one end of a MessageChannel; everything else reads through to the window, except symbol-keyed
 * globals, which stay private (libraries mark themselves as loaded that way, e.g. Mediabunny, which the
 * page also uses for audio: the two copies must not see each other).
 */
function startInPage(): Port {
  const ch = new MessageChannel(), engineSide = ch.port2;
  const own = new Map<PropertyKey, unknown>();
  // the multi-core pool starts its kernel workers from the engine script (they only compute, no file access)
  let kernelUrl: string | null = null;
  try { kernelUrl = URL.createObjectURL(new Blob([engineCode], { type: "text/javascript" })); } catch { kernelUrl = null; }
  const scope = new Proxy(window as any, {
    get(w, k) {
      if (k === "__lucidKernelUrl") return kernelUrl;
      if (k === "postMessage") return (m: unknown, t?: Transferable[]) => engineSide.postMessage(m, t ?? []);
      if (k === "onmessage") return engineSide.onmessage;
      if (typeof k === "symbol") return own.get(k);
      const v = Reflect.get(w, k);
      // window functions need their receiver; constructors (OffscreenCanvas, ImageDecoder…) keep their statics
      return typeof v === "function" && !/^[A-Z]/.test(k) ? v.bind(w) : v;
    },
    set(w, k, v) {
      if (k === "onmessage") { engineSide.onmessage = v; return true; }
      if (typeof k === "symbol") { own.set(k, v); return true; }
      return Reflect.set(w, k, v);
    },
    has: (w, k) => (typeof k === "symbol" ? own.has(k) : Reflect.has(w, k)),
  });
  new Function("self", "globalThis", engineCode)(scope, scope);
  return ch.port1;
}

/** Tests and diagnostics can force the in-page engine with ?engine=page. */
const forcePage = () => { try { return new URLSearchParams(location.search).get("engine") === "page"; } catch { return false; } };

export class EngineClient extends Emitter<Events> {
  private port: Port;
  private workerUrl: string | null = null;
  private ready = false;
  private queue: { msg: { id: number; method: string; args: any[] }; transfer: Transferable[] }[] = [];
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private callHandlers: Record<string, (args: any) => Promise<{ result: any; transfer?: Transferable[] }>> = {};
  /** Where the engine runs: a background worker, or the page (Safari restriction on file:// pages). */
  mode: "worker" | "page" = "worker";

  constructor() {
    super();
    if (forcePage()) { this.port = this.attach(startInPage()); this.mode = "page"; return; }
    const w = startWorker();
    this.workerUrl = w.url;
    this.port = this.attach(w.port);
    // The engine's processing threads (multi-core pool), when its worker cannot start workers (pages opened from
    // disk): started here from the same script and connected to the engine by a MessagePort.
    this.handle("kernelPort", async () => {
      if (!this.workerUrl) throw new Error("No engine script for processing threads");
      const kw = new Worker(this.workerUrl, { name: "LUCID kernels" });
      const ch = new MessageChannel();
      kw.postMessage({ connect: ch.port2 }, [ch.port2]);
      return { result: ch.port1, transfer: [ch.port1] };
    });
    w.port.onerror = (e) => { console.error("Engine worker error", e); this.emit("crash", e.message || "Engine error"); };
  }

  private attach(p: Port): Port { p.onmessage = (e) => void this.onMessage(e.data); return p; }

  handle(method: string, fn: (args: any) => Promise<{ result: any; transfer?: Transferable[] }>) { this.callHandlers[method] = fn; }

  private onReady(blobs: boolean) {
    // The script URL stays valid while the engine runs in a worker: the engine starts its kernel workers
    // (multi-core pool) from it. It is released when the engine moves into the page.
    if (!blobs && this.mode === "worker") {
      if (this.workerUrl) { URL.revokeObjectURL(this.workerUrl); this.workerUrl = null; }
      // This worker cannot read files: move the engine into the page (the queued calls follow it).
      (this.port as Worker).terminate();
      this.mode = "page";
      this.port = this.attach(startInPage());
      this.emit("mode", "page");
      return;
    }
    this.ready = true;
    for (const q of this.queue.splice(0)) this.port.postMessage(q.msg, q.transfer);
    this.emit("ready");
  }

  private async onMessage(m: any) {
    if (m.event) {
      if (m.event === "progress") this.emit("progress", m.data);
      else if (m.event === "source") this.emit("source", m.data);
      else if (m.event === "ready") this.onReady(m.data?.blobs !== false);
      return;
    }
    if (m.call !== undefined) {
      try {
        const h = this.callHandlers[m.method];
        if (!h) throw new Error(`No handler for ${m.method}`);
        const { result, transfer } = await h(m.args);
        this.port.postMessage({ reply: m.call, ok: true, result }, transfer ?? []);
      } catch (err) {
        this.port.postMessage({ reply: m.call, ok: false, error: (err as Error)?.message ?? String(err) });
      }
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
  }

  call<T = any>(method: string, ...args: any[]): Promise<T> { return this.callTransfer<T>(method, args); }

  /** Like call(), moving the given buffers to the engine instead of copying them. */
  callTransfer<T = any>(method: string, args: any[], transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg = { id, method, args };
      if (this.ready) this.port.postMessage(msg, transfer);
      else this.queue.push({ msg, transfer });
    });
  }
}
