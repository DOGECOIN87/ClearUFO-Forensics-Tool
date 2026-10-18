import type { FrameMeta, FrameTable, SourceInfo } from "../../shared/types";
import type { Frame } from "../frame";
import { DEFAULT_CHROMA, type ChromaFilter, type Siting } from "./yuv";

export interface DecodeOpts {
  colorRange?: "auto" | "limited" | "full";
  matrix?: "auto" | "bt601" | "bt709" | "bt2020";
  /** Chroma reconstruction of 4:2:0 / 4:2:2 video (default bicubic). */
  chroma?: ChromaFilter;
  /** Chroma sample position; "auto" uses the value signaled in the stream, else the MPEG default (left). */
  siting?: "auto" | Siting;
  /** HDR (PQ/HLG) video: tone map to SDR BT.709 (BT.2390) or keep the signal values (default for old projects). */
  hdr?: "tonemap" | "none";
  /** Source peak luminance for the tone mapping, cd/m² (default 1000). */
  hdrPeak?: number;
}

/** Cache key of a decoded frame: every option that changes the pixels. */
export const decodeKey = (o?: DecodeOpts) => `${o?.colorRange ?? "auto"}|${o?.matrix ?? "auto"}|${o?.chroma ?? DEFAULT_CHROMA}|${o?.siting ?? "auto"}|${o?.hdr ?? "none"}|${o?.hdr === "tonemap" ? o.hdrPeak ?? 1000 : ""}`;

export interface SourceProvider {
  id: string;
  info: SourceInfo;
  table?: FrameTable;
  getFrame(i: number, opts?: DecodeOpts): Promise<Frame>;
  meta(i: number): FrameMeta;
  /** Background analysis of frame types (I/P/B) and sizes. */
  analyze?(onProgress: (v: number) => void): Promise<void>;
  /** False when the codec cannot be decoded through WebCodecs in this browser. */
  decodable?: boolean;
  /** Raw bytes of a converted container (Convert DVR), for download. */
  converted?: { name: string; buffer: ArrayBuffer };
  dispose(): void;
}

export function baseInfo(id: string, name: string, kind: SourceInfo["kind"]): SourceInfo {
  return {
    id, kind, name, fileSize: 0, fileCount: 1, width: 0, height: 0, frameCount: 1, fps: 25, duration: 0,
    hasAudio: false, videoStreams: 0, audioStreams: 0, subtitleStreams: 0, metadata: [], frameTypesReady: false,
    engine: "", warnings: [],
  };
}

export function emptyTable(sourceId: string, n: number): FrameTable {
  return { sourceId, count: n, types: new Uint8Array(n), bytes: new Uint32Array(n), pts: new Float64Array(n), ready: false };
}

/** Small byte-budget LRU for decoded source frames. */
export class SourceFrameCache {
  private map = new Map<string, Frame>();
  private bytes = 0;
  constructor(private limit = 160 * 1024 * 1024) {}
  get(k: string) {
    const f = this.map.get(k);
    if (f) { this.map.delete(k); this.map.set(k, f); }
    return f;
  }
  set(k: string, f: Frame) {
    if (this.map.has(k)) return;
    this.map.set(k, f);
    this.bytes += f.d.byteLength;
    while (this.bytes > this.limit && this.map.size > 1) {
      const first = this.map.keys().next().value as string;
      this.bytes -= this.map.get(first)!.d.byteLength;
      this.map.delete(first);
    }
  }
  clear() { this.map.clear(); this.bytes = 0; }
}

/** Serializes async operations (one decoder cursor per source). */
export class Mutex {
  private p: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.p.then(fn, fn);
    this.p = r.catch(() => undefined);
    return r;
  }
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(2)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}
