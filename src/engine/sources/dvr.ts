// "Convert DVR": recovers the video elementary stream from proprietary CCTV/DVR files
// (Hikvision/MPEG-PS, Dahua DHAV, raw H.264/H.265 Annex B, concatenated MJPEG) and
// remuxes it, without re-encoding, into a standard MP4 that can be decoded frame-accurately.
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from "mediabunny";
import type { DvrScanResult, FrameType } from "../../shared/types";
import {
  avcCodecString, buildAvcC, buildHvcC, FRAME_TYPE_CODE, hevcCodecString, parseH264Pps, parseH264Slice, parseH264Sps,
  parseHevcPps, parseHevcSlice, parseHevcSps, splitAnnexB, type H264Pps, type H264Slice, type H264Sps, type HevcPps, type HevcSlice, type HevcSps,
} from "./bitstream";

export interface DvrOptions { codec: "auto" | "h264" | "hevc"; fps: number; container: "auto" | "raw" | "ps" | "dhav" }

interface AU { nals: Uint8Array[]; key: boolean; type: FrameType; poc: number; period: number; h264?: H264Slice; hevc?: HevcSlice }

const asc = (d: Uint8Array, o: number, n: number) => String.fromCharCode(...d.subarray(o, o + n));

function indexOfSeq(d: Uint8Array, seq: number[], from: number, to = d.length): number {
  const last = Math.min(to, d.length) - seq.length;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    for (let k = 0; k < seq.length; k++) if (d[i + k] !== seq[k]) continue outer;
    return i;
  }
  return -1;
}

export function detectContainer(head: Uint8Array): "ps" | "dhav" | "raw" | "mjpeg" {
  if (asc(head, 0, 4) === "IMKH") return "ps";
  const lim = Math.min(head.length, 65536);
  if (indexOfSeq(head, [0x44, 0x48, 0x41, 0x56], 0, lim) >= 0) return "dhav";
  const ba = indexOfSeq(head, [0, 0, 1, 0xba], 0, lim);
  if (ba >= 0 && ba < 4096) return "ps";
  let soi = 0;
  for (let i = 0; i + 3 < lim; i++) if (head[i] === 0xff && head[i + 1] === 0xd8 && head[i + 2] === 0xff) soi++;
  if (head[0] === 0xff && head[1] === 0xd8 && soi >= 2) return "mjpeg";
  return "raw";
}

function demuxPs(d: Uint8Array, notes: string[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let p = asc(d, 0, 4) === "IMKH" ? 40 : 0;
  const n = d.length;
  let resyncs = 0;
  const resync = (from: number) => {
    for (let i = from; i + 3 < n; i++) if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1 && (d[i + 3] === 0xba || (d[i + 3] >= 0xbb && d[i + 3] <= 0xef))) return i;
    return -1;
  };
  while (p + 6 <= n) {
    if (!(d[p] === 0 && d[p + 1] === 0 && d[p + 2] === 1)) { resyncs++; p = resync(p + 1); if (p < 0) break; continue; }
    const id = d[p + 3];
    if (id === 0xba) {
      if ((d[p + 4] & 0xc0) === 0x40) p += 14 + (d[p + 13] & 7); else p += 12;
      continue;
    }
    if (id === 0xb9) { p += 4; continue; }
    if (id >= 0xbb) {
      const len = (d[p + 4] << 8) | d[p + 5];
      const end = p + 6 + len;
      if (id >= 0xe0 && id <= 0xef) {
        let h = p + 6;
        if ((d[h] & 0xc0) === 0x80) h += 3 + d[h + 2];
        else {
          while (d[h] === 0xff && h < end) h++;
          if ((d[h] & 0xc0) === 0x40) h += 2;
          if ((d[h] & 0xf0) === 0x20) h += 5; else if ((d[h] & 0xf0) === 0x30) h += 10; else h++;
        }
        if (h < end) out.push(d.subarray(h, Math.min(end, n)));
      }
      p = end;
      continue;
    }
    resyncs++;
    p = resync(p + 1);
    if (p < 0) break;
  }
  if (resyncs) notes.push(`Program stream: ${resyncs} resynchronizations (proprietary data skipped)`);
  return out;
}

