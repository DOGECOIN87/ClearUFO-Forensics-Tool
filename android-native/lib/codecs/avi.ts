// AVI muxer with OpenDML (AVI 2.0) support, streaming to a ByteSink.
//
// Layout (the same structure FFmpeg and VirtualDub write):
//   RIFF 'AVI '  hdrl [avih, strl [strh, strf, indx], odml [dmlh]]  movi [frames…, ix00]  idx1
//   RIFF 'AVIX'  movi [frames…, ix00]          ← one more segment per ~1 GB
// Every segment has a standard index (ix00) listed in the super index (indx). The first segment also
// gets a legacy idx1 so AVI 1.0 readers can play it. Segments stay below 1 GB, so files of any size work
// (up to `maxSegments` GB).
import type { ByteSink } from "./sink";

/** Frame rate as an exact rational (rate / scale), recognising NTSC rates such as 30000/1001. */
export function fpsRational(fps: number): [rate: number, scale: number] {
  if (!(fps > 0) || !Number.isFinite(fps)) return [25, 1];
  for (const base of [24, 30, 48, 60, 120, 240]) if (Math.abs(fps - (base * 1000) / 1001) < 5e-4) return [base * 1000, 1001];
  if (Math.abs(fps - Math.round(fps)) < 1e-6) return [Math.round(fps), 1];
  const scale = 1000, rate = Math.round(fps * scale);
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(rate, scale);
  return [rate / g, scale / g];
}

export interface AviOptions {
  width: number;
  height: number;
  fps: number;
  /** "raw24": uncompressed bottom-up BGR (DIB, BI_RGB). "mjpeg": one JPEG per frame (lossy). */
  codec: "raw24" | "mjpeg";
  /** Maximum size of one RIFF segment (default ~1 GB, like FFmpeg). */
  segmentBytes?: number;
  /** Super-index capacity: the file may have at most this many segments. */
  maxSegments?: number;
}

interface Segment { riffAt: number; moviAt: number; chunks: { at: number; size: number }[] }

const enc = new TextEncoder();
const AVIF_HASINDEX = 0x10, AVIF_ISINTERLEAVED = 0x100, AVIF_TRUSTCKTYPE = 0x800, AVIIF_KEYFRAME = 0x10;

function setU64(dv: DataView, o: number, v: number) { dv.setUint32(o, v % 0x100000000, true); dv.setUint32(o + 4, Math.floor(v / 0x100000000), true); }

export class AviWriter {
  static readonly SEGMENT = 1_000_000_000;
  private seg!: Segment;
  private first: { frames: number; riffSize: number; moviSize: number } | null = null;
  private superIndex: { at: number; size: number; frames: number }[] = [];
  private frames = 0;
  private maxChunk = 0;
  private headerSize = 0;
  private tag: string;
  private segBytes: number;
  private maxSeg: number;
  private finished = false;

  constructor(private sink: ByteSink, private o: AviOptions) {
    this.tag = o.codec === "mjpeg" ? "00dc" : "00db";
    this.segBytes = Math.max(64 * 1024, Math.min(o.segmentBytes ?? AviWriter.SEGMENT, 0xfff00000));
    this.maxSeg = Math.max(1, o.maxSegments ?? 256);
  }

  get frameCount() { return this.frames; }
  get bytes() { return this.sink.pos; }
  /** The frame rate can change until finish() (live capture measures it while recording). */
  setFps(fps: number) { this.o.fps = fps; }

  /** Bytes of one uncompressed frame (DIB rows padded to 4 bytes). */
  static rawFrameBytes(w: number, h: number) { return ((w * 3 + 3) & ~3) * h; }

  /** Exact file size of an uncompressed AVI with `frames` frames (same segmenting as add()). */
  static rawFileSize(w: number, h: number, frames: number, o: { segmentBytes?: number; maxSegments?: number } = {}): number {
    const seg = Math.max(64 * 1024, Math.min(o.segmentBytes ?? AviWriter.SEGMENT, 0xfff00000));
    const hdr = AviWriter.headerBytes(Math.max(1, o.maxSegments ?? 256));
    const chunk = 8 + AviWriter.rawFrameBytes(w, h);
    let pos = hdr, riffAt = 0, n = 0, first = true, left = frames;
    while (left > 0) {
      const projected = pos + chunk - riffAt + 32 + 8 * (n + 1) + (first ? 8 + 16 * (n + 1) : 0);
      if (n > 0 && projected > seg) {
        pos += 32 + 8 * n + (first ? 8 + 16 * n : 0);
        first = false; riffAt = pos; pos += 24; n = 0;
      }
      pos += chunk; n++; left--;
    }
    return pos + 32 + 8 * n + (first ? 8 + 16 * n : 0);
  }

