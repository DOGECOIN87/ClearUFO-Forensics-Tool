// Filters combining several chains.
import { alloc, type Frame } from "../frame";
import { label as drawLabel, overlay } from "../kernels/draw";
import { resize } from "../kernels/geometry";
import { needInput, type FilterImpl, type Stream } from "../stream";
import { channelValue } from "./basic";
import { parseColor } from "../frame";

const at = (s: Stream, i: number) => s.getFrame(Math.max(0, Math.min(s.info.frameCount - 1, i)));
const fit = (f: Frame, w: number, h: number) => (f.w === w && f.h === h ? f : resize(f, w, h, "bilinear"));

function letterbox(f: Frame, w: number, h: number): Frame {
  const s = Math.min(w / f.w, h / f.h);
  const nw = Math.max(1, Math.round(f.w * s)), nh = Math.max(1, Math.round(f.h * s));
  const r = resize(f, nw, nh, "bilinear");
  const out = alloc(w, h, true);
  const ox = (w - nw) >> 1, oy = (h - nh) >> 1;
  for (let y = 0; y < nh; y++) out.d.set(r.d.subarray(y * nw * 4, (y + 1) * nw * 4), ((y + oy) * w + ox) * 4);
  return out;
}

const mixer: FilterImpl = async (input, p, ctx) => {
  const a = needInput(input);
  if (!p.second) throw new Error("Select the second input chain in the Filter Settings");
  const b = await ctx.chainStream(p.second);
  const { width: w, height: h } = a.info;
  const ow = p.mode === "sbs_h" ? w * 2 : w, oh = p.mode === "sbs_v" ? h * 2 : h;
  return {
    info: { ...a.info, width: ow, height: oh },
    meta: (i) => a.meta(i),
    getFrame: async (i) => {
      const fa = await a.getFrame(i);
      const fb = fit(await at(b, i + (p.offset | 0)), w, h);
      const out = alloc(ow, oh, true);
      const bal = p.balance, g = p.gain;
      if (p.mode === "sbs_h" || p.mode === "sbs_v") {
        for (let y = 0; y < h; y++) {
          out.d.set(fa.d.subarray(y * w * 4, (y + 1) * w * 4), y * ow * 4);
          const dst = p.mode === "sbs_h" ? (y * ow + w) * 4 : ((y + h) * ow) * 4;
          out.d.set(fb.d.subarray(y * w * 4, (y + 1) * w * 4), dst);
        }
        return out;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const k = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const va = fa.d[k + c], vb = fb.d[k + c];
          let v: number;
          switch (p.mode) {
            case "difference": v = 128 + (va - vb) * g / 2; break;
            case "absdiff": v = Math.abs(va - vb) * g; break;
            case "wipe_h": v = x < bal * w ? va : vb; break;
            case "wipe_v": v = y < bal * h ? va : vb; break;
            case "checker": v = ((Math.floor(x / p.checker) + Math.floor(y / p.checker)) & 1) === 0 ? va : vb; break;
            default: v = va * (1 - bal) + vb * bal;
          }
          out.d[k + c] = v;
        }
      }
      return out;
    },
  };
};

const multiview: FilterImpl = async (input, p, ctx) => {
  const a = needInput(input);
  const others: Stream[] = [];
  const names = [ctx.chainName(ctx.chainId)];
  for (const id of p.chains || []) { if (id === ctx.chainId) continue; others.push(await ctx.chainStream(id)); names.push(ctx.chainName(id)); }
  const all = [a, ...others];
  const N = all.length;
  const cols = p.columns > 0 ? p.columns : Math.ceil(Math.sqrt(N)), rows = Math.ceil(N / cols);
  const { width: W, height: H } = a.info, B = Math.max(0, p.border | 0);
  const ow = cols * W + (cols + 1) * B, oh = rows * H + (rows + 1) * B;
  const [br, bg, bb] = parseColor(p.borderColor);
  const n = Math.max(...all.map((s) => s.info.frameCount));
  return {
    info: { ...a.info, width: ow, height: oh, frameCount: n },
    meta: (i) => a.meta(Math.min(a.info.frameCount - 1, i)),
    getFrame: async (i) => {
      const out = alloc(ow, oh, true);
      for (let k = 0; k < out.d.length; k += 4) { out.d[k] = br; out.d[k + 1] = bg; out.d[k + 2] = bb; }
      for (let t = 0; t < N; t++) {
        const tile = letterbox(await at(all[t], i), W, H);
        const ox = B + (t % cols) * (W + B), oy = B + Math.floor(t / cols) * (H + B);
        for (let y = 0; y < H; y++) out.d.set(tile.d.subarray(y * W * 4, (y + 1) * W * 4), ((y + oy) * ow + ox) * 4);
      }
      if (!p.labels) return out;
      return overlay(out, (c) => {
        for (let t = 0; t < N; t++) {
          const ox = B + (t % cols) * (W + B), oy = B + Math.floor(t / cols) * (H + B);
          drawLabel(c, names[t], ox + 8, oy + 6, Math.max(12, Math.round(H / 24)), "#ffffff", "rgba(0,0,0,0.6)");
        }
      });
    },
  };
};

