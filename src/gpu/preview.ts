// WebGPU preview while a filter is being adjusted (display only).
//
// While a slider moves, the Viewer shows the selected filter applied on the GPU to the filter's input at once,
// and replaces it with the engine's exact result as soon as that arrives. Previews never reach exports,
// measurements, hashes or reports: GPU float arithmetic (32-bit, device-specific rounding) is not bit-reproducible
// across machines, so everything forensic stays on the exact CPU path. A badge marks the preview on screen.
import { toneLuts } from "../engine/filters/luts";

type P = Record<string, any>;

const TYPES = new Set(["levels", "curves", "brightness_contrast", "exposure", "negative", "threshold", "grayscale", "enable_channels",
  "color_switch", "white_balance", "hue_saturation", "gaussian_filter", "unsharp_mask", "high_pass_sharpening"]);

/** Filters (and parameter sets) the GPU preview can show. */
export function gpuSupports(type: string, p: P): boolean {
  if (!TYPES.has(type)) return false;
  if (type === "white_balance") return p.mode === "manual"; // the automatic modes measure the image first
  return true;
}

const LUT_N = 4096; // Lut default size (kernels/color.ts)
const MAX_RADIUS = 128;

const WGSL = /* wgsl */ `
struct U {
  w: u32, h: u32, op: u32, n: u32,
  a: f32, b: f32, c: f32, d: f32,
  e: vec4f,
  s: vec4u,
  r: i32, mode: u32, p0: u32, p1: u32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> lut: array<f32>;
@group(0) @binding(4) var<storage, read_write> tmp: array<vec4f>;
@group(0) @binding(5) var<storage, read> kern: array<f32>;

// 8-bit display value: clamp to 0..255, round half to even (the engine's Uint8ClampedArray conversion)
fn u8c(v: f32) -> u32 { if (!(v > 0.0)) { return 0u; } if (v >= 255.0) { return 255u; } return u32(round(v)); }
fn pack(c: vec4f) -> u32 { return u8c(c.x) | (u8c(c.y) << 8u) | (u8c(c.z) << 16u) | (u8c(c.w) << 24u); }

fn lutAt(ch: u32, v: f32) -> f32 {
  let n = u.n;
  let base = ch * (n + 1u);
  let x = clamp(v, 0.0, 255.0) * (f32(n) / 255.0);
  let i = u32(x);
  if (i >= n) { return lut[base + n]; }
  return lut[base + i] + (lut[base + i + 1u] - lut[base + i]) * (x - f32(i));
}

fn rgb2hsl(c0: vec3f) -> vec3f {
  let c = clamp(c0, vec3f(0.0), vec3f(255.0)) / 255.0;
  let mx = max(max(c.x, c.y), c.z); let mn = min(min(c.x, c.y), c.z);
  let l = (mx + mn) / 2.0; let d = mx - mn;
  var h = 0.0; var s = 0.0;
  if (d > 1e-9) {
    s = d / (1.0 - abs(2.0 * l - 1.0));
    if (mx == c.x) { h = ((c.y - c.z) / d) % 6.0; } else if (mx == c.y) { h = (c.z - c.x) / d + 2.0; } else { h = (c.x - c.y) / d + 4.0; }
    h = h * 60.0;
    if (h < 0.0) { h = h + 360.0; }
  }
  return vec3f(h, s, l);
}

fn hsv2rgb(h0: f32, s: f32, v: f32) -> vec3f {
  let h = ((h0 % 360.0) + 360.0) % 360.0;
  let c = v * s; let x = c * (1.0 - abs(((h / 60.0) % 2.0) - 1.0)); let m = v - c;
  var r = vec3f(c, 0.0, x);
  if (h < 60.0) { r = vec3f(c, x, 0.0); } else if (h < 120.0) { r = vec3f(x, c, 0.0); } else if (h < 180.0) { r = vec3f(0.0, c, x); }
  else if (h < 240.0) { r = vec3f(0.0, x, c); } else if (h < 300.0) { r = vec3f(x, 0.0, c); }
  return (r + vec3f(m)) * 255.0;
}

fn hsl2rgb(h: f32, s: f32, l: f32) -> vec3f {
  let c = (1.0 - abs(2.0 * l - 1.0)) * s;
  let v = l + c / 2.0;
  return hsv2rgb(h, select(0.0, c / v, v > 0.0), v);
}

fn pick(sel: u32, c: vec3f) -> f32 {
  switch sel { case 0u: { return c.x; } case 1u: { return c.y; } case 2u: { return c.z; } case 3u: { return 255.0; } default: { return 0.0; } }
}

@compute @workgroup_size(16, 16)
fn point(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= u.w || g.y >= u.h) { return; }
  let i = g.y * u.w + g.x;
  let c = src[i];
  var o = c;
  switch u.op {
    case 1u: { // tone curves (Levels, Curves, Brightness/Contrast, Exposure): the engine's lookup tables
      if (u.s.x == 1u) { o.x = lutAt(0u, c.x); }
      if (u.s.y == 1u) { o.y = lutAt(1u, c.y); }
      if (u.s.z == 1u) { o.z = lutAt(2u, c.z); }
    }
    case 2u: { o = vec4f(255.0 - c.x, 255.0 - c.y, 255.0 - c.z, c.w); }
    case 3u: {
      if (u.mode == 1u) { o = vec4f(select(0.0, 255.0, c.x >= u.a), select(0.0, 255.0, c.y >= u.a), select(0.0, 255.0, c.z >= u.a), c.w); }
      else { let v = select(0.0, 255.0, 0.299 * c.x + 0.587 * c.y + 0.114 * c.z >= u.a); o = vec4f(v, v, v, c.w); }
    }
    case 4u: {
      var v = u.e.x * c.x + u.e.y * c.y + u.e.z * c.z;
      if (u.mode == 1u) { v = (c.x + c.y + c.z) / 3.0; }
      else if (u.mode == 2u) { v = (max(max(c.x, c.y), c.z) + min(min(c.x, c.y), c.z)) / 2.0; }
      else if (u.mode == 3u) { v = max(max(c.x, c.y), c.z); }
      else if (u.mode == 4u) { v = min(min(c.x, c.y), c.z); }
      o = vec4f(v, v, v, c.w);
    }
    case 5u: { o = vec4f(c.x * u.e.x, c.y * u.e.y, c.z * u.e.z, c.w); }
    case 6u: { o = vec4f(pick(u.s.x, c.xyz), pick(u.s.y, c.xyz), pick(u.s.z, c.xyz), c.w); }
    case 7u: {
      var hsl = rgb2hsl(c.xyz);
      let h = hsl.x + u.a;
      let s = clamp(hsl.y * (1.0 + u.b / 100.0), 0.0, 1.0);
      let l = select(hsl.z * (1.0 + u.c / 100.0), hsl.z + (1.0 - hsl.z) * (u.c / 100.0), u.c >= 0.0);
      o = vec4f(hsl2rgb(h, s, l), c.w);
    }
    default: {}
  }
  dst[i] = pack(o);
}

@compute @workgroup_size(16, 16)
fn blurH(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= u.w || g.y >= u.h) { return; }
  var acc = vec4f(0.0);
  for (var k = -u.r; k <= u.r; k++) {
    let x = clamp(i32(g.x) + k, 0, i32(u.w) - 1);
    acc += src[g.y * u.w + u32(x)] * kern[u32(k + u.r)];
  }
  tmp[g.y * u.w + g.x] = acc;
}

@compute @workgroup_size(16, 16)
fn blurV(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= u.w || g.y >= u.h) { return; }
  var acc = vec4f(0.0);
  for (var k = -u.r; k <= u.r; k++) {
    let y = clamp(i32(g.y) + k, 0, i32(u.h) - 1);
    acc += tmp[u32(y) * u.w + g.x] * kern[u32(k + u.r)];
  }
  let i = g.y * u.w + g.x;
  let c = src[i];
  var o = vec4f(acc.xyz, c.w);                                     // Gaussian
  if (u.mode == 1u) {                                              // Unsharp Masking
    let diff = c.xyz - acc.xyz;
    o = vec4f(select(c.xyz, c.xyz + u.a * diff, abs(diff) >= vec3f(u.b)), c.w);
  } else if (u.mode == 2u) {                                       // High Pass Sharpening
    o = vec4f(c.xyz + u.a * (c.xyz - acc.xyz), c.w);
  }
  dst[i] = pack(o);
}
`;

