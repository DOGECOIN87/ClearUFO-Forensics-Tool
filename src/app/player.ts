// Playback controller: real-time playback with frame dropping (or every frame), stepping, In/Out range.
import type { AudioEngine } from "./audio";
import type { Store } from "./store";
import { Emitter } from "../ui/dom";

/** Playback speed range: 0.01× (one hundredth of real time) to 16×. */
export const SPEED_MIN = 0.01, SPEED_MAX = 16;
/** Presets of the speed menu and of the [ and ] shortcuts. */
export const SPEED_PRESETS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16];

/** Speed for display: "0.01", "0.125", "0.50", "1.0", "2.5", "16.0". */
export function fmtSpeed(v: number): string {
  if (v >= 1) { const r = +v.toFixed(2); return Number.isInteger(r) ? r.toFixed(1) : String(r); }
  const r = +v.toPrecision(3), s = String(r);
  return (s.split(".")[1]?.length ?? 0) < 2 ? r.toFixed(2) : s;
}

/** Slider positions snap to a preset within ±4 %, otherwise to two significant digits. */
export function snapSpeed(v: number): number {
  for (const p of SPEED_PRESETS) if (Math.abs(Math.log(v / p)) < 0.04) return p;
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, +v.toPrecision(2)));
}

export class Player extends Emitter<{ state: [] }> {
  playing = false;
  speed = 1;
  loop = false;
  stepSize = 1;
  unit: "frames" | "seconds" = "frames";
  playRange = false;
  private t0 = 0;
  private f0 = 0;
  private raf = 0;

  constructor(private store: Store, private audio: AudioEngine, private busy: () => boolean) { super(); }

  private info() { const id = this.store.ui.chainId; return id ? this.store.streamInfo.get(id) : undefined; }

  private range(): [number, number] {
    const info = this.info(), id = this.store.ui.chainId;
    const n = info?.frameCount ?? 1;
    const io = id ? this.store.ui.inOut[id] : undefined;
    if (this.playRange && io) return [io[0] ?? 0, io[1] ?? n - 1];
    return [0, n - 1];
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  play() {
    const info = this.info();
    if (!info || info.frameCount <= 1) return;
    const [a, b] = this.range();
    let f = this.store.frameOf();
    if (f >= b || f < a) { f = a; this.store.setFrame(f); }
    this.playing = true;
    this.f0 = f;
    this.t0 = performance.now();
    this.store.setUi({ playing: true });
    this.startAudio(f);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
    this.emit("state");
  }

  private startAudio(frame: number) {
    const c = this.store.chain();
    const sid = c?.filters[0]?.params?.source;
    const meta = this.store.lastRender?.meta;
    if (!sid) return;
    const fps = this.info()?.fps || 25;
    const t = meta?.pts !== undefined && this.store.lastRender?.frame === frame ? meta.pts : frame / fps;
    void this.audio.play(sid, t, this.speed);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.audio.stop();
    this.store.setUi({ playing: false });
    this.emit("state");
  }

  stop() { this.pause(); this.store.setFrame(this.range()[0]); }

  /** Stride of the last playback step (more than 1 when real-time playback drops frames). */
  private lastStep = 1;

  /** The frame playback will most likely show after `cur`, for the engine to compute ahead (none when paused). */
  predictNext(cur: number): number[] {
    if (!this.playing) return [];
    const [a, b] = this.range();
    const everyFrame = this.store.prefs.playAllFrames || this.speed < 1;
    let next = cur + (everyFrame ? 1 : Math.max(1, this.lastStep));
    if (next > b) { if (!this.loop) return []; next = a; }
    return next === cur ? [] : [next];
  }

  private tick = () => {
    if (!this.playing) return;
    const info = this.info();
    if (!info) { this.pause(); return; }
    const [a, b] = this.range();
    const fps = Math.max(1e-6, info.fps * this.speed);
    const cur = this.store.frameOf();
    const elapsed = (performance.now() - this.t0) / 1000;
    let target = this.f0 + Math.floor(elapsed * fps);
    // Slow motion is for examining every frame: below 1× frames are never skipped (if processing is slower
    // than the requested rate, playback waits for each frame instead). At 1× and above: the preference.
    if (this.store.prefs.playAllFrames || this.speed < 1) {
      if (target > cur + 1) { target = cur + 1; this.f0 = cur + 1; this.t0 = performance.now(); }
    }
    if (target > b) {
      if (this.loop) { this.f0 = a; this.t0 = performance.now(); target = a; this.startAudio(a); }
      else { this.store.setFrame(b); this.pause(); return; }
    }
    if (target !== cur && !this.busy()) { if (target > cur) this.lastStep = target - cur; this.store.setFrame(target); }
    this.raf = requestAnimationFrame(this.tick);
  };

  setSpeed(s: number) {
    if (!isFinite(s) || s <= 0) return;
    this.speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, s));
    if (this.playing) { this.f0 = this.store.frameOf(); this.t0 = performance.now(); this.startAudio(this.f0); }
    this.emit("state");
  }

  /** Next preset below / above the current speed ([ and ] keys). */
  slower() { const p = SPEED_PRESETS.filter((v) => v < this.speed - 1e-9); this.setSpeed(p.length ? p[p.length - 1] : SPEED_MIN); }
  faster() { this.setSpeed(SPEED_PRESETS.find((v) => v > this.speed + 1e-9) ?? SPEED_MAX); }

  stepBy(dir: number) {
    if (this.playing) this.pause();
    const fps = this.info()?.fps || 25;
    const n = this.unit === "seconds" ? Math.max(1, Math.round(this.stepSize * fps)) : Math.max(1, Math.round(this.stepSize));
    this.store.setFrame(this.store.frameOf() + dir * n);
  }

  first() { if (this.playing) this.pause(); this.store.setFrame(0); }
  last() { if (this.playing) this.pause(); this.store.setFrame((this.info()?.frameCount ?? 1) - 1); }

  setIn(v: number | null) { this.setIO(0, v); }
  setOut(v: number | null) { this.setIO(1, v); }
  private setIO(k: 0 | 1, v: number | null) {
    const id = this.store.ui.chainId;
    if (!id) return;
    const cur = this.store.ui.inOut[id] ?? [null, null];
    const next: [number | null, number | null] = [...cur] as any;
    next[k] = v;
    if (next[0] !== null && next[1] !== null && next[0] > next[1]) [next[0], next[1]] = [next[1], next[0]];
    this.store.ui.inOut = { ...this.store.ui.inOut, [id]: next };
    this.store.emit("ui", new Set(["inOut"]));
  }
}
