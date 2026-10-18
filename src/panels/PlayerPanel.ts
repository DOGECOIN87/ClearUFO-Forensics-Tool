// Player: transport controls, frame/time entry, speed, volume, zoom readout, timeline and audio waveform.
import type { AppCtx } from "../app/context";
import type { AudioEngine } from "../app/audio";
import { checkBox, iconBtn, selectBox, slider, spinBox } from "../ui/controls";
import { fmtTime, h, parseTime, svg } from "../ui/dom";
import { capturePointer, touchText } from "../ui/touch";
import { I } from "../ui/icons";
import { showContextMenu } from "../ui/menu";
import { promptDialog, toast } from "../ui/dialog";
import { fmtSpeed, snapSpeed, SPEED_MAX, SPEED_MIN, SPEED_PRESETS } from "../app/player";

/** Frame rates for display: "25.00", "0.25", "0.075". */
const fmtRate = (v: number) => (v >= 1 ? v.toFixed(2) : String(+v.toPrecision(3)));
const fmtHold = (sec: number) => (sec < 1 ? `${Math.round(sec * 1000)} ms` : `${sec.toFixed(sec < 10 ? 2 : 1)} s`);

export class PlayerPanel {
  el: HTMLElement;
  private frameInp: HTMLInputElement;
  private timeInp: HTMLInputElement;
  private typeEl: HTMLElement;
  private playBtn: HTMLButtonElement;
  private speedLbl: HTMLElement;
  private zoomLbl: HTMLElement;
  private timeline: HTMLCanvasElement;
  private wave: HTMLCanvasElement;
  private tlStart: HTMLElement;
  private tlEnd: HTMLElement;
  private loopCb: ReturnType<typeof checkBox>;
  private speedSl: ReturnType<typeof slider>;
  private speedMode: HTMLSelectElement;
  private envelope = false;
  private dragging = false;

