// Shared types used by the UI thread and the processing engine (Web Worker).
// Everything in here must be structured-clone friendly (plain data).
import type { WriteFormat } from "./formats";

export interface Pt { x: number; y: number }
export interface RectP { x: number; y: number; w: number; h: number }
export type ParamValues = Record<string, any>;

/** One filter in a processing chain. */
export interface FilterInstance {
  id: string;
  type: string;
  params: ParamValues;
  enabled: boolean;
}

/** A processing chain: a source (loader or link) followed by filters. */
export interface ChainDoc {
  id: string;
  name: string;
  filters: FilterInstance[];
}

export type SourceKind = "image" | "sequence" | "video" | "synthetic" | "dvr";

export interface SourceFileRef { name: string; size: number; lastModified: number; type: string }

export interface SourceRef {
  id: string;
  kind: SourceKind;
  name: string;
  files: SourceFileRef[];
  /** Options used to open the source (synthetic pattern, fps for sequences, DVR settings…). */
  options?: Record<string, any>;
  md5?: string;
  sha1?: string;
  sha256?: string;
}

export interface CaseInfo {
  caseNumber: string;
  examiner: string;
  agency: string;
  exhibit: string;
  notes: string;
}

export interface Bookmark { id: string; chainId: string; frame: number; note: string }

export interface ProjectDoc {
  app: string;
  /** 1: earlier versions (replicate chroma); 2: explicit Video Loader Chroma Filter (see shared/project.ts). */
  schema: number;
  name: string;
  chains: ChainDoc[];
  sources: Record<string, SourceRef>;
  caseInfo: CaseInfo;
  bookmarks: Bookmark[];
  created: string;
  modified: string;
  /** Audit trail of the AI assistant: every request, the model used and the actions taken (report › AI assistance). */
  aiLog?: AiLogEntry[];
}

export interface AiLogAction { time: string; tool: string; summary: string; ok: boolean; note?: string }
export interface AiLogEntry {
  time: string;
  provider: string;
  model: string;
  /** Host of the model server (e.g. api.openai.com, localhost:11434). */
  endpoint: string;
  mode: "agent" | "ask";
  request: string;
  actions: AiLogAction[];
  /** Images of frames given to the model during this request. */
  framesShared: number;
  reply?: string;
}

/** Description of a processed stream at some point of a chain. */
export interface StreamInfo {
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  /** Pixel aspect ratio (width/height of one pixel). */
  par?: number;
}

export type FrameType = "I" | "P" | "B" | "S" | "?";

export interface FrameMeta {
  type?: FrameType;
  /** Presentation timestamp in seconds. */
  pts?: number;
  key?: boolean;
  bytes?: number;
  /** Index of the originating source frame. */
  src?: number;
}

export interface SourceInfo {
  id: string;
  kind: SourceKind;
  name: string;
  path?: string;
  fileSize: number;
  fileCount: number;
  mime?: string;
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  duration: number;
  container?: string;
  codec?: string;
  codecString?: string;
  /** Pixel aspect ratio as [num, den]. */
  par?: [number, number];
  colorRange?: string;
  colorMatrix?: string;
  colorPrimaries?: string;
  transfer?: string;
  rotation?: number;
  bitrate?: number;
  hasAudio: boolean;
  audio?: { codec: string; sampleRate: number; channels: number };
  videoStreams: number;
  audioStreams: number;
  subtitleStreams: number;
  vfr?: { min: number; max: number; avg: number; variable: boolean };
  /** Generic metadata list (EXIF, container tags, analysis notes). */
  metadata: [string, string][];
  frameTypesReady: boolean;
  /** Engine used to decode ("WebCodecs (Mediabunny)", "Native image decoder", …). */
  engine: string;
  /** Video only: who converted the decoded YUV pixels to RGB and how (File Info, report). */
  conversion?: string;
  /** True when the browser, not the application, converted YUV to RGB: the loader's Color Matrix and Range do not apply. */
  browserConversion?: boolean;
  /** Video only: chroma sample position signaled in the stream (H.273 name, e.g. "left"), when known. */
  chromaSiting?: string;
  /** Video only: which WebCodecs decoder was requested: "software" (exact planes, full bit depth) or "default" (browser's choice, may be hardware). */
  decoder?: "software" | "default";
  warnings: string[];
}

