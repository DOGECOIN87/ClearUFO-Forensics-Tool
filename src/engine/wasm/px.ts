// Display conversion (float frame -> 8-bit RGBA) and its histogram on WebAssembly SIMD.
// The WebAssembly kernels (px.wat) reproduce the JavaScript reference implementations below bit for bit;
// the references stay the fallback for browsers without WebAssembly SIMD (Safari < 16.4, old engines)
// and are what tests/unit/wasm.test.ts compares against. Speed changes, results never do.
import { PX_WASM } from "./pxBinary";

const CHUNK = 65536;            // samples per pass (input 256 KiB, stays in L2 cache)
const OUT = CHUNK * 4;          // byte offset of the 8-bit output chunk
const HIST = OUT + CHUNK;       // byte offset of the histogram counters

interface Kernels {
  f32ToU8(s: number, d: number, n: number): void;
  histU8(p: number, n: number, h: number): void;
  f32: Float32Array;
  u8: Uint8ClampedArray;
  h32: Uint32Array;
}

let kernels: Kernels | null | undefined;
let disabled = false;

function load(): Kernels | null {
  if (kernels !== undefined) return kernels;
  kernels = null;
  try {
    if (typeof WebAssembly !== "object" || typeof atob !== "function") return null;
    const bin = atob(PX_WASM);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!WebAssembly.validate(bytes)) return null; // engine without SIMD
    // small module: synchronous compilation is allowed on the main thread too (engine-in-page fallback)
    const e = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports as Record<string, unknown>;
    const mem = e.mem as WebAssembly.Memory; // fixed size, never grows: the views below stay valid
    kernels = {
      f32ToU8: e.f32_to_u8 as Kernels["f32ToU8"], histU8: e.hist_u8 as Kernels["histU8"],
      f32: new Float32Array(mem.buffer, 0, CHUNK), u8: new Uint8ClampedArray(mem.buffer, OUT, CHUNK), h32: new Uint32Array(mem.buffer, HIST, 1026),
    };
  } catch { kernels = null; }
  return kernels;
}

/** Switch the WebAssembly path off (or back on): tests and diagnostics. */
export function setWasmEnabled(on: boolean) { disabled = !on; }
/** Whether conversions currently run on WebAssembly SIMD. */
export function wasmActive(): boolean { return !disabled && !!load(); }

export interface DisplayHist { hist: Uint32Array; low: number; high: number }

/** Reference conversion: a Uint8ClampedArray store per sample (ToUint8Clamp: round half to even, clamp, NaN -> 0). */
export function toU8Reference(d: Float32Array, o: Uint8ClampedArray) {
  for (let i = 0; i < d.length; i++) o[i] = d[i];
}

/** Reference histogram of 8-bit RGBA: R, G, B, integer BT.601 luma (5 x 256 counters, the 5th unused) and saturation counts. */
export function histReference(rgba: Uint8ClampedArray): DisplayHist {
  const hist = new Uint32Array(5 * 256);
  let low = 0, high = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    hist[r]++; hist[256 + g]++; hist[512 + b]++;
    hist[768 + ((r * 299 + g * 587 + b * 114 + 500) / 1000 | 0)]++;
    if (r === 255 || g === 255 || b === 255) high++;
    if (r === 0 || g === 0 || b === 0) low++;
  }
  return { hist, low, high };
}

/**
 * Convert float samples to 8 bits into `o` (same length). With `wantHist` the display histogram is
 * accumulated in the same pass, while each chunk is still in cache. `d.length` must be a multiple of 4 (RGBA).
 */
export function convertToU8(d: Float32Array, o: Uint8ClampedArray, wantHist: boolean): DisplayHist | null {
  const k = disabled ? null : load();
  if (!k) {
    toU8Reference(d, o);
    return wantHist ? histReference(o) : null;
  }
  if (wantHist) k.h32.fill(0);
  const n = d.length;
  for (let s = 0; s < n; s += CHUNK) {
    const m = Math.min(CHUNK, n - s);
    k.f32.set(d.subarray(s, s + m));
    k.f32ToU8(0, OUT, m);
    if (wantHist) k.histU8(OUT, m >> 2, HIST);
    o.set(m === CHUNK ? k.u8 : k.u8.subarray(0, m), s);
  }
  if (!wantHist) return null;
  const hist = new Uint32Array(5 * 256);
  hist.set(k.h32.subarray(0, 1024));
  return { hist, low: k.h32[1024], high: k.h32[1025] };
}