const pip: FilterImpl = async (input, p, ctx) => {
  const a = needInput(input);
  if (!p.inset) throw new Error("Select the inset chain in the Filter Settings");
  const b = await ctx.chainStream(p.inset);
  const { width: w, height: h } = a.info;
  const iw = Math.max(8, Math.round((w * p.scale) / 100)), ih = Math.max(8, Math.round((iw * b.info.height) / b.info.width));
  const x0 = Math.round((p.x / 100) * w), y0 = Math.round((p.y / 100) * h);
  const B = p.border | 0;
  const [cr, cg, cb] = parseColor(p.borderColor);
  return {
    info: a.info,
    meta: (i) => a.meta(i),
    getFrame: async (i) => {
      const out = { ...(await a.getFrame(i)) };
      out.d = new Float32Array(out.d);
      const ins = resize(await at(b, i + (p.offset | 0)), iw, ih, "bilinear");
      for (let y = -B; y < ih + B; y++) for (let x = -B; x < iw + B; x++) {
        const X = x0 + x, Y = y0 + y;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const o = (Y * w + X) * 4;
        if (x < 0 || y < 0 || x >= iw || y >= ih) { out.d[o] = cr; out.d[o + 1] = cg; out.d[o + 2] = cb; continue; }
        const s = (y * iw + x) * 4;
        out.d[o] = ins.d[s]; out.d[o + 1] = ins.d[s + 1]; out.d[o + 2] = ins.d[s + 2];
      }
      return out;
    },
  };
};

const timeline: FilterImpl = async (input, p, ctx) => {
  const a = needInput(input);
  const parts: Stream[] = [a];
  for (const id of p.chains || []) if (id !== ctx.chainId) parts.push(await ctx.chainStream(id));
  const starts: number[] = [];
  let total = 0;
  for (const s of parts) { starts.push(total); total += s.info.frameCount; }
  const locate = (i: number) => { let k = parts.length - 1; while (k > 0 && i < starts[k]) k--; return { s: parts[k], j: i - starts[k] }; };
  const { width: w, height: h } = a.info;
  return {
    info: { ...a.info, frameCount: total },
    meta: (i) => { const { s, j } = locate(i); return { ...s.meta(j), pts: i / a.info.fps }; },
    getFrame: async (i) => { const { s, j } = locate(i); return letterboxIfNeeded(await s.getFrame(j), w, h); },
  };
};

const letterboxIfNeeded = (f: Frame, w: number, h: number) => (f.w === w && f.h === h ? f : letterbox(f, w, h));

const replaceChannel: FilterImpl = async (input, p, ctx) => {
  const a = needInput(input);
  if (!p.source) throw new Error("Select the source chain in the Filter Settings");
  const b = await ctx.chainStream(p.source);
  const ti = p.target === "g" ? 1 : p.target === "b" ? 2 : 0;
  return {
    info: a.info,
    meta: (i) => a.meta(i),
    getFrame: async (i) => {
      const fa = await a.getFrame(i), fb = fit(await at(b, i), fa.w, fa.h);
      const out = new Float32Array(fa.d);
      for (let k = 0; k < out.length; k += 4) out[k + ti] = channelValue(p.sourceChannel, fb.d[k], fb.d[k + 1], fb.d[k + 2]);
      return { w: fa.w, h: fa.h, d: out };
    },
  };
};

export const linkFilters: Record<string, FilterImpl> = { video_mixer: mixer, multiview, picture_in_picture: pip, timeline, replace_channel: replaceChannel };
