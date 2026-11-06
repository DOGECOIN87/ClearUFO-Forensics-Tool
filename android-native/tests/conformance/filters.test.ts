// Conformance: the native filters against the browser reference (src/engine/filters).
//
// Every filter that only computes pixels is compared bit for bit: the same input frame and the same
// parameters must produce the same output samples in the app and in the browser workbench.
// The annotation filters (text, shapes, measurement overlays) are excluded: they draw with the
// platform's text and path rendering, which differs by design (the native app uses its own
// rasterizer), and they are covered by the app's own tests instead.
import { describe, expect, it } from "vitest";

import { basicFilters as refBasic } from "../../../src/engine/filters/basic";
import { linkFilters as refLink } from "../../../src/engine/filters/link";
import { presentationFilters as refPresentation } from "../../../src/engine/filters/presentation";
import { temporalFilters as refTemporal } from "../../../src/engine/filters/temporal";
import type { BuildCtx, FilterImpl, Stream } from "../../../src/engine/stream";

import { FILTERS_IMPL } from "@/lib/engine/filters/registry";
import type { Frame } from "@/lib/engine/frame";
import type { BuildCtx as NatCtx, FilterImpl as NatImpl, Stream as NatStream } from "@/lib/engine/stream";
import { defaultParams } from "@/lib/shared/filters";

const referenceFilters: Record<string, FilterImpl> = {
  ...refBasic, ...refLink, ...refTemporal, ...refPresentation,
};

const frame = (w: number, h: number, seed: number): Frame => {
  const d = new Float32Array(w * h * 4);
  let s = seed;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const r = (s >> 8) % 256, g = (s >> 16) % 256, b = (s >> 20) % 256;
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  return { w, h, d };
};

const makeStream = (frames: Frame[], fps = 25): Stream => ({
  info: { width: frames[0].w, height: frames[0].h, frameCount: frames.length, fps },
  getFrame: async (i: number) => frames[Math.max(0, Math.min(frames.length - 1, i))],
  meta: (i: number) => ({ type: "I", key: true, pts: i / fps, src: i }),
});

const context = (original: Stream, other: Stream): BuildCtx => ({
  chainId: "c1",
  filterId: "f1",
  key: "k",
  source: () => { throw new Error("no source"); },
  mediaSource: async () => { throw new Error("no source"); },
  chainStream: async () => other,
  chainName: () => "other",
  originalStream: async () => original,
  sourceOfChain: () => null,
  progress: () => undefined,
  isStale: () => false,
});

const natContext = (original: NatStream, other: NatStream): NatCtx => ({
  chainId: "c1",
  filterId: "f1",
  key: "k",
  source: () => { throw new Error("no source"); },
  mediaSource: async () => { throw new Error("no source"); },
  chainStream: async () => other,
  chainName: () => "other",
  originalStream: async () => original,
  sourceOfChain: () => null,
  progress: () => undefined,
  isStale: () => false,
});

interface Case {
  type: string;
  params?: Record<string, unknown>;
  frames?: number;
  /** The filter needs another chain (link filters). */
  link?: boolean;
  /** The filter compares with the original stream. */
  original?: boolean;
}