function demuxDhav(d: Uint8Array, notes: string[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  const SIG = [0x44, 0x48, 0x41, 0x56];
  let p = indexOfSeq(d, SIG, 0);
  let frames = 0, audio = 0, bad = 0;
  while (p >= 0 && p + 24 <= d.length) {
    const type = d[p + 4];
    const len = d[p + 12] | (d[p + 13] << 8) | (d[p + 14] << 16) | (d[p + 15] << 24);
    const ext = d[p + 22];
    if (len < 32 || p + len > d.length) { bad++; p = indexOfSeq(d, SIG, p + 4); continue; }
    const t = p + len - 8;
    const trailer = d[t] === 0x64 && d[t + 1] === 0x68 && d[t + 2] === 0x61 && d[t + 3] === 0x76;
    if (type === 0xfd || type === 0xfc || type === 0xfb) {
      const s = p + 24 + ext, e = trailer ? t : p + len;
      if (e > s) { out.push(d.subarray(s, e)); frames++; }
    } else if (type === 0xf0) audio++;
    p = trailer ? p + len : indexOfSeq(d, SIG, p + 4);
    if (!trailer) bad++;
  }
  notes.push(`DHAV: ${frames} video frames, ${audio} audio frames${bad ? `, ${bad} damaged headers` : ""}`);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function detectCodec(nals: Uint8Array[]): "h264" | "hevc" | "unknown" {
  let h264 = 0, hevc = 0;
  const lim = Math.min(nals.length, 4000);
  for (let i = 0; i < lim; i++) {
    const n = nals[i];
    if (n.length < 2 || n[0] & 0x80) continue;
    const t4 = n[0] & 0x1f;
    if (t4 === 7 && n.length > 3 && [66, 77, 88, 100, 110, 122, 244, 44, 118, 128].includes(n[1])) h264 += 20;
    else if (t4 === 5 || t4 === 8) h264 += 2;
    else if (t4 === 1 && ((n[0] >> 5) & 3) !== 0) h264 += 1;
    const t5 = (n[0] >> 1) & 0x3f, layer = ((n[0] & 1) << 5) | (n[1] >> 3), tid = n[1] & 7;
    if (layer === 0 && tid !== 0) {
      if (t5 === 32 || t5 === 33 || t5 === 34) hevc += 20;
      else if (t5 === 19 || t5 === 20 || t5 === 21) hevc += 2;
      else if (t5 === 1) hevc += 1;
    }
  }
  if (h264 === 0 && hevc === 0) return "unknown";
  return h264 >= hevc ? "h264" : "hevc";
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

function buildH264(nals: Uint8Array[], notes: string[]) {
  const spsMap = new Map<number, H264Sps>(), ppsMap = new Map<number, H264Pps>();
  let spsNal: Uint8Array | null = null;
  const ppsNals: Uint8Array[] = [];
  const aus: AU[] = [];
  let cur: AU | null = null, seenVcl = false, skipped = 0;
  const close = () => { if (cur && seenVcl) aus.push(cur); cur = null; seenVcl = false; };
  for (const n of nals) {
    if (!n.length || n[0] & 0x80) { skipped++; continue; }
    const t = n[0] & 0x1f;
    if (t === 0 || t > 23) { skipped++; continue; }
    if (t === 7) { try { const s = parseH264Sps(n); spsMap.set(s.id, s); if (!spsNal) spsNal = n; } catch { skipped++; continue; } }
    if (t === 8) { try { const s = parseH264Pps(n); ppsMap.set(s.id, s); if (!ppsNals.some((p) => sameBytes(p, n))) ppsNals.push(n); } catch { skipped++; continue; } }
    if ((t === 9 || t === 7 || t === 8 || t === 6 || (t >= 14 && t <= 18)) && seenVcl) close();
    if (t === 1 || t === 5) {
      let sl: H264Slice | null = null;
      try { sl = parseH264Slice(n, spsMap, ppsMap); } catch { sl = null; }
      if (seenVcl && sl && sl.firstMb === 0) close();
      if (!cur) cur = { nals: [], key: false, type: "?", poc: 0, period: 0 };
      if (!cur.h264 && sl) { cur.h264 = sl; cur.type = t === 5 ? "I" : sl.type; }
      if (t === 5) cur.key = true;
      seenVcl = true;
    }
    if (!cur) cur = { nals: [], key: false, type: "?", poc: 0, period: 0 };
    cur.nals.push(n);
  }
  close();
  if (skipped) notes.push(`${skipped} invalid or reserved NAL units discarded`);
  // merge complementary field pairs (PAFF interlaced streams) into one frame
  const merged: AU[] = [];
  let pairs = 0;
  for (let i = 0; i < aus.length; i++) {
    const a = aus[i], b = aus[i + 1];
    if (a.h264?.field && b?.h264?.field && a.h264.bottom !== b.h264.bottom && a.h264.frameNum === b.h264.frameNum) {
      a.nals.push(...b.nals);
      if (b.key) a.key = true;
      i++;
      pairs++;
    }
    merged.push(a);
  }
  if (pairs) notes.push(`Interlaced field coding (PAFF): ${pairs} field pairs merged into frames`);
  if (!merged.some((a) => a.key)) {
    notes.push("No IDR frames found: I frames are used as random access points");
    for (const a of merged) if (a.type === "I") a.key = true;
  }
  // picture order count → presentation order
  const sps0 = spsNal ? parseH264Sps(spsNal) : null;
  let prevMsb = 0, prevLsb = 0, period = 0, ord = 0;
  for (const a of merged) {
    const s = a.h264;
    if (!s) continue;
    if (s.idr) { prevMsb = 0; prevLsb = 0; period++; ord = 0; }
    const pps = ppsMap.get(s.ppsId);
    const sps = (pps && spsMap.get(pps.spsId)) || sps0;
    if (sps && sps.pocType === 0) {
      const max = 2 ** sps.log2MaxPocLsb;
      let msb = prevMsb;
      if (s.pocLsb < prevLsb && prevLsb - s.pocLsb >= max / 2) msb = prevMsb + max;
      else if (s.pocLsb > prevLsb && s.pocLsb - prevLsb > max / 2) msb = prevMsb - max;
      a.poc = msb + s.pocLsb;
      if (s.refIdc !== 0) { prevMsb = msb; prevLsb = s.pocLsb; }
    } else a.poc = ord * 2;
    a.period = period;
    ord++;
  }
  return { aus: merged, spsNal, ppsNals, sps: sps0 };
}

function buildHevc(nals: Uint8Array[], notes: string[]) {
  const spsMap = new Map<number, HevcSps>(), ppsMap = new Map<number, HevcPps>();
  const vps: Uint8Array[] = [], spsN: Uint8Array[] = [], ppsN: Uint8Array[] = [];
  const aus: AU[] = [];
  let cur: AU | null = null, seenVcl = false, skipped = 0;
  const close = () => { if (cur && seenVcl) aus.push(cur); cur = null; seenVcl = false; };
  for (const n of nals) {
    if (n.length < 3 || n[0] & 0x80) { skipped++; continue; }
    const t = (n[0] >> 1) & 0x3f;
    const layer = ((n[0] & 1) << 5) | (n[1] >> 3);
    if (layer !== 0 || (n[1] & 7) === 0 || (t >= 41 && t <= 47) || t >= 48) { skipped++; continue; }
    try {
      if (t === 32 && !vps.some((p) => sameBytes(p, n))) vps.push(n);
      if (t === 33) { const s = parseHevcSps(n); spsMap.set(s.id, s); if (!spsN.some((p) => sameBytes(p, n))) spsN.push(n); }
      if (t === 34) { const s = parseHevcPps(n); ppsMap.set(s.id, s); if (!ppsN.some((p) => sameBytes(p, n))) ppsN.push(n); }
    } catch { skipped++; continue; }
    if ((t === 35 || t === 32 || t === 33 || t === 34 || t === 39) && seenVcl) close();
    if (t <= 31) {
      let sl: HevcSlice | null = null;
      try { sl = parseHevcSlice(n, spsMap, ppsMap); } catch { sl = null; }
      if (seenVcl && sl?.first) close();
      if (!cur) cur = { nals: [], key: false, type: "?", poc: 0, period: 0 };
      if (!cur.hevc && sl) { cur.hevc = sl; cur.type = sl.type; }
      if (t >= 16 && t <= 23) cur.key = true;
      seenVcl = true;
    }
    if (!cur) cur = { nals: [], key: false, type: "?", poc: 0, period: 0 };
    cur.nals.push(n);
  }
  close();
  if (skipped) notes.push(`${skipped} invalid, reserved or enhancement-layer NAL units discarded`);
  const sps0 = spsN.length ? parseHevcSps(spsN[0]) : null;
  let prevMsb = 0, prevLsb = 0, period = 0;
  for (const a of aus) {
    const s = a.hevc;
    if (!s || !sps0) continue;
    const max = 2 ** sps0.log2MaxPocLsb;
    if (s.idr || (s.irap && s.nalType <= 18)) { period++; prevMsb = 0; prevLsb = 0; }
    let msb = prevMsb;
    if (s.idr) { a.poc = 0; msb = 0; }
    else {
      if (s.pocLsb < prevLsb && prevLsb - s.pocLsb >= max / 2) msb = prevMsb + max;
      else if (s.pocLsb > prevLsb && s.pocLsb - prevLsb > max / 2) msb = prevMsb - max;
      a.poc = msb + s.pocLsb;
    }
    const t = s.nalType;
    if (s.tid === 0 && !(t >= 6 && t <= 9) && (t % 2 === 1 || t >= 16)) { prevMsb = msb; prevLsb = s.idr ? 0 : s.pocLsb; }
    a.period = period;
  }
  return { aus, vps, spsN, ppsN, sps: sps0 };
}

function toLengthPrefixed(nals: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const n of nals) len += 4 + n.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const n of nals) {
    out[o] = (n.length >>> 24) & 255; out[o + 1] = (n.length >>> 16) & 255; out[o + 2] = (n.length >>> 8) & 255; out[o + 3] = n.length & 255;
    out.set(n, o + 4);
    o += 4 + n.length;
  }
  return out;
}

export interface DvrResult {
  scan: DvrScanResult;
  mp4?: ArrayBuffer;
  types?: Uint8Array; // presentation order
  mjpegFrames?: Uint8Array[];
}

/** Scan and convert. `data` is the complete file. */
export async function convertDvr(data: Uint8Array, opts: DvrOptions, progress: (label: string, v: number) => void): Promise<DvrResult> {
  const notes: string[] = [];
  const cont = opts.container === "auto" ? detectContainer(data.subarray(0, 1 << 20)) : opts.container;
  if (cont === "mjpeg") {
    const frames: Uint8Array[] = [];
    let p = 0;
    while (p < data.length) {
      const s = indexOfSeq(data, [0xff, 0xd8, 0xff], p);
      if (s < 0) break;
      let e = indexOfSeq(data, [0xff, 0xd8, 0xff], s + 3);
      if (e < 0) e = data.length;
      frames.push(data.subarray(s, e));
      p = e;
      if (frames.length % 500 === 0) progress("Scanning MJPEG stream", p / data.length);
    }
    return { scan: { container: "Concatenated Motion JPEG", codec: "unknown", nalCount: 0, frames: frames.length, width: 0, height: 0, fps: opts.fps || 25, notes: [`${frames.length} JPEG images found`] }, mjpegFrames: frames };
  }
  progress("Extracting elementary stream", 0.05);
  let es: Uint8Array;
  let containerName: string;
  if (cont === "ps") { es = concat(demuxPs(data, notes)); containerName = asc(data, 0, 4) === "IMKH" ? "Hikvision (MPEG Program Stream)" : "MPEG Program Stream"; }
  else if (cont === "dhav") { es = concat(demuxDhav(data, notes)); containerName = "Dahua DAV (DHAV)"; }
  else { es = data; containerName = "Raw elementary stream / unknown container"; }
  progress("Parsing NAL units", 0.25);
  const nals = splitAnnexB(es);
  if (!nals.length) throw new Error("No H.264/H.265 data was found in the file");
  const codec = opts.codec === "auto" ? detectCodec(nals) : opts.codec;
  if (codec === "unknown") throw new Error("Unable to identify an H.264 or H.265 stream in the file");
  progress("Rebuilding frames", 0.4);

  let aus: AU[], decoderConfig: VideoDecoderConfig, width = 0, height = 0, fps = opts.fps || 0;
  if (codec === "h264") {
    const r = buildH264(nals, notes);
    if (!r.spsNal || !r.ppsNals.length || !r.sps) throw new Error("H.264 parameter sets (SPS/PPS) not found");
    aus = r.aus;
    width = r.sps.width; height = r.sps.height;
    if (!fps && r.sps.fps) { fps = r.sps.fps; notes.push(`Frame rate from SPS timing info: ${fps.toFixed(3)}`); }
    decoderConfig = { codec: avcCodecString(r.spsNal), codedWidth: width, codedHeight: height, description: buildAvcC(r.spsNal, r.ppsNals, r.sps) };
    const strip = [r.spsNal, ...r.ppsNals];
    for (const a of aus) a.nals = a.nals.filter((n) => { const t = n[0] & 0x1f; return t !== 9 && t !== 12 && !((t === 7 || t === 8) && strip.some((s) => sameBytes(s, n))); });
    notes.push(`H.264 profile ${r.sps.profile}, level ${(r.sps.level / 10).toFixed(1)}, ${r.sps.frameMbsOnly ? "progressive" : "interlaced capable"}, SAR ${r.sps.sar[0]}:${r.sps.sar[1]}`);
  } else {
    const r = buildHevc(nals, notes);
    if (!r.spsN.length || !r.ppsN.length || !r.sps) throw new Error("H.265 parameter sets (VPS/SPS/PPS) not found");
    aus = r.aus;
    width = r.sps.width; height = r.sps.height;
    decoderConfig = { codec: hevcCodecString(r.sps), codedWidth: width, codedHeight: height, description: buildHvcC(r.vps, r.spsN, r.ppsN, r.sps) };
    const strip = [...r.vps, ...r.spsN, ...r.ppsN];
    for (const a of aus) a.nals = a.nals.filter((n) => { const t = (n[0] >> 1) & 0x3f; return t !== 35 && t !== 38 && !(t >= 32 && t <= 34 && strip.some((s) => sameBytes(s, n))); });
    notes.push(`H.265 ${r.sps.bitDepth}-bit, chroma format ${r.sps.chromaFormat}`);
  }
  if (!fps) { fps = 25; notes.push("No timing information in the stream: 25 fps assumed (change it in Convert DVR settings)"); }
  const firstKey = aus.findIndex((a) => a.key);
  if (firstKey < 0) throw new Error("No decodable key frame found");
  if (firstKey > 0) notes.push(`${firstKey} frames before the first key frame were dropped (not decodable)`);
  aus = aus.slice(firstKey);

  // presentation order: sort by (period, poc) when B frames exist
  const hasB = aus.some((a) => a.type === "B");
  const order = aus.map((_, i) => i);
  if (hasB) {
    order.sort((x, y) => aus[x].period - aus[y].period || aus[x].poc - aus[y].poc || x - y);
    notes.push("B frames present: presentation order derived from picture order count");
  }
  const presIndex = new Int32Array(aus.length);
  order.forEach((decIdx, pres) => { presIndex[decIdx] = pres; });
  const types = new Uint8Array(aus.length);
  aus.forEach((a, d) => { types[presIndex[d]] = FRAME_TYPE_CODE[a.type] ?? 0; });

  progress("Writing MP4 container", 0.5);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const src = new EncodedVideoPacketSource(codec === "h264" ? "avc" : "hevc");
  output.addVideoTrack(src, { frameRate: fps });
  await output.start();
  for (let d = 0; d < aus.length; d++) {
    const pkt = new EncodedPacket(toLengthPrefixed(aus[d].nals), aus[d].key ? "key" : "delta", presIndex[d] / fps, 1 / fps);
    await src.add(pkt, d === 0 ? { decoderConfig } : undefined);
    if (d % 200 === 0) progress("Writing MP4 container", 0.5 + 0.45 * (d / aus.length));
  }
  await output.finalize();
  const mp4 = (output.target as BufferTarget).buffer!;
  const counts = [0, 0, 0, 0];
  for (const t of types) counts[t]++;
  notes.push(`Frames: ${aus.length} (I: ${counts[1]}, P: ${counts[2]}, B: ${counts[3]})`);
  return { scan: { container: containerName, codec, nalCount: nals.length, frames: aus.length, width, height, fps, notes }, mp4, types };
}
