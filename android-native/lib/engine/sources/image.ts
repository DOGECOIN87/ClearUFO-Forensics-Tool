// Still image evidence: the file is read once, hashed as it was read, decoded with the native
// decoders and kept immutable. The source never writes to the original file.
import { decodeStill } from "../../codecs/still";
import { baseInfo, type SourceProvider } from "./types";
import type { Frame } from "../frame";
import type { FrameMeta, SourceInfo } from "../../shared/types";

export interface ImageEvidence {
  /** File name as shown by the picker. */
  name: string;
  /** Bytes of the original file. */
  bytes: Uint8Array;
  md5: string;
  sha1: string;
  sha256: string;
  /** Android document URI (kept for relinking and for the report). */
  uri?: string;
  size: number;
  lastModified?: number;
}

export class ImageSource implements SourceProvider {
  info: SourceInfo;
  private frame: Frame;

  constructor(public id: string, public evidence: ImageEvidence) {
    const decoded = decodeStill(evidence.bytes);
    this.frame = decoded.frame;
    this.info = baseInfo(id, evidence.name, "image");
    Object.assign(this.info, {
      fileSize: evidence.size ?? evidence.bytes.length,
      fileCount: 1,
      width: decoded.frame.w,
      height: decoded.frame.h,
      frameCount: 1,
      fps: 1,
      duration: 0,
      container: decoded.format.toUpperCase(),
      codec: decoded.format,
      codecString: decoded.depth ? `${decoded.depth}-bit` : undefined,
      hasAudio: false,
      videoStreams: 0,
      audioStreams: 0,
      subtitleStreams: 0,
      frameTypesReady: true,
      engine: decoded.engine,
      metadata: [
        ["File name", evidence.name],
        ["Format", decoded.format.toUpperCase()],
        ["Stored depth", `${decoded.depth}-bit`],
        ["Dimensions", `${decoded.frame.w} × ${decoded.frame.h} px`],
        ["Decoder", decoded.engine],
        ["MD5", evidence.md5],
        ["SHA-1", evidence.sha1],
        ["SHA-256", evidence.sha256],
      ],
    });
    if (decoded.colorType !== undefined) this.info.metadata.push(["PNG colour type", String(decoded.colorType)]);
    for (const w of decoded.warnings) this.info.warnings.push(w);
  }

  async getFrame(_i: number): Promise<Frame> { return this.frame; }
  meta(i: number): FrameMeta { return { type: "I", key: true, pts: 0, src: i }; }
  dispose() { /* the decoded frame is released with the source */ }
}