const CASES: Case[] = [
  { type: "grayscale", params: { method: "bt709" } },
  { type: "grayscale", params: { method: "lightness" } },
  { type: "color_conversion", params: { space: "hsv" } },
  { type: "color_conversion", params: { space: "lab" } },
  { type: "color_conversion", params: { space: "ycbcr709" } },
  { type: "color_switch", params: { r: "b", g: "g", b: "r" } },
  { type: "extract_channel", params: { channel: "cb", stretch: true } },
  { type: "enable_channels", params: { r: true, g: false, b: true } },
  { type: "levels", params: { channel: "all", inBlack: 12, inWhite: 240, gamma: 1.8, outBlack: 2, outWhite: 250 } },
  { type: "levels", params: { channel: "r", inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 } },
  { type: "curves", params: { channel: "all", curve: [{ x: 0, y: 0 }, { x: 128, y: 160 }, { x: 255, y: 255 }] } },
  { type: "brightness_contrast", params: { brightness: 18, contrast: 25 } },
  { type: "exposure", params: { exposure: 1.25, gamma: 2.2, offset: 4 } },
  { type: "auto_contrast", params: { clipLow: 0.5, clipHigh: 0.5, linked: true } },
  { type: "auto_contrast", params: { clipLow: 1, clipHigh: 2, linked: false } },
  { type: "histogram_equalization", params: { mode: "global", target: "luma", amount: 1 } },
  { type: "histogram_equalization", params: { mode: "clahe", tiles: 4, clip: 3, target: "rgb", amount: 0.5 } },
  { type: "white_balance", params: { mode: "grayworld" } },
  { type: "white_balance", params: { mode: "manual", r: 1.2, g: 1, b: 0.9 } },
  { type: "white_balance", params: { mode: "whitepatch" } },
  { type: "hue_saturation", params: { hue: 40, saturation: 20, lightness: -10 } },
  { type: "negative" },
  { type: "threshold", params: { level: 120, mode: "luma" } },
  { type: "threshold", params: { level: 120, mode: "rgb" } },
  { type: "fourier", params: { mode: "magnitude", log: true, channel: "y" } },
  { type: "gradient", params: { operator: "sobel", output: "magnitude", gain: 1 } },
  { type: "gradient", params: { operator: "scharr", output: "direction", gain: 2 } },
  { type: "gradient", params: { operator: "laplacian", output: "magnitude", gain: 1 } },
  { type: "bit_plane", params: { channel: "y", bit: 3 } },
  { type: "unsharp_mask", params: { radius: 1.5, amount: 1.2, threshold: 0 } },
  { type: "laplacian_sharpening", params: { amount: 1, diagonals: true } },
  { type: "high_pass_sharpening", params: { radius: 20, amount: 0.5 } },
  { type: "averaging_filter", params: { radius: 2 } },
  { type: "gaussian_filter", params: { sigma: 1.5 } },
  { type: "gaussian_filter", params: { sigma: 6 } },
  { type: "median_filter", params: { radius: 1 } },
  { type: "median_filter", params: { radius: 2 } },
  { type: "bilateral_filter", params: { sigmaS: 2, sigmaR: 20 } },
  { type: "nl_means", params: { h: 10, patch: 1, search: 2 } },
  { type: "wiener_filter", params: { radius: 2, noise: 0 } },
  { type: "deblocking", params: { block: 8, strength: 0.6, threshold: 24 } },
  { type: "ela", params: { quality: 90, chroma: "420", scale: 15 } },
  { type: "crop", params: { rect: { x: 3, y: 4, w: 20, h: 16 } } },
  { type: "resize", params: { mode: "scale", scale: 150, interp: "bicubic" } },
  { type: "resize", params: { mode: "size", width: 40, height: 30, keepAspect: false, interp: "bilinear" } },
  { type: "rotate", params: { angle: 17, interp: "bicubic", expand: true, background: "#000000" } },
  { type: "flip", params: { horizontal: true, vertical: true } },
  { type: "correct_perspective", params: { points: [{ x: 2, y: 1 }, { x: 25, y: 3 }, { x: 24, y: 20 }, { x: 3, y: 18 }], outWidth: 0, outHeight: 0, interp: "bicubic" } },
  { type: "lens_distortion", params: { k1: 0.12, k2: -0.03, cx: 0.5, cy: 0.5, zoom: 1, interp: "bicubic" } },
  { type: "aspect_ratio", params: { mode: "pal", direction: "width", interp: "bicubic" } },
  { type: "line_doubling", params: { field: "top" } },
  { type: "field_shift", params: { field: "bottom", dx: 1, dy: 1 } },
  { type: "motion_deblurring", params: { line: null, length: 8, angle: 20, method: "wiener", noise: 0.01, iterations: 25 } },
  { type: "optical_deblurring", params: { radius: 3, method: "wiener", noise: 0.01, iterations: 25 } },
  { type: "gaussian_deblurring", params: { sigma: 1.5, method: "wiener", noise: 0.01, iterations: 25 } },
  { type: "single_selector", params: { frame: 1 } },
  { type: "range_selector", params: { start: 0, end: 2, step: 1 } },
  { type: "sparse_selector", params: { frames: "0,2" } },
  { type: "remove_duplicates", params: { threshold: 0.5, roi: null } },
  { type: "demultiplexer", params: { reference: 0, threshold: 75, roi: null } },
  { type: "motion_detection", params: { roi: { x: 0, y: 0, w: 20, h: 20 }, threshold: 20, minArea: 0.5, mode: "motion" } },
  { type: "deinterlace", params: { field: "top", method: "linear" } },
  { type: "field_separation", params: { mode: "stack" } },
  { type: "interleave", params: { first: "top" } },
  { type: "frame_difference", params: { offset: 1, gain: 4, mode: "abs" } },
  { type: "local_stabilization", params: { roi: { x: 4, y: 4, w: 16, h: 16 }, reference: 0, search: 8, subpixel: true, fill: "black" } },
  { type: "global_stabilization", params: { reference: 0, subpixel: true, fill: "black" } },
  { type: "frame_averaging", params: { mode: "window", window: 3, method: "mean", sigma: 2 } },
  { type: "frame_averaging", params: { mode: "window", window: 3, method: "median", sigma: 2 } },
  { type: "temporal_smoothing", params: { size: 3, method: "mean", protect: true, threshold: 12, showMask: false } },
  { type: "temporal_smoothing", params: { size: 3, method: "gaussian", protect: false, threshold: 12, showMask: false } },
  { type: "change_frame_rate", params: { fps: 30 } },
  { type: "convert_frame_rate", params: { fps: 12, method: "nearest" } },
  { type: "convert_frame_rate", params: { fps: 12, method: "blend" } },
  { type: "reverse" },
  { type: "freeze_frame", params: { frame: 1, duration: 3 } },
  { type: "compare_original", params: { mode: "sbs_h", balance: 0.5, gain: 1, lineColor: "#c0c0c0", lineThickness: 2, originalFirst: true }, original: true },
  { type: "compare_original", params: { mode: "difference", balance: 0.5, gain: 2, lineColor: "#c0c0c0", lineThickness: 0, originalFirst: true }, original: true },
  { type: "video_mixer", params: { second: "c2", mode: "difference", balance: 0.5, gain: 2, offset: 0, checker: 32 }, link: true },
  { type: "multiview", params: { chains: ["c2"], columns: 2, labels: false, border: 2, borderColor: "#202020" }, link: true },
  { type: "picture_in_picture", params: { inset: "c2", x: 60, y: 5, scale: 30, border: 1, borderColor: "#ffffff", offset: 0 }, link: true },
  { type: "timeline", params: { chains: ["c2"] }, link: true },
  { type: "replace_channel", params: { target: "r", source: "c2", sourceChannel: "y" }, link: true },
];