/** Frame-level analysis of a source (GOP structure). */
export interface FrameTable {
  sourceId: string;
  count: number;
  /** 0 = unknown, 1 = I, 2 = P, 3 = B, 4 = S */
  types: Uint8Array;
  bytes: Uint32Array;
  pts: Float64Array;
  ready: boolean;
}

export interface ChannelStats { min: number; max: number; mean: number; std: number }

export interface RenderRequest {
  chainId: string;
  /** Show the output of this filter (default: last filter of the chain). */
  filterId?: string | null;
  frame: number;
  /** Show the input of the selected filter instead of its output. */
  input?: boolean;
  want?: { hist?: boolean; hash?: boolean };
  /** Requests on the same channel supersede each other (latest wins). */
  channel: string;
  /**
   * Frames playback will most likely ask for next. The engine computes them right after replying, while the
   * page draws this one, so the next request finds them cached (or joins the computation already running).
   */
  prefetch?: number[];
}

export interface RenderOk {
  ok: true;
  frame: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  info: StreamInfo;
  meta: FrameMeta;
  ms: number;
  hist?: Uint32Array; // 5 x 256: R, G, B, Luma, (unused)
  stats?: ChannelStats[]; // R, G, B, Y
  md5?: string; // md5 of the RGB 8-bit buffer
  chMd5?: string[]; // per channel md5 (R, G, B)
  saturated?: { low: number; high: number };
}

export interface RenderErr {
  ok: false;
  superseded?: boolean;
  error: string;
  filterId?: string;
  info?: StreamInfo;
}

export type RenderResult = RenderOk | RenderErr;

export interface ProgressEvent { taskId: string; label: string; value: number; done?: boolean }

export interface WriteRequest {
  chainId: string;
  filterId?: string | null;
  format: WriteFormat;
  quality: number; // 0..1, lossy formats only
  start: number;
  end: number; // inclusive
  fps?: number;
  name: string;
  taskId: string;
  /** Write straight to this file (File System Access) instead of returning a Blob. */
  handle?: FileSystemFileHandle;
  /** Write to this staging file in the browser's storage (on disk) and return it for download. */
  stage?: string;
  /** Lossless formats: read the written file back and compare every frame with the processed frame. */
  verify?: boolean;
  /** Testing: RIFF segment size of AVI files (OpenDML segmenting without writing gigabytes). */
  segmentBytes?: number;
  /** Testing: always write ZIP64 records. */
  forceZip64?: boolean;
}

export interface WriteResult {
  name: string;
  mime: string;
  /** The file, when it was assembled in memory (the app downloads it). Absent when written to disk. */
  blob?: Blob;
  /** The staging file in the browser's storage (on disk), when the request named one; the app downloads it. */
  file?: File;
  staged?: string;
  /** Written to the file the user chose (request handle). */
  savedToDisk: boolean;
  bytes: number;
  frames: number;
  width: number;
  height: number;
  /** Codec actually used (MP4/WebM pick the first one the browser can encode). */
  codec?: string;
  /** Lossless exports with verify: every frame read back from the written file and compared. */
  verified?: { ok: boolean; message: string; cancelled?: boolean };
  /** MD5 of the samples of each written frame (8-bit formats: equal to the frame hash in the Tools). */
  hashes?: string[];
}

export interface DvrScanResult {
  container: string;
  codec: "h264" | "hevc" | "unknown";
  nalCount: number;
  frames: number;
  width: number;
  height: number;
  fps: number;
  notes: string[];
}

/** Interactive overlay types that a filter parameter can expose in the viewer. */
export type OverlayKind = "rect" | "point" | "points" | "line";
