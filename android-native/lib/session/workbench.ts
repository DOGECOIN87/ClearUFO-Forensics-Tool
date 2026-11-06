// The bridge between the app state and the processing engine.
//
// The engine is the port of the browser workbench (lib/engine): the same filters, the same
// numbers. This module builds the chain from the state, runs it, turns the result into a preview
// file and exports it with a read-back check.
import { encodeBMP, encodePNG, encodeTIFF } from "@/lib/codecs/image";
import { toU8, type Frame } from "@/lib/engine/frame";
import { MD5, SHA1, SHA256 } from "@/lib/engine/hash";
import { Workbench } from "@/lib/engine/graph";
import { ImageSource, type ImageEvidence } from "@/lib/engine/sources/image";
import { FILTERS, defaultParams } from "@/lib/shared/filters";
import type { ChainDoc, FilterInstance, SourceInfo } from "@/lib/shared/types";

import { CHAIN_ID, type ChainState, type EvidenceState } from "./store";

export const SOURCE_ID = "source-1";

/** The engine instance of the session (it keeps the decoded frames and the cache). */
export const workbench = new Workbench();

/** Hashes the original bytes of the evidence (the file is never changed). */
export function hashBytes(bytes: Uint8Array): { md5: string; sha1: string; sha256: string } {
  return {
    md5: new MD5().update(bytes).digest(),
    sha1: new SHA1().update(bytes).digest(),
    sha256: new SHA256().update(bytes).digest(),
  };
}

/** Registers the evidence with the engine and returns the decoded frame. */
export function registerEvidence(evidence: EvidenceState): SourceInfo {
  const source = new ImageSource(SOURCE_ID, {
    name: evidence.name,
    bytes: evidence.bytes,
    md5: evidence.md5,
    sha1: evidence.sha1,
    sha256: evidence.sha256,
    uri: evidence.uri,
    size: evidence.bytes.length,
  } satisfies ImageEvidence);
  workbench.addSource(SOURCE_ID, source);
  workbench.removeChain(CHAIN_ID);
  return source.info;
}

/**
 * The chain that is executed: the loader of the evidence followed by the filters of the examiner.
 * The loader is always the first step, so the order of the filters stays the order of the list.
 */
export function buildChain(chain: ChainState): ChainDoc {
  const filters: FilterInstance[] = [];
  const loader = FILTERS.image_loader;
  filters.push({
    id: "loader",
    type: "image_loader",
    enabled: true,
    params: { ...defaultParams(loader), source: SOURCE_ID },
  });
  for (const f of chain.filters) filters.push({ ...f, params: { ...f.params } });
  return { id: chain.id, name: chain.name, filters };
}

export interface RunOptions {
  onProgress?: (label: string, value: number) => void;
  isCancelled?: () => boolean;
}

/** Runs the chain and returns the resulting frame with the filters that were applied. */
export async function runChain(chain: ChainState, options: RunOptions = {}) {
  workbench.setOptions({ onProgress: options.onProgress, isCancelled: options.isCancelled });
  const doc = buildChain(chain);
  workbench.setChain(doc);
  const started = Date.now();
  const rendered = await workbench.render(chain.id, 0);
  return { ...rendered, ms: Date.now() - started };
}

/** 8-bit RGB samples of a frame (the preview format). */
export function frameToRgb8(frame: Frame): Uint8Array {
  const out = new Uint8Array(frame.w * frame.h * 3);
  const rgba = new Uint8ClampedArray(frame.d.length);
  toU8(frame.d, rgba);
  for (let i = 0, k = 0; i < frame.w * frame.h; i++, k += 3) {
    out[k] = rgba[i * 4];
    out[k + 1] = rgba[i * 4 + 1];
    out[k + 2] = rgba[i * 4 + 2];
  }
  return out;
}

/** 16-bit RGB samples of a frame (the lossless export format). */
export function frameToRgb16(frame: Frame): Uint16Array {
  const out = new Uint16Array(frame.w * frame.h * 3);
  const rgba = new Uint8ClampedArray(frame.d.length);
  toU8(frame.d, rgba);
  for (let i = 0, k = 0; i < frame.w * frame.h; i++, k += 3) {
    out[k] = Math.round(rgba[i * 4] * 257);
    out[k + 1] = Math.round(rgba[i * 4 + 1] * 257);
    out[k + 2] = Math.round(rgba[i * 4 + 2] * 257);
  }
  return out;
}

/** 32-bit float samples of a frame (the TIFF 32F export format). */
export function frameToRgb32f(frame: Frame): Float32Array {
  const out = new Float32Array(frame.w * frame.h * 3);
  for (let i = 0, k = 0; i < frame.w * frame.h; i++, k += 3) {
    out[k] = frame.d[i * 4];
    out[k + 1] = frame.d[i * 4 + 1];
    out[k + 2] = frame.d[i * 4 + 2];
  }
  return out;
}

export type ExportFormat = "png16" | "png8" | "tiff16" | "tiff32f" | "bmp";

export interface ExportFile {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

/** Encodes a frame in one of the lossless formats of the workbench. */
export function encodeFrame(frame: Frame, format: ExportFormat): ExportFile {
  switch (format) {
    case "png16":
      return { name: "image-16bit.png", bytes: encodePNG(frame.w, frame.h, frameToRgb16(frame)), mime: "image/png" };
    case "png8":
      return { name: "image-8bit.png", bytes: encodePNG(frame.w, frame.h, frameToRgb8(frame)), mime: "image/png" };
    case "tiff16":
      return { name: "image-16bit.tif", bytes: encodeTIFF(frame.w, frame.h, frameToRgb16(frame)), mime: "image/tiff" };
    case "tiff32f":
      return { name: "image-32bit-float.tif", bytes: encodeTIFF(frame.w, frame.h, frameToRgb32f(frame)), mime: "image/tiff" };
    case "bmp":
      return { name: "image-8bit.bmp", bytes: encodeBMP(frame.w, frame.h, frameToRgb8(frame)), mime: "image/bmp" };
    default:
      throw new Error(`Unknown export format "${format}"`);
  }
}

/** The MD5 of the samples of a frame (the fingerprint of the result). */
export function frameHash(frame: Frame): string {
  return new MD5().update(frameToRgb8(frame)).digest();
}
