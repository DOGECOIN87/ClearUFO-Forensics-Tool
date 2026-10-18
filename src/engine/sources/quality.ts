// "Why does my video look worse than on my phone?" — facts about a loaded video that limit what can be seen,
// for File Info, the load messages and the assistant. Only what can be established from the file and the way
// this browser decodes it; nothing here changes pixels.
import type { SourceInfo } from "../../shared/types";

/** Bits per pixel below which a codec at typical settings is visibly starved (blocking, smearing, lost detail). */
const STARVED: Record<string, number> = { avc: 0.05, hevc: 0.03, vp9: 0.03, av1: 0.025, vp8: 0.06, mpeg4: 0.08, mjpeg: 0.4 };

export interface QualityNote { level: "warn" | "info"; text: string }

export function qualityNotes(info: SourceInfo): QualityNote[] {
  const out: QualityNote[] = [];
  const px = info.width * info.height, fps = info.fps || 25;
  if (info.bitrate && px && info.frameCount > 1) {
    const bpp = info.bitrate / (px * fps), codec = (info.codec ?? "").toLowerCase();
    if (bpp < (STARVED[codec] ?? 0.05))
      out.push({ level: "warn", text: `Heavily compressed file: ${(info.bitrate / 1e6).toFixed(2)} Mb/s for ${info.width}×${info.height} at ${fps.toFixed(fps % 1 ? 2 : 0)} fps is only ${bpp.toFixed(3)} bits per pixel. Blocking, smearing and missing fine detail are in the file itself; enhancement cannot restore them.` });
  }
  if (/^trim\.[0-9a-f-]{8,}/i.test(info.name))
    out.push({ level: "warn", text: `“${info.name}” is named like a copy that iOS re-encodes when a video is picked from the Photos library (“Compressing Video…”). The original has more detail: in Photos use Share › Save to Files, then choose the file in the browser with Browse.` });
  if (info.transfer === "pq" || info.transfer === "hlg")
    out.push({ level: "info", text: `HDR video (${info.transfer === "pq" ? "PQ / HDR10" : "HLG"}${info.colorPrimaries === "bt2020" ? ", BT.2020 colors" : ""}): ${info.browserConversion ? "this browser converts the frames to SDR itself." : "tone mapped to SDR for display and processing (Video Loader › HDR Video); choose “Signal values as decoded” to measure the raw values."}` });
  if (info.browserConversion && info.kind === "video")
    out.push({ level: "info", text: "This browser's decoder only hands out RGB frames for this video (usually a hardware decoder, as on phones): the browser converts the colors to 8-bit itself. Frames keep their full resolution; for the exact decoded samples use desktop Chrome or Edge, which have software decoders for H.264, VP9 and AV1." });
  return out;
}