/** Gaussian weights (the engine's gaussKernel; large sigmas, three box passes there, are a true Gaussian here). */
function gaussWeights(sigma: number): Float32Array {
  if (!(sigma > 0.05)) return new Float32Array([1]);
  const r = Math.min(MAX_RADIUS, Math.max(1, Math.ceil(sigma * 3)));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export class GpuPreview {
  private uni: any; private lut: any; private kern: any;
  private src: any = null; private tmp: any = null; private dst: any = null; private read: any = null; private bg: any = null;
  private pPoint: any; private pBlurH: any; private pBlurV: any; private layout: any;
  private w = 0; private h = 0;
  private key = "";
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private dev: any, readonly label: string, private maxBytes: number) {
    const G = (globalThis as any).GPUBufferUsage, S = (globalThis as any).GPUShaderStage;
    this.uni = dev.createBuffer({ size: 80, usage: G.UNIFORM | G.COPY_DST });
    this.lut = dev.createBuffer({ size: 3 * (LUT_N + 1) * 4, usage: G.STORAGE | G.COPY_DST });
    this.kern = dev.createBuffer({ size: (2 * MAX_RADIUS + 1) * 4, usage: G.STORAGE | G.COPY_DST });
    this.layout = dev.createBindGroupLayout({ entries: [
      { binding: 0, visibility: S.COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: S.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: S.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: S.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: S.COMPUTE, buffer: { type: "storage" } },
      { binding: 5, visibility: S.COMPUTE, buffer: { type: "read-only-storage" } },
    ] });
    const module = dev.createShaderModule({ code: WGSL });
    const pl = dev.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const mk = (entryPoint: string) => dev.createComputePipeline({ layout: pl, compute: { module, entryPoint } });
    this.pPoint = mk("point"); this.pBlurH = mk("blurH"); this.pBlurV = mk("blurV");
  }

  static async create(): Promise<GpuPreview | null> {
    try {
      const gpu = (navigator as any).gpu;
      if (!gpu) return null;
      const a = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!a) return null;
      const lim = a.limits;
      const dev = await a.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize, maxBufferSize: lim.maxBufferSize } });
      const info = a.info ?? {};
      const label = [info.vendor, info.architecture, info.description].filter((v: string) => !!v).join(" ") || "WebGPU adapter";
      const g = new GpuPreview(dev, label, Math.min(lim.maxStorageBufferBindingSize, lim.maxBufferSize));
      dev.lost?.then(() => { if (current === g) { current = null; pending = null; } });
      return g;
    } catch {
      return null;
    }
  }

  /** Whether the input with this key is on the GPU already. */
  hasInput(key: string) { return key === this.key; }

  /** Upload a filter input (float RGBA, 0..255). False when the frame is too large for this device. */
  setInput(key: string, w: number, h: number, data: Float32Array): boolean {
    if (w * h * 16 > this.maxBytes) return false;
    const G = (globalThis as any).GPUBufferUsage;
    if (w !== this.w || h !== this.h) {
      for (const b of [this.src, this.tmp, this.dst, this.read]) b?.destroy();
      const n = w * h;
      this.src = this.dev.createBuffer({ size: n * 16, usage: G.STORAGE | G.COPY_DST });
      this.tmp = this.dev.createBuffer({ size: n * 16, usage: G.STORAGE });
      this.dst = this.dev.createBuffer({ size: n * 4, usage: G.STORAGE | G.COPY_SRC });
      this.read = this.dev.createBuffer({ size: n * 4, usage: G.MAP_READ | G.COPY_DST });
      this.bg = this.dev.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: { buffer: this.uni } }, { binding: 1, resource: { buffer: this.src } }, { binding: 2, resource: { buffer: this.dst } },
        { binding: 3, resource: { buffer: this.lut } }, { binding: 4, resource: { buffer: this.tmp } }, { binding: 5, resource: { buffer: this.kern } },
      ] });
      this.w = w; this.h = h;
    }
    this.dev.queue.writeBuffer(this.src, 0, data.buffer, data.byteOffset, data.byteLength);
    this.key = key;
    return true;
  }

  /** Apply a filter to the uploaded input; 8-bit RGBA for the Viewer, or null when the filter is not supported. */
  run(type: string, p: P): Promise<Uint8ClampedArray | null> {
    const job = this.queue.then(() => this.exec(type, p));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async exec(type: string, p: P): Promise<Uint8ClampedArray | null> {
    if (!this.src || !gpuSupports(type, p)) return null;
    const ub = new ArrayBuffer(80), u32 = new Uint32Array(ub), f32 = new Float32Array(ub), i32 = new Int32Array(ub);
    u32[0] = this.w; u32[1] = this.h; u32[3] = LUT_N;
    let kern: Float32Array | null = null;
    switch (type) {
      case "levels": case "curves": case "brightness_contrast": case "exposure": {
        const L = toneLuts(type, p);
        if (!L) return null;
        u32[2] = 1;
        const tab = new Float32Array(3 * (LUT_N + 1));
        L.forEach((l, c) => { if (l && l.n === LUT_N) { tab.set(l.t, c * (LUT_N + 1)); u32[12 + c] = 1; } });
        this.dev.queue.writeBuffer(this.lut, 0, tab);
        break;
      }
      case "negative": u32[2] = 2; break;
      case "threshold": u32[2] = 3; f32[4] = p.level; u32[17] = p.mode === "rgb" ? 1 : 0; break;
      case "grayscale": {
        u32[2] = 4;
        u32[17] = ({ average: 1, lightness: 2, max: 3, min: 4 } as Record<string, number>)[p.method] ?? 0;
        const wv = p.method === "bt709" ? [0.2126, 0.7152, 0.0722] : [0.299, 0.587, 0.114];
        f32[8] = wv[0]; f32[9] = wv[1]; f32[10] = wv[2];
        break;
      }
      case "enable_channels": u32[2] = 5; f32[8] = p.r ? 1 : 0; f32[9] = p.g ? 1 : 0; f32[10] = p.b ? 1 : 0; break;
      case "white_balance": u32[2] = 5; f32[8] = p.r; f32[9] = p.g; f32[10] = p.b; break;
      case "color_switch": {
        u32[2] = 6;
        const sel = (v: string) => ({ r: 0, g: 1, b: 2, full: 3 } as Record<string, number>)[v] ?? 4;
        u32[12] = sel(p.r); u32[13] = sel(p.g); u32[14] = sel(p.b);
        break;
      }
      case "hue_saturation": u32[2] = 7; f32[4] = p.hue; f32[5] = p.saturation; f32[6] = p.lightness; break;
      case "gaussian_filter": kern = gaussWeights(p.sigma); u32[17] = 0; break;
      case "unsharp_mask": kern = gaussWeights(p.radius); u32[17] = 1; f32[4] = p.amount; f32[5] = p.threshold; break;
      case "high_pass_sharpening": kern = gaussWeights(p.radius); u32[17] = 2; f32[4] = p.amount; break;
      default: return null;
    }
    if (kern) { i32[16] = kern.length >> 1; this.dev.queue.writeBuffer(this.kern, 0, kern); }
    this.dev.queue.writeBuffer(this.uni, 0, ub);
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, this.bg);
    const gx = Math.ceil(this.w / 16), gy = Math.ceil(this.h / 16);
    if (kern) { pass.setPipeline(this.pBlurH); pass.dispatchWorkgroups(gx, gy); pass.setPipeline(this.pBlurV); pass.dispatchWorkgroups(gx, gy); }
    else { pass.setPipeline(this.pPoint); pass.dispatchWorkgroups(gx, gy); }
    pass.end();
    const bytes = this.w * this.h * 4;
    enc.copyBufferToBuffer(this.dst, 0, this.read, 0, bytes);
    this.dev.queue.submit([enc.finish()]);
    await this.read.mapAsync((globalThis as any).GPUMapMode.READ, 0, bytes);
    const out = new Uint8ClampedArray(this.read.getMappedRange(0, bytes).slice(0));
    this.read.unmap();
    return out;
  }
}

let current: GpuPreview | null = null;
let pending: Promise<GpuPreview | null> | null = null;

/** The shared GPU preview device (null when WebGPU is unavailable). */
export function getGpu(): Promise<GpuPreview | null> {
  if (!pending) pending = GpuPreview.create().then((g) => (current = g));
  return pending;
}

/** System Check line. */
export async function gpuStatus(): Promise<string> {
  if (!(navigator as any).gpu) return "Not available in this browser (the preview is skipped; exact results as always)";
  const g = await getGpu();
  return g ? `✔ ${g.label}` : "No WebGPU adapter (the preview is skipped; exact results as always)";
}
