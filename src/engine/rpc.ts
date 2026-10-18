// The Engine behind a small RPC protocol on a message port: the global scope of a Web Worker, or one end
// of a MessageChannel when the engine runs in the page (see app/engineClient.ts).
import { Engine } from "./engine";
import { setPortSpawner } from "./pool";

export interface EnginePort {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
}

function transferables(v: any): Transferable[] {
  const out: Transferable[] = [];
  if (!v || typeof v !== "object") return out;
  if (v.rgba?.buffer instanceof ArrayBuffer) out.push(v.rgba.buffer);
  if (v.buffer instanceof ArrayBuffer) out.push(v.buffer);
  if (v.types?.buffer instanceof ArrayBuffer && v.bytes?.buffer instanceof ArrayBuffer && v.pts?.buffer instanceof ArrayBuffer) out.push(v.types.buffer, v.bytes.buffer, v.pts.buffer);
  if (v.hist?.buffer instanceof ArrayBuffer) out.push(v.hist.buffer);
  if (v.floats?.buffer instanceof ArrayBuffer) out.push(v.floats.buffer);
  return out;
}

/** Whether Blobs (evidence files, encoder output) can be read here: Safari forbids it in workers of file:// pages. */
async function canReadBlobs(): Promise<boolean> {
  try { return (await new Blob([new Uint8Array([7])]).arrayBuffer()).byteLength === 1; } catch { return false; }
}

export function serveEngine(ctx: EnginePort) {
  let callSeq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const callMain = (method: string, args: unknown): Promise<any> => {
    const call = ++callSeq;
    return new Promise((resolve, reject) => {
      pending.set(call, { resolve, reject });
      ctx.postMessage({ call, method, args });
    });
  };
  const engine = new Engine((event, data) => ctx.postMessage({ event, data }), callMain);
  // kernel workers from the page when this worker cannot start workers itself (pages opened from disk)
  setPortSpawner(() => callMain("kernelPort", {}));

  ctx.onmessage = async (e: MessageEvent) => {
    const m = e.data;
    if (m.reply !== undefined) {
      const p = pending.get(m.reply);
      if (p) { pending.delete(m.reply); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)); }
      return;
    }
    const { id, method, args } = m;
    try {
      const fn = (engine as any)[method];
      if (typeof fn !== "function") throw new Error(`Unknown engine method ${method}`);
      const result = await fn.apply(engine, args ?? []);
      ctx.postMessage({ id, ok: true, result }, transferables(result));
    } catch (err) {
      ctx.postMessage({ id, ok: false, error: (err as Error)?.message ?? String(err) });
    }
  };

  void canReadBlobs().then((blobs) => ctx.postMessage({ event: "ready", data: { blobs } }));
}
