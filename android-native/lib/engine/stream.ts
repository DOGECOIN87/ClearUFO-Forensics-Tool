// Lazy frame streams: every filter turns its input stream into an output stream.
import type { FrameMeta, ParamValues, StreamInfo } from "../shared/types";
import { clone, type Frame } from "./frame";
import type { SourceProvider } from "./sources/types";

export interface Stream {
  info: StreamInfo;
  getFrame(i: number): Promise<Frame>;
  meta(i: number): FrameMeta;
}

export interface BuildCtx {
  chainId: string;
  filterId: string;
  key: string;
  source(id: string): SourceProvider;
  mediaSource(id: string): Promise<SourceProvider>;
  chainStream(chainId: string): Promise<Stream>;
  chainName(chainId: string): string;
  originalStream(): Promise<Stream>;
  /** The file source feeding the current chain (if its first filter is a file loader). */
  sourceOfChain(): SourceProvider | null;
  progress(label: string, value: number): void;
  isStale(): boolean;
}

export type FilterImpl = (input: Stream | null, p: ParamValues, ctx: BuildCtx) => Stream | Promise<Stream>;

export function needInput(input: Stream | null): Stream {
  if (!input) throw new Error("This filter needs an input: add a loader first");
  return input;
}

/** Frame-wise filter. */
export function mapStream(input: Stream | null, fn: (f: Frame, i: number) => Frame | Promise<Frame>, info?: Partial<StreamInfo>): Stream {
  const src = needInput(input);
  return {
    info: { ...src.info, ...info },
    getFrame: async (i) => fn(await src.getFrame(i), i),
    meta: (i) => src.meta(i),
  };
}

/** Output frame i is input frame index[i]. */
export function remapStream(input: Stream, index: number[] | Int32Array, info?: Partial<StreamInfo>): Stream {
  const n = index.length;
  if (!n) throw new Error("No frames selected");
  const at = (i: number) => index[Math.max(0, Math.min(n - 1, i | 0))];
  return {
    info: { ...input.info, frameCount: n, ...info },
    getFrame: (i) => input.getFrame(at(i)),
    meta: (i) => input.meta(at(i)),
  };
}

export function constantStream(frame: Frame, info: StreamInfo, meta: FrameMeta): Stream {
  return { info: { ...info, frameCount: 1, width: frame.w, height: frame.h }, getFrame: async () => frame, meta: () => meta };
}

export const passthrough = (input: Stream | null) => needInput(input);

/** Copy-on-write helper for filters that modify pixels in place. */
export const writable = (f: Frame) => clone(f);

export function clampFrameIndex(v: number, n: number, allowLast = false) {
  if (allowLast && v < 0) return n - 1;
  return Math.max(0, Math.min(n - 1, Math.round(v || 0)));
}