  constructor(private ctx: AppCtx, private audio: AudioEngine) {
    const s = ctx.store, p = ctx.player, a = ctx.actions;
    this.playBtn = iconBtn(I.play, "Play / Pause (Space)", () => p.toggle(), "ibtn pl-ib") as HTMLButtonElement;
    this.frameInp = h("input", { class: "pl-frame inp", type: "text", value: "0", title: "Current frame (Enter to go)" }) as HTMLInputElement;
    this.timeInp = h("input", { class: "pl-time inp", type: "text", value: "00:00:00.000", title: "Current time (Enter to go)" }) as HTMLInputElement;
    this.typeEl = h("span", { class: "pl-type", title: "Frame type" }, "[ ]");
    this.loopCb = checkBox("Loop", false, (v) => { p.loop = v; });
    const step = spinBox({ value: 1, min: 1, max: 100000, width: 54, onChange: (v) => { p.stepSize = v; } });
    const unit = selectBox([["frames", "Frames"], ["seconds", "Seconds"]], "frames", (v) => { p.unit = v as any; });
    this.speedLbl = h("button", { class: "pl-speed", type: "button", "aria-haspopup": "menu" }, "Speed: 1.0x");
    this.speedLbl.addEventListener("click", (e) => this.speedMenu(e));
    this.speedSl = slider({ min: SPEED_MIN, max: SPEED_MAX, value: 1, log: true, labels: false, ticks: 0, snap: snapSpeed, onInput: (v) => p.setSpeed(v) });
    this.speedSl.el.classList.add("pl-slider", "pl-speedsl");
    this.speedSl.range.title = `Playback speed (${SPEED_MIN}× to ${SPEED_MAX}×). [ slower, ] faster`;
    const speedMode = this.speedMode = selectBox([["speed", "Speed"], ["fps", "Frame Rate"]], "speed", () => this.refreshSpeed());
    speedMode.classList.add("pl-speedmode");
    step.el.classList.add("pl-step");
    unit.classList.add("pl-unit");
    this.loopCb.el.classList.add("pl-loop");
    const muteBtn = iconBtn(audio.muted ? I.mute : I.speaker, "Mute", () => { audio.setVolume(audio.volume, !audio.muted); muteBtn.innerHTML = ""; muteBtn.appendChild(svg(audio.muted ? I.mute : I.speaker)); }, "ibtn pl-ib pl-mute") as HTMLButtonElement;
    const vol = slider({ min: 0, max: 1, value: audio.volume, labels: false, ticks: 0, onInput: (v) => audio.setVolume(v, audio.muted) });
    vol.el.classList.add("pl-slider", "pl-vol");
    this.zoomLbl = h("span", { class: "pl-zoom" }, "Zoom: 100.00%");
    const gear = iconBtn(I.playGear, "Playback options", (e) => this.optionsMenu(e), "ibtn pl-ib pl-gear");
    this.playBtn.classList.add("pl-play");
    // (the pl-* classes let the compact layouts re-order and wrap the controls)
    const row = h("div", { class: "pl-row" },
      gear, this.playBtn,
      iconBtn(I.first, "First frame (Home)", () => p.first(), "ibtn pl-ib pl-first"),
      iconBtn(I.last, "Last frame (End)", () => p.last(), "ibtn pl-ib pl-last"),
      iconBtn(I.snapshot, "Save snapshot of the current frame", () => void a.snapshot(), "ibtn pl-ib pl-snap"),
      iconBtn(I.folder, "Export frames (Image Writer)", () => void a.writeImages(), "ibtn pl-ib pl-export"),
      iconBtn(I.bookmark, "Add bookmark (B)", () => void a.addBookmark(), "ibtn pl-ib pl-bm"),
      this.frameInp, this.timeInp, this.typeEl, this.loopCb.el,
      iconBtn(I.prev, "Previous (Left)", () => p.stepBy(-1), "ibtn pl-ib pl-prev"),
      iconBtn(I.next, "Next (Right)", () => p.stepBy(1), "ibtn pl-ib pl-next"),
      step.el, unit, this.speedLbl,
      iconBtn(I.reset, "Reset speed to 1×", () => p.setSpeed(1), "ibtn pl-ib pl-speedreset"),
      this.speedSl.el, speedMode, muteBtn, vol.el, this.zoomLbl,
      iconBtn(I.reset, "Fit window", () => ctx.viewer()?.fit(), "ibtn pl-ib pl-fit"));
    this.timeline = h("canvas", { class: "pl-timeline" });
    this.tlStart = h("div", { class: "pl-tl-lbl" }, "0", h("br"), h("span", { class: "pl-tl-t" }, "(00:00:00.000)"));
    this.tlEnd = h("div", { class: "pl-tl-lbl right" }, "0", h("br"), h("span", { class: "pl-tl-t" }, "(00:00:00.000)"));
    this.wave = h("canvas", { class: "pl-wave" });
    const help = h("button", { class: "pl-help", title: "Audio waveform help" }, "?");
    help.addEventListener("click", () => this.ctx.store.status(touchText("The waveform shows the audio of the current chain source. Click to seek; toggle Waveform/Envelope on the right.")));
    const waveMode = h("div", { class: "pl-wave-mode" }, h("span", { class: "on" }, "Waveform"), h("span", null, "Envelope"));
    waveMode.addEventListener("click", (e) => { const t = e.target as HTMLElement; if (t.tagName !== "SPAN") return; this.envelope = t.textContent === "Envelope"; waveMode.querySelectorAll("span").forEach((x) => x.classList.toggle("on", x === t)); this.drawWave(); });
    this.el = h("div", { class: "panel player" }, row,
      h("div", { class: "pl-tl-row" }, this.tlStart, this.timeline, this.tlEnd),
      h("div", { class: "pl-wave-row" }, help, this.wave, waveMode));

    this.frameInp.addEventListener("keydown", (e) => { if (e.key === "Enter") { const v = parseInt(this.frameInp.value, 10); if (isFinite(v)) s.setFrame(v); this.frameInp.blur(); } });
    this.timeInp.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const t = parseTime(this.timeInp.value), info = s.streamInfo.get(s.ui.chainId ?? "");
      if (t !== null && info) s.setFrame(Math.round(t * info.fps));
      this.timeInp.blur();
    });
    this.bindTimeline();
    s.on("ui", (k) => { if (k.has("frame") || k.has("chainId") || k.has("inOut")) { this.refresh(); } if (k.has("playing")) this.refreshPlay(); });
    s.on("rendered", () => this.refresh());
    s.on("project", () => this.drawTimeline());
    ctx.bus.on("zoom", (z) => { this.zoomLbl.textContent = `Zoom: ${z.toFixed(2)}%`; });
    p.on("state", () => { this.refreshPlay(); this.refreshSpeed(); this.loopCb.set(p.loop); });
    audio.on("peaks", () => this.drawWave());
    new ResizeObserver(() => { this.drawTimeline(); this.drawWave(); }).observe(this.el);
    this.refresh();
  }

  private refreshPlay() {
    this.playBtn.innerHTML = "";
    this.playBtn.appendChild(svg(this.ctx.player.playing ? I.pause : I.play));
  }

  private refreshSpeed() {
    const p = this.ctx.player, info = this.ctx.store.streamInfo.get(this.ctx.store.ui.chainId ?? "");
    const eff = info ? info.fps * p.speed : 0;
    this.speedLbl.textContent = this.speedMode?.value === "fps" && info ? `FPS: ${fmtRate(eff)}` : `Speed: ${fmtSpeed(p.speed)}x`;
    this.speedLbl.title = (info && eff > 0
      ? `${fmtSpeed(p.speed)}× of ${fmtRate(info.fps)} fps = ${fmtRate(eff)} frames per second: each frame stays on screen for ${fmtHold(1 / eff)}.`
      : `Playback speed ${fmtSpeed(p.speed)}×.`)
      + (p.speed < 1 ? " Below 1× every frame is shown, none are skipped." : "")
      + (Math.abs(p.speed - 1) > 1e-9 ? " Audio plays at 1× only." : "")
      + " Click for presets or an exact speed.";
    if (document.activeElement !== this.speedSl.range) this.speedSl.set(p.speed);
  }

  private speedMenu(e: MouseEvent) {
    const p = this.ctx.player, r = this.speedLbl.getBoundingClientRect();
    showContextMenu(e.clientX || r.left, e.clientY || r.bottom, [
      ...SPEED_PRESETS.map((v) => ({ label: `${fmtSpeed(v)}×${v === 1 ? "  (real time)" : ""}`, checked: Math.abs(p.speed - v) < 1e-9, action: () => p.setSpeed(v) })),
      "-",
      { label: "Custom Speed…", action: () => void this.customSpeed() },
      { label: "Slower", shortcut: "[", action: () => p.slower() },
      { label: "Faster", shortcut: "]", action: () => p.faster() },
    ]);
  }

  private async customSpeed() {
    const p = this.ctx.player;
    const v = await promptDialog("Playback Speed", `Speed from ${SPEED_MIN}× to ${SPEED_MAX}× (for example 0.01 for one hundredth of real time):`, fmtSpeed(p.speed));
    if (v === null) return;
    const n = parseFloat(v.trim().replace(",", ".").replace(/\s*[x×]$/i, ""));
    if (!isFinite(n) || n <= 0) { toast("Enter a speed such as 0.01, 0.5 or 2.", "error"); return; }
    if (n < SPEED_MIN || n > SPEED_MAX) toast(`The speed was limited to the ${SPEED_MIN}× – ${SPEED_MAX}× range.`, "info");
    p.setSpeed(n);
  }

  private optionsMenu(e: MouseEvent) {
    const s = this.ctx.store, p = this.ctx.player, f = s.frameOf();
    const id = s.ui.chainId;
    const io = id ? s.ui.inOut[id] : undefined;
    showContextMenu(e.clientX, e.clientY, [
      { label: "Play Every Frame (no dropping)", checked: s.prefs.playAllFrames, action: () => s.savePrefs({ playAllFrames: !s.prefs.playAllFrames }) },
      { label: "Loop", checked: p.loop, action: () => { p.loop = !p.loop; p.emit("state"); } },
      { label: "Play In/Out Range Only", checked: p.playRange, action: () => { p.playRange = !p.playRange; } },
      "-",
      { label: `Set In Point (${f})`, shortcut: "I", action: () => p.setIn(f) },
      { label: `Set Out Point (${f})`, shortcut: "O", action: () => p.setOut(f) },
      { label: "Clear In/Out", disabled: !io, action: () => { p.setIn(null); p.setOut(null); } },
      { label: "Go to In Point", disabled: io?.[0] == null, action: () => s.setFrame(io![0]!) },
      { label: "Go to Out Point", disabled: io?.[1] == null, action: () => s.setFrame(io![1]!) },
      "-",
      { label: "Add Range Selector from In/Out", disabled: !io || io[0] == null || io[1] == null, action: () => this.ctx.actions.addFilter("range_selector", { start: io![0], end: io![1] }) },
      { label: "Bookmarks…", action: () => void this.ctx.actions.showBookmarks() },
    ]);
  }

  private refresh() {
    const s = this.ctx.store, id = s.ui.chainId;
    const info = id ? s.streamInfo.get(id) : undefined;
    const f = s.frameOf();
    const r = s.lastRender;
    if (document.activeElement !== this.frameInp) this.frameInp.value = String(f);
    const pts = r && r.chainId === id && r.frame === f && r.meta.pts !== undefined ? r.meta.pts : info ? f / info.fps : 0;
    if (document.activeElement !== this.timeInp) this.timeInp.value = fmtTime(pts);
    this.typeEl.textContent = r && r.chainId === id && r.frame === f && r.meta.type && r.meta.type !== "?" ? `[${r.meta.type}]` : "[ ]";
    const n = info?.frameCount ?? 0;
    const endT = info ? (n - 1) / info.fps : 0;
    this.tlEnd.innerHTML = `${Math.max(0, n - 1)}<br><span class="pl-tl-t">(${fmtTime(endT)})</span>`;
    this.refreshSpeed();
    this.drawTimeline();
    this.drawWave();
  }

  // ------------------------------------------------------------ timeline
  private bindTimeline() {
    const seek = (e: PointerEvent) => {
      const s = this.ctx.store, info = s.streamInfo.get(s.ui.chainId ?? "");
      if (!info) return;
      const r = this.timeline.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (e.clientX - r.left - 6) / (r.width - 12)));
      s.setFrame(Math.round(t * (info.frameCount - 1)));
    };
    this.timeline.addEventListener("pointerdown", (e) => { this.dragging = true; capturePointer(this.timeline, e.pointerId); if (this.ctx.player.playing) this.ctx.player.pause(); seek(e); });
    this.timeline.addEventListener("pointermove", (e) => { if (this.dragging) seek(e); else this.hoverTip(e); });
    this.timeline.addEventListener("pointerup", () => { this.dragging = false; });
    this.wave.addEventListener("pointerdown", (e) => {
      const s = this.ctx.store, info = s.streamInfo.get(s.ui.chainId ?? "");
      if (!info) return;
      const r = this.wave.getBoundingClientRect();
      s.setFrame(Math.round(Math.max(0, Math.min(1, (e.clientX - r.left - 6) / (r.width - 12))) * (info.frameCount - 1)));
    });
  }

  private hoverTip(e: PointerEvent) {
    const s = this.ctx.store, info = s.streamInfo.get(s.ui.chainId ?? "");
    if (!info) return;
    const r = this.timeline.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left - 6) / (r.width - 12)));
    const fr = Math.round(t * (info.frameCount - 1));
    this.timeline.title = `Frame ${fr}  ${fmtTime(fr / info.fps)}`;
  }

  private sizeCanvas(c: HTMLCanvasElement) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, hh = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr); }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h: hh };
  }

  drawTimeline() {
    const { g, w, h: H } = this.sizeCanvas(this.timeline);
    g.clearRect(0, 0, w, H);
    const s = this.ctx.store, id = s.ui.chainId;
    const info = id ? s.streamInfo.get(id) : undefined;
    const n = Math.max(1, info?.frameCount ?? 1);
    const x0 = 6, x1 = w - 6, ty = 3, th = H - 8;
    g.fillStyle = getComputedStyle(this.el).getPropertyValue("--timeline").trim() || "#e6eaeb";
    g.fillRect(x0, ty, x1 - x0, th);
    const X = (f: number) => x0 + (n > 1 ? f / (n - 1) : 0) * (x1 - x0);
    const io = id ? s.ui.inOut[id] : undefined;
    if (io && (io[0] !== null || io[1] !== null)) {
      const a = io[0] ?? 0, b = io[1] ?? n - 1;
      g.fillStyle = "rgba(47,128,237,0.35)";
      g.fillRect(X(a), ty, Math.max(2, X(b) - X(a)), th);
      g.fillStyle = "#2f80ed";
      if (io[0] !== null) g.fillRect(X(a) - 1, ty - 2, 2, th + 4);
      if (io[1] !== null) g.fillRect(X(b) - 1, ty - 2, 2, th + 4);
    }
    for (const b of s.project.bookmarks) {
      if (b.chainId !== id) continue;
      g.fillStyle = "#ff9f1a";
      g.beginPath(); g.moveTo(X(b.frame) - 4, ty); g.lineTo(X(b.frame) + 4, ty); g.lineTo(X(b.frame), ty + 7); g.closePath(); g.fill();
    }
    if (!info) return;
    const f = s.frameOf();
    const hx = X(Math.min(f, n - 1));
    g.fillStyle = "#1677ff";
    g.beginPath(); g.moveTo(hx - 5, ty - 2); g.lineTo(hx + 5, ty - 2); g.lineTo(hx + 5, ty + th - 4); g.lineTo(hx, ty + th + 2); g.lineTo(hx - 5, ty + th - 4); g.closePath(); g.fill();
  }

  async drawWave() {
    const { g, w, h: H } = this.sizeCanvas(this.wave);
    g.clearRect(0, 0, w, H);
    const s = this.ctx.store, c = s.chain();
    const sid = c?.filters[0]?.params?.source;
    const x0 = 6, x1 = w - 6, mid = H / 2;
    const info = c ? s.streamInfo.get(c.id) : undefined;
    const data = sid ? await this.audio.peaksFor(sid) : null;
    g.strokeStyle = "rgba(200,205,215,0.55)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x0, mid + 0.5); g.lineTo(x1, mid + 0.5); g.stroke();
    if (!data || !info) return;
    const N = data.peaks.length / 2;
    const total = (info.frameCount - 1) / info.fps || data.duration;
    g.fillStyle = this.envelope ? "rgba(90,160,255,0.55)" : "#4f9dff";
    for (let px = 0; px < x1 - x0; px++) {
      const t0 = (px / (x1 - x0)) * total, t1 = ((px + 1) / (x1 - x0)) * total;
      const b0 = Math.floor((t0 / data.duration) * N), b1 = Math.max(b0 + 1, Math.floor((t1 / data.duration) * N));
      let mn = 0, mx = 0;
      for (let b = b0; b < Math.min(N, b1); b++) { mn = Math.min(mn, data.peaks[b * 2]); mx = Math.max(mx, data.peaks[b * 2 + 1]); }
      if (this.envelope) { const a = Math.max(-mn, mx); g.fillRect(x0 + px, mid - a * mid, 1, a * mid * 2); }
      else g.fillRect(x0 + px, mid - mx * (mid - 2), 1, Math.max(1, (mx - mn) * (mid - 2)));
    }
    const f = s.frameOf();
    const hx = x0 + (info.frameCount > 1 ? f / (info.frameCount - 1) : 0) * (x1 - x0);
    g.fillStyle = "#ffd400"; g.fillRect(hx - 0.5, 0, 1.5, H);
  }
}