  private static headerBytes(maxSeg: number) {
    // RIFF+AVI (12) + LIST hdrl (12) + avih (64) + LIST strl (12) + strh (64) + strf (48)
    // + indx (8 + 24 + 16·N) + LIST odml (12) + dmlh (256) + LIST movi (12)
    return 12 + 12 + 64 + 12 + 64 + 48 + 8 + 24 + 16 * maxSeg + 12 + 256 + 12;
  }

  async begin() {
    this.headerSize = AviWriter.headerBytes(this.maxSeg);
    const at = await this.sink.reserve(this.headerSize);
    if (at !== 0) throw new Error("Internal error: the AVI header must start the file");
    this.seg = { riffAt: 0, moviAt: this.headerSize - 4, chunks: [] };
  }

  private ixBytes(n: number) { return 32 + 8 * n; }
  private idx1Bytes(n: number) { return 8 + 16 * n; }

  async add(data: Uint8Array) {
    if (this.finished) throw new Error("The AVI file is already finished");
    if (!this.headerSize) await this.begin();
    const pad = data.length & 1, chunk = 8 + data.length + pad;
    const n = this.seg.chunks.length;
    const projected = this.sink.pos + chunk - this.seg.riffAt + this.ixBytes(n + 1) + (this.first ? 0 : this.idx1Bytes(n + 1));
    if (n > 0 && projected > this.segBytes) { await this.closeSegment(); await this.openSegment(); }
    const hdr = new Uint8Array(8);
    hdr.set(enc.encode(this.tag));
    new DataView(hdr.buffer).setUint32(4, data.length, true);
    const at = this.sink.pos;
    await this.sink.write(hdr);
    await this.sink.write(data);
    if (pad) await this.sink.write(new Uint8Array(1));
    this.seg.chunks.push({ at, size: data.length });
    this.frames++;
    if (data.length > this.maxChunk) this.maxChunk = data.length;
  }

  private async openSegment() {
    if (this.superIndex.length >= this.maxSeg) throw new Error(`The AVI file would exceed ${this.maxSeg} segments (about ${Math.round((this.maxSeg * this.segBytes) / 1e9)} GB)`);
    const riffAt = await this.sink.reserve(24);
    this.seg = { riffAt, moviAt: riffAt + 20, chunks: [] };
  }

  private async closeSegment() {
    const s = this.seg, n = s.chunks.length;
    // standard index (ix00) at the end of the movi list
    const ix = new Uint8Array(this.ixBytes(n)), dv = new DataView(ix.buffer);
    ix.set(enc.encode("ix00"), 0); dv.setUint32(4, ix.length - 8, true);
    dv.setUint16(8, 2, true);   // wLongsPerEntry
    ix[10] = 0;                 // bIndexSubType
    ix[11] = 1;                 // bIndexType = AVI_INDEX_OF_CHUNKS
    dv.setUint32(12, n, true);  // nEntriesInUse
    ix.set(enc.encode(this.tag), 16);
    setU64(dv, 20, s.moviAt);   // qwBaseOffset
    dv.setUint32(28, 0, true);
    s.chunks.forEach((c, i) => { dv.setUint32(32 + i * 8, c.at + 8 - s.moviAt, true); dv.setUint32(36 + i * 8, c.size, true); });
    const ixAt = this.sink.pos;
    await this.sink.write(ix);
    this.superIndex.push({ at: ixAt, size: ix.length, frames: n });
    const moviSize = this.sink.pos - s.moviAt;
    if (!this.first) {
      // legacy AVI 1.0 index for the first segment; offsets are relative to the 'movi' fourcc
      const idx = new Uint8Array(this.idx1Bytes(n)), iv = new DataView(idx.buffer);
      idx.set(enc.encode("idx1"), 0); iv.setUint32(4, idx.length - 8, true);
      s.chunks.forEach((c, i) => {
        const e = 8 + i * 16;
        idx.set(enc.encode(this.tag), e); iv.setUint32(e + 4, AVIIF_KEYFRAME, true);
        iv.setUint32(e + 8, c.at - s.moviAt, true); iv.setUint32(e + 12, c.size, true);
      });
      await this.sink.write(idx);
      this.first = { frames: n, riffSize: this.sink.pos - 8, moviSize };
    } else {
      const h = new Uint8Array(24), hv = new DataView(h.buffer);
      h.set(enc.encode("RIFF"), 0); hv.setUint32(4, this.sink.pos - s.riffAt - 8, true); h.set(enc.encode("AVIX"), 8);
      h.set(enc.encode("LIST"), 12); hv.setUint32(16, moviSize, true); h.set(enc.encode("movi"), 20);
      await this.sink.patch(s.riffAt, h);
    }
  }

