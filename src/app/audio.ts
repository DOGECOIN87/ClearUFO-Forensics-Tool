// Audio: waveform peaks and streamed playback of the source audio track (Mediabunny + Web Audio).
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import { Emitter } from "../ui/dom";

interface Loaded { sourceId: string; input: Input; sink: AudioBufferSink; duration: number; peaks: Float32Array; ready: boolean }

export class AudioEngine extends Emitter<{ peaks: [string] }> {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private loaded = new Map<string, Promise<Loaded | null>>();
  private current: Loaded | null = null;
  private token = 0;
  private nodes: AudioBufferSourceNode[] = [];
  volume = 0.8;
  muted = false;

  async load(sourceId: string, file: File): Promise<Loaded | null> {
    let p = this.loaded.get(sourceId);
    if (!p) {
      p = (async () => {
        try {
          const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
          const track = await input.getPrimaryAudioTrack();
          if (!track || !(await track.canDecode())) return null;
          const duration = await track.computeDuration();
          const L: Loaded = { sourceId, input, sink: new AudioBufferSink(track), duration, peaks: new Float32Array(4096 * 2), ready: false };
          void this.computePeaks(L);
          return L;
        } catch { return null; }
      })();
      this.loaded.set(sourceId, p);
    }
    return p;
  }

  private async computePeaks(L: Loaded) {
    const N = L.peaks.length / 2;
    const pk = L.peaks;
    for (let i = 0; i < N; i++) { pk[i * 2] = 0; pk[i * 2 + 1] = 0; }
    let k = 0;
    try {
      for await (const wb of L.sink.buffers()) {
        const b = wb.buffer, ch = b.getChannelData(0), sr = b.sampleRate;
        for (let i = 0; i < ch.length; i += 4) {
          const t = wb.timestamp + i / sr;
          const bin = Math.min(N - 1, Math.max(0, Math.floor((t / L.duration) * N)));
          const v = ch[i];
          if (v < pk[bin * 2]) pk[bin * 2] = v;
          if (v > pk[bin * 2 + 1]) pk[bin * 2 + 1] = v;
        }
        if (++k % 40 === 0) { this.emit("peaks", L.sourceId); await new Promise((r) => setTimeout(r, 0)); }
      }
    } catch { /* partial waveform */ }
    L.ready = true;
    this.emit("peaks", L.sourceId);
  }

  async peaksFor(sourceId: string): Promise<{ peaks: Float32Array; duration: number } | null> {
    const p = this.loaded.get(sourceId);
    if (!p) return null;
    const L = await p;
    return L ? { peaks: L.peaks, duration: L.duration } : null;
  }

  private ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    this.gain!.gain.value = this.muted ? 0 : this.volume;
    return this.ctx;
  }

  setVolume(v: number, muted: boolean) {
    this.volume = v; this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : v;
  }

  async play(sourceId: string, t: number, speed: number) {
    this.stop();
    if (this.muted || Math.abs(speed - 1) > 1e-3) return;
    const p = this.loaded.get(sourceId);
    if (!p) return;
    const L = await p;
    if (!L) return;
    this.current = L;
    const token = ++this.token;
    const ctx = this.ensure();
    try { await ctx.resume(); } catch { return; }
    const start = ctx.currentTime + 0.06;
    try {
      for await (const wb of L.sink.buffers(Math.max(0, t))) {
        if (token !== this.token) break;
        const node = ctx.createBufferSource();
        node.buffer = wb.buffer;
        node.connect(this.gain!);
        const when = start + (wb.timestamp - t);
        if (when < ctx.currentTime) { const off = ctx.currentTime - when; if (off < wb.buffer.duration) node.start(ctx.currentTime, off); else continue; }
        else node.start(when);
        this.nodes.push(node);
        node.onended = () => { this.nodes = this.nodes.filter((n) => n !== node); };
        while (token === this.token && when - ctx.currentTime > 1.5) await new Promise((r) => setTimeout(r, 120));
      }
    } catch { /* stream ended */ }
  }

  stop() {
    this.token++;
    for (const n of this.nodes) { try { n.stop(); } catch { /* ignore */ } }
    this.nodes = [];
  }
}