describe("filters", () => {
  for (const c of CASES) {
    it(`${c.type}${c.params ? " " + JSON.stringify(c.params).slice(0, 60) : ""}`, async () => {
      const count = c.frames ?? 3;
      const frames = Array.from({ length: count }, (_, i) => frame(32, 24, 100 + i));
      const other = Array.from({ length: count }, (_, i) => frame(32, 24, 500 + i));
      const refStream = makeStream(frames);
      const natStreamIn = makeStream(frames);
      const refOther = makeStream(other);
      const natOther = makeStream(other);
      const params = { ...defaultParams({ id: c.type, params: [] } as never), ...(c.params ?? {}) };

      const refImpl = referenceFilters[c.type];
      const natImpl = FILTERS_IMPL[c.type];
      expect(refImpl, `the browser reference has no filter "${c.type}"`).toBeTruthy();
      expect(natImpl, `the native app has no filter "${c.type}"`).toBeTruthy();

      const refOut = await refImpl(c.original || c.link ? refStream : refStream, params, context(refStream, refOther));
      const natOut = await natImpl(c.original || c.link ? natStreamIn : natStreamIn, params, natContext(natStreamIn, natOther));

      const framesToCompare = Math.min(refOut.info.frameCount, natOut.info.frameCount);
      expect(natOut.info.frameCount, "frame count").toBe(refOut.info.frameCount);
      expect(natOut.info.width, "width").toBe(refOut.info.width);
      expect(natOut.info.height, "height").toBe(refOut.info.height);
      for (let i = 0; i < framesToCompare; i++) {
        const a = await refOut.getFrame(i);
        const b = await natOut.getFrame(i);
        expect(b.d.length, `frame ${i}: length`).toBe(a.d.length);
        for (let k = 0; k < a.d.length; k++) {
          if (!Object.is(a.d[k], b.d[k])) {
            expect({ frame: i, sample: k, native: b.d[k], reference: a.d[k] }, `frame ${i}: first different sample`).toEqual({ frame: i, sample: k, native: b.d[k], reference: a.d[k] });
          }
        }
      }
    });
  }
});
