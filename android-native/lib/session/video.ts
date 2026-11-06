// Opening a video file on the device.
//
// The demuxers of the app (lib/engine/sources) read the structure of the file and build the exact
// frame table. The pixels of the Motion JPEG and of the uncompressed AVI files are decoded on the
// device; the compressed video codecs are reported with the codec name instead of a wrong image.
import { MemoryByteSource, type ByteSource } from "@/lib/codecs/byteSource";
import { SafByteSource } from "@/lib/project/safSource";
import { openAvi, type ByteRange } from "@/lib/engine/sources/avi";
import { Mp4Source, parseMp4 } from "@/lib/engine/sources/mp4";
import { baseInfo, type SourceProvider } from "@/lib/engine/sources/types";
import type { FrameMeta, FrameTable, SourceInfo } from "@/lib/shared/types";
import type { Frame } from "@/lib/engine/frame";

export const VIDEO_SOURCE_ID = "video-1";

export interface VideoSession {
  id: string;
  name: string;
  uri: string;
  size: number;
  kind: "avi" | "mp4";
  provider: SourceProvider;
  info: SourceInfo;
  /** True when the app can decode the frames of the file itself. */
  decodable: boolean;
  /** Why the file cannot be decoded (when it cannot). */
  limitation?: string;
  table?: FrameTable;
}

/** The source of an AVI file whose video stream is a compressed codec that the app cannot decode. */
class BitstreamSource implements SourceProvider {
  info: SourceInfo;
  table: FrameTable;

  constructor(
    public id: string,
    info: SourceInfo,
    private frames: ByteRange[],
    private codec: string,
    fps: number,
  ) {
    this.info = info;
    const n = frames.length;
    const types = new Uint8Array(n);
    const bytes = new Uint32Array(n);
    const pts = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      types[i] = frames[i].key ? 1 : 2;
      bytes[i] = frames[i].size;
      pts[i] = i / (fps || 25);
    }
    this.table = { sourceId: id, count: n, types, bytes, pts, ready: true };
  }

  async getFrame(): Promise<Frame> {
    throw new Error(
      `The codec "${this.codec}" of this AVI file cannot be decoded on the device in this build. ` +
        `The frame table (${this.frames.length} frames) was read exactly.`,
    );
  }

  meta(i: number): FrameMeta {
    const f = this.frames[i];
    return { type: f?.key ? "I" : "P", key: !!f?.key, pts: i / (this.info.fps || 25), bytes: f?.size ?? 0, src: i };
  }

  dispose() {}
}

/** The kind of the file, from its first bytes. */
export function sniffVideo(head: Uint8Array): "avi" | "mp4" | null {
  const asc = (o: number, n: number) => String.fromCharCode(...head.subarray(o, o + n));
  if (asc(0, 4) === "RIFF" && asc(8, 4) === "AVI ") return "avi";
  if (asc(4, 4) === "ftyp") return "mp4";
  return null;
}

/** Opens a video file: the demuxer builds the frame table, the app decodes what it can. */
export async function openVideo(name: string, uri: string, size: number): Promise<VideoSession> {
  const src: ByteSource = new SafByteSource(uri, size);
  const head = await src.read(0, 64);
  const kind = sniffVideo(head);
  if (!kind) throw new Error("The file is not a video this app can read (an AVI or an MP4 file was expected).");

  if (kind === "avi") {
    const opened = await openAvi(VIDEO_SOURCE_ID, src, name);
    if (opened.kind === "frames") {
      const provider = opened.provider;
      return {
        id: VIDEO_SOURCE_ID,
        name,
        uri,
        size,
        kind,
        provider,
        info: provider.info,
        decodable: true,
        table: frameTableOf(provider, provider.info.frameCount),
      };
    }
    // H.264 or HEVC in an AVI file: the frames are read exactly, the pixels are not decoded.
    const info = baseInfo(VIDEO_SOURCE_ID, name, "video");
    Object.assign(info, {
      width: opened.parse.width,
      height: opened.parse.height,
      frameCount: opened.parse.frames.length,
      fps: opened.fps,
      duration: opened.parse.frames.length / (opened.fps || 25),
      fileSize: size,
      container: "AVI (RIFF)",
      codec: opened.codec.toUpperCase(),
      engine: "Built-in AVI demuxer",
      frameTypesReady: true,
    });
    const provider = new BitstreamSource(VIDEO_SOURCE_ID, info, opened.parse.frames, opened.codec.toUpperCase(), opened.fps);
    return {
      id: VIDEO_SOURCE_ID,
      name,
      uri,
      size,
      kind,
      provider,
      info,
      decodable: false,
      limitation: `The codec "${opened.codec.toUpperCase()}" cannot be decoded on the device in this build.`,
      table: provider.table,
    };
  }

  const parse = await parseMp4(src);
  const provider = new Mp4Source(VIDEO_SOURCE_ID, src, parse);
  return {
    id: VIDEO_SOURCE_ID,
    name,
    uri,
    size,
    kind,
    provider,
    info: provider.info,
    decodable: false,
    limitation: `The codec "${parse.codec}" cannot be decoded on the device in this build.`,
    table: provider.table,
  };
}

/** The frame table of a provider (the types, the sizes and the timestamps). */
export function frameTableOf(provider: SourceProvider, count: number): FrameTable {
  const types = new Uint8Array(count);
  const bytes = new Uint32Array(count);
  const pts = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const m = provider.meta(i);
    types[i] = m.type === "I" ? 1 : m.type === "P" ? 2 : m.type === "B" ? 3 : m.type === "S" ? 4 : 0;
    bytes[i] = m.bytes ?? 0;
    pts[i] = m.pts ?? i / (provider.info.fps || 25);
  }
  return { sourceId: provider.id, count, types, bytes, pts, ready: true };
}
