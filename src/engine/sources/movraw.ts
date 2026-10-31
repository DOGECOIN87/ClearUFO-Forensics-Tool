// Uncompressed QuickTime video ('b48r' and 'b64a' 16-bit RGB, 'raw ' 24-bit RGB, '2vuy' 4:2:2 YUV), read
// straight from the file without a decoder: 16-bit samples keep their full precision. The audio track, if
// any, is read through Mediabunny so exports can carry it on.
import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { BRAND } from "../../brand";
import { parseMov } from "../../shared/codecs/mov";
import { alloc, type Frame } from "../frame";
import { decodeRaw, FrameListSource } from "./avi";
import { audioFeedOf } from "./mbsource";
import { baseInfo, fmtBytes, type AudioFeed, type SourceProvider } from "./types";

const RAW = ["b48r", "b64a", "raw ", "2vuy"];

/** 16-bit big-endian RGB ('b48r') or ARGB ('b64a') → frame (0..65535 maps to 0..255). */
function decode16(b: Uint8Array, w: number, h: number, alpha: boolean): Frame {
  const f = alloc(w, h), d = f.d, px = alpha ? 8 : 6, stride = Math.floor(b.length / h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = y * stride + x * px + (alpha ? 2 : 0), o = (y * w + x) * 4;
    d[o] = ((b[s] << 8) | b[s + 1]) / 257; d[o + 1] = ((b[s + 2] << 8) | b[s + 3]) / 257; d[o + 2] = ((b[s + 4] << 8) | b[s + 5]) / 257;
  }
  return f;
}

function decode24(b: Uint8Array, w: number, h: number): Frame {
  const f = alloc(w, h), d = f.d, stride = Math.floor(b.length / h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = y * stride + x * 3, o = (y * w + x) * 4;
    d[o] = b[s]; d[o + 1] = b[s + 1]; d[o + 2] = b[s + 2];
  }
  return f;
}

/** True when the first bytes look like a QuickTime / ISO base media file. */
export function looksLikeMov(head: Uint8Array): boolean {
  const t = String.fromCharCode(...head.subarray(4, 8));
  return ["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(t);
}

/** Opens an uncompressed QuickTime file, or returns null for anything else (compressed codecs go to Mediabunny). */
export async function openRawMov(id: string, file: File): Promise<SourceProvider | null> {
  const m = await parseMov(file);
  if (!RAW.includes(m.codec) || !m.frames.length || !m.width || !m.height) return null;
  const { width: w, height: h } = m, fps = m.fps || 25;
  const info = baseInfo(id, file.name, "video");
  const label = { b48r: "Uncompressed RGB 16-bit (b48r)", b64a: "Uncompressed ARGB 16-bit (b64a)", "raw ": "Uncompressed RGB 8-bit (raw)", "2vuy": "Uncompressed YUV 4:2:2 8-bit (2vuy)" }[m.codec]!;
  Object.assign(info, { width: w, height: h, frameCount: m.frames.length, fps, duration: m.frames.length / fps, fileSize: file.size, container: "QuickTime (MOV)", codec: label, engine: "Built-in QuickTime demuxer (uncompressed)", videoStreams: 1, frameTypesReady: true, browserConversion: false });
  info.conversion = m.codec === "2vuy" ? `${BRAND.name}, from the uncompressed 4:2:2 samples (Color Matrix, Range and Chroma Filter of the Video Loader)` : `None: RGB samples read directly from the file${m.codec === "raw " ? "" : " at 16 bits per channel"}`;
  info.metadata = [["Container", "QuickTime (MOV)"], ["Codec", label], ["Frame Rate", fps.toFixed(3)], ["Size", fmtBytes(file.size)]];
  if (m.audio) {
    info.hasAudio = true; info.audioStreams = 1;
    info.audio = { codec: m.audio.codec.trim(), sampleRate: m.audio.sampleRate, channels: m.audio.channels };
  }
  const read = async (r: { off: number; size: number }) => new Uint8Array(await file.slice(r.off, r.off + r.size).arrayBuffer());
  const frames = m.frames.map((f) => ({ ...f, key: true }));
  const yuv = m.codec === "2vuy";
  const decode = async (b: Uint8Array, o?: Parameters<typeof decodeRaw>[5]) =>
    m.codec === "b48r" ? decode16(b, w, h, false) : m.codec === "b64a" ? decode16(b, w, h, true) : m.codec === "raw " ? decode24(b, w, h) : decodeRaw("uyvy", b, w, h, false, o);
  const provider = new FrameListSource(id, info, read, frames, decode, yuv) as SourceProvider;
  if (m.audio) provider.audioFeed = async (): Promise<AudioFeed | null> => {
    try { return await audioFeedOf(new Input({ source: new BlobSource(file), formats: ALL_FORMATS })); } catch { return null; }
  };
  return provider;
}