  private header(): Uint8Array {
    const { width: w, height: h } = this.o;
    const [rate, scale] = fpsRational(this.o.fps);
    const fps = rate / scale;
    const b = new Uint8Array(this.headerSize), dv = new DataView(b.buffer);
    let p = 0;
    const fourcc = (s: string) => { b.set(enc.encode(s), p); p += 4; };
    const u32 = (v: number) => { dv.setUint32(p, v >>> 0, true); p += 4; };
    const u16 = (v: number) => { dv.setUint16(p, v, true); p += 2; };
    const strlSize = 4 + 64 + 48 + 8 + 24 + 16 * this.maxSeg;
    const hdrlSize = 4 + 64 + (8 + strlSize) + (12 + 256);
    const first = this.first!;
    fourcc("RIFF"); u32(first.riffSize); fourcc("AVI ");
    fourcc("LIST"); u32(hdrlSize); fourcc("hdrl");
    // avih (MainAVIHeader)
    fourcc("avih"); u32(56);
    u32(Math.round((1e6 * scale) / rate));        // dwMicroSecPerFrame
    u32(Math.min(0xffffffff, Math.ceil((this.maxChunk + 8) * fps))); // dwMaxBytesPerSec
    u32(0);                                       // dwPaddingGranularity
    u32(AVIF_HASINDEX | AVIF_ISINTERLEAVED | AVIF_TRUSTCKTYPE);
    u32(first.frames);                            // dwTotalFrames (first RIFF, per OpenDML)
    u32(0);                                       // dwInitialFrames
    u32(1);                                       // dwStreams
    u32(this.maxChunk + 8);                       // dwSuggestedBufferSize
    u32(w); u32(h);
    p += 16;                                      // dwReserved[4]
    fourcc("LIST"); u32(strlSize); fourcc("strl");
    // strh (AVIStreamHeader)
    fourcc("strh"); u32(56);
    fourcc("vids"); fourcc(this.o.codec === "mjpeg" ? "MJPG" : "DIB ");
    u32(0); u16(0); u16(0); u32(0);               // dwFlags, wPriority, wLanguage, dwInitialFrames
    u32(scale); u32(rate); u32(0);                // dwScale, dwRate, dwStart
    u32(this.frames);                             // dwLength (all frames)
    u32(this.maxChunk);                           // dwSuggestedBufferSize
    u32(0xffffffff);                              // dwQuality: default
    u32(0);                                       // dwSampleSize
    u16(0); u16(0); u16(Math.min(w, 0xffff)); u16(Math.min(h, 0xffff)); // rcFrame
    // strf (BITMAPINFOHEADER)
    fourcc("strf"); u32(40);
    u32(40); u32(w); u32(h);                      // positive height: bottom-up rows
    u16(1); u16(24);
    if (this.o.codec === "mjpeg") fourcc("MJPG"); else u32(0); // BI_RGB
    u32(this.o.codec === "mjpeg" ? this.maxChunk : AviWriter.rawFrameBytes(w, h));
    u32(0); u32(0); u32(0); u32(0);
    // indx (AVISUPERINDEX)
    fourcc("indx"); u32(24 + 16 * this.maxSeg);
    u16(4); b[p++] = 0; b[p++] = 0;               // wLongsPerEntry, bIndexSubType, bIndexType = AVI_INDEX_OF_INDEXES
    u32(this.superIndex.length);
    fourcc(this.tag);
    p += 12;                                      // dwReserved[3]
    for (const e of this.superIndex) { setU64(dv, p, e.at); p += 8; u32(e.size); u32(e.frames); }
    p += 16 * (this.maxSeg - this.superIndex.length);
    // odml / dmlh (total frames of the whole file)
    fourcc("LIST"); u32(4 + 256); fourcc("odml");
    fourcc("dmlh"); u32(248); u32(this.frames); p += 244;
    fourcc("LIST"); u32(first.moviSize); fourcc("movi");
    if (p !== this.headerSize) throw new Error("Internal error: AVI header size mismatch");
    return b;
  }

  async finish() {
    if (this.finished) return;
    if (!this.frames) throw new Error("No frames were written");
    await this.closeSegment();
    await this.sink.patch(0, this.header());
    this.finished = true;
  }
}
