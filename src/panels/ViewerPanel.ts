// Viewer: chain tabs + frame display with zoom/pan, tool overlays and interactive
// editing of filter parameters (regions, points, lines) directly on the image.
import { BRAND } from "../brand";
import { FILTERS, isOverlayParam, type ParamDef } from "../shared/filters";
import type { Pt, RectP, RenderOk } from "../shared/types";
import type { AppCtx } from "../app/context";
import type { UiState } from "../app/store";
import { clamp, clear, h } from "../ui/dom";
import { logoSvg } from "../ui/icons";
import { showContextMenu } from "../ui/menu";
import { capturePointer, isCoarsePointer, noteLongPress, onContextMenu, onDoubleActivate } from "../ui/touch";
import { getGpu, gpuSupports } from "../gpu/preview";

interface ViewState { zoom: number; fit: boolean; cx: number; cy: number }
interface Target { key: string; type: "rect" | "point" | "points" | "line"; value: any; color: string; closed?: boolean; polyline?: boolean; maxPoints?: number }
type Drag =
  | { kind: "pan"; sx: number; sy: number; cx: number; cy: number }
  | { kind: "zoomrect"; a: Pt; b: Pt }
  | { kind: "tool"; tool: string; a: Pt; b: Pt; handle?: string; orig?: any }
  | { kind: "overlay"; target: Target; handle: string; a: Pt; orig: any; created?: boolean };

const COLORS = ["#ffd400", "#00e5ff", "#ff5cf0", "#7cff4f"];

export class ViewerPanel {
  el: HTMLElement;
  private tabs: HTMLElement;
  private stage: HTMLElement;
  private canvas: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private msg: HTMLElement;
  private spinner: HTMLElement;
  /** Marks a WebGPU preview on screen (display only; the exact render replaces it). */
  private gpuBadge: HTMLElement;
  private gpuBusy = false;
  private gpuAgain = false;
  private previewOnScreen = false;
  /** project.modified and filter of the exact frame on screen. */
  private drawnMod = "";
  private shownFilter: string | null = null;
  private welcome: HTMLElement;
  private frameCanvas = document.createElement("canvas");
  private satCanvas: HTMLCanvasElement | null = null;
  private views = new Map<string, ViewState>();
  current: RenderOk | null = null;
  private busy = false;
  private pending = false;
  private drag: Drag | null = null;
  private hover: Pt | null = null;
  private space = false;
  private ro: ResizeObserver;
  private ownChain: string | null = null;
  private lastKey = "";
  private disposers: (() => void)[] = [];
  // touch input
  private hitPx = 7;
  private touchPts = new Map<number, { x: number; y: number }>();
  private touchPending: { down: PointerEvent; sx: number; sy: number; started: boolean; long: boolean; timer: number } | null = null;
  private pinch: { d0: number; z0: number; ix: number; iy: number } | null = null;
  private pinchLock = false;
  private lastTouch = 0;
  private lastTap: { t: number; x: number; y: number } | null = null;
  /** True while onDown() runs for the start of a one-finger drag (as opposed to a tap). */
  private touchDragStart = false;

  constructor(private ctx: AppCtx, public id: string, public primary: boolean) {
    this.tabs = h("div", { class: "chain-tabs" });
    this.canvas = h("canvas", { class: "viewer-canvas" });
    this.overlay = h("canvas", { class: "viewer-overlay", tabindex: "0" });
    this.msg = h("div", { class: "viewer-msg", hidden: true });
    this.spinner = h("div", { class: "viewer-spinner", hidden: true }, h("i"), h("span", null, "Processing…"));
    this.gpuBadge = h("div", { class: "gpu-badge", hidden: true, title: "Preview computed on the GPU while you adjust the filter. The exact result replaces it automatically; exports, measurements and hashes always use the exact result." }, "GPU preview");
    this.welcome = this.buildWelcome();
    this.stage = h("div", { class: "viewer-stage" }, this.canvas, this.overlay, this.msg, this.spinner, this.gpuBadge, this.welcome);
    this.el = h("div", { class: "panel viewer" }, this.tabs, this.stage);
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.stage);
    this.bindPointer();
    const s = ctx.store;
    this.disposers.push(
      s.on("project", () => { this.renderTabs(); this.requestRender(); }),
      s.on("ui", (keys) => this.onUi(keys)),
      s.on("prefs", () => this.requestRender()),
    );
    this.renderTabs();
    this.requestRender();
  }

  dispose() { this.ro.disconnect(); this.disposers.forEach((d) => d()); }

  get chainId(): string | null {
    const s = this.ctx.store;
    if (this.primary) return s.ui.chainId;
    if (this.ownChain && s.chain(this.ownChain)) return this.ownChain;
    return s.ui.chainId;
  }
  setChain(id: string) { if (this.primary) this.ctx.store.setUi({ chainId: id }); else { this.ownChain = id; this.renderTabs(); this.requestRender(); } }

  private onUi(keys: Set<keyof UiState>) {
    if (keys.has("chainId")) this.renderTabs();
    if (keys.has("chainId") || keys.has("selected") || keys.has("frame") || keys.has("showInput") || keys.has("tool") || keys.has("playing")) this.requestRender();
    if (keys.has("selection") || keys.has("ruler") || keys.has("polygon") || keys.has("profile") || keys.has("crosshair") || keys.has("activeOverlay") || keys.has("showSaturated") || keys.has("tool")) this.drawOverlay();
  }

  // ------------------------------------------------------------ chain tabs
  private renderTabs() {
    const s = this.ctx.store;
    clear(this.tabs);
    for (const c of s.project.chains) {
      const close = h("span", { class: "chain-tab-x", title: "Close chain" }, "×");
      const tab = h("div", { class: `chain-tab${c.id === this.chainId ? " active" : ""}`, title: c.name }, h("span", { class: "chain-tab-label" }, c.name), close);
      tab.addEventListener("pointerdown", (e) => { if ((e.target as HTMLElement) !== close && e.button === 0) this.setChain(c.id); });
      close.addEventListener("click", (e) => { e.stopPropagation(); void this.ctx.actions.deleteChain(c.id); });
      onDoubleActivate(tab, `vtab:${this.id}:${c.id}`, () => void this.ctx.actions.renameChain(c.id));
      onContextMenu(tab, (x, y) => {
        showContextMenu(x, y, [
          { label: "Rename Chain…", action: () => void this.ctx.actions.renameChain(c.id) },
          { label: "Duplicate Chain", action: () => this.ctx.actions.duplicateChain(c.id) },
          { label: "Open in New Viewer", action: () => this.ctx.actions.openViewer(c.id) },
          "-",
          { label: "Delete Chain", action: () => void this.ctx.actions.deleteChain(c.id) },
        ]);
      });
      this.tabs.appendChild(tab);
    }
    this.tabs.style.display = s.project.chains.length ? "" : "none";
  }

  private buildWelcome(): HTMLElement {
    const a = this.ctx.actions;
    return h("div", { class: "welcome" },
      h("div", { class: "welcome-logo", html: logoSvg(BRAND.letters, 150) }),
      h("div", { class: "welcome-title" }, `Welcome to ${BRAND.name} ${BRAND.edition}`),
      h("div", { class: "welcome-sub" }, isCoarsePointer() ? "Open an image or video to start" : "Drag an image or video here to start"),
      h("div", { class: "welcome-sub" }, "Or go to Help / Quick Start to learn"),
      h("div", { class: "welcome-actions" },
        h("button", { class: "btn", onclick: () => void a.openMedia() }, "Open Image or Video…"),
        h("button", { class: "btn", onclick: () => void a.convertDvr() }, "Convert DVR…"),
        h("button", { class: "btn primary", onclick: () => void a.loadSampleProject() }, "Load Sample Case")));
  }

  // ------------------------------------------------------------ rendering
  requestRender() {
    void this.gpuPreview();
    if (this.busy) { this.pending = true; return; }
    void this.doRender();
  }

  /**
   * WebGPU preview of the selected filter while its parameters change: its input frame (from the engine, kept
   * on the GPU until anything upstream changes) goes through the filter's shader and is drawn at once. Only for
   * parameter changes of the filter on screen; the exact render that follows replaces it.
   */
  /** The selected filter when the GPU can preview it on this viewer (its output on screen, an input to work on). */
  private gpuTarget() {
    const s = this.ctx.store;
    const cur = this.current;
    if (!this.primary || s.prefs.gpuPreview === false || s.ui.showInput || s.ui.playing || !cur) return null;
    const chain = s.chain(this.chainId);
    const sel = chain ? s.selectedFilter(chain.id) : null;
    if (!chain || !sel || !sel.enabled || sel.id !== this.shownFilter) return null;
    const idx = chain.filters.findIndex((f) => f.id === sel.id);
    const frame = s.frameOf(chain.id);
    if (idx < 1 || cur.frame !== frame || !gpuSupports(sel.type, sel.params)) return null;
    return { chain, sel, idx, frame, cur, key: JSON.stringify([chain.id, frame, chain.filters.slice(0, idx).map((f) => [f.type, f.enabled, f.params])]) };
  }

  /** Put the filter's input on the GPU (from the engine's cache), unless it is there already. */
  private async gpuInput(t: NonNullable<ReturnType<ViewerPanel["gpuTarget"]>>) {
    const gpu = await getGpu();
    if (!gpu) return null;
    if (!gpu.hasInput(t.key)) {
      const r = await this.ctx.engine.call<{ ok: boolean; w: number; h: number; floats: Float32Array }>("inputFrame", { chainId: t.chain.id, filterId: t.sel.id, frame: t.frame });
      if (!r?.ok || r.w !== t.cur.width || r.h !== t.cur.height || !gpu.setInput(t.key, r.w, r.h, r.floats)) return null;
    }
    return gpu;
  }

  /** After an exact render of a filter the GPU can preview: upload its input now, so the first adjustment is instant. */
  private async gpuWarm() {
    const t = this.gpuTarget();
    if (!t || this.gpuBusy) return;
    this.gpuBusy = true;
    try { await this.gpuInput(t); } catch { /* no preview */ }
    finally {
      this.gpuBusy = false;
      if (this.gpuAgain) { this.gpuAgain = false; void this.gpuPreview(); }
    }
  }

  private async gpuPreview() {
    if (this.gpuBusy) { this.gpuAgain = true; return; }
    const s = this.ctx.store;
    const t = this.gpuTarget();
    const mod = s.project.modified;
    if (!t || mod === this.drawnMod) return;
    const { sel, frame, cur } = t;
    this.gpuBusy = true;
    try {
      const gpu = await this.gpuInput(t);
      if (!gpu) return;
      const rgba = await gpu.run(sel.type, sel.params);
      // still the frame and filter on screen, and no exact frame for these (or newer) parameters drawn meanwhile
      if (!rgba || this.drawnMod === mod || this.current?.frame !== frame || this.shownFilter !== sel.id || this.current.width !== cur.width || this.current.height !== cur.height) return;
      const fc = this.frameCanvas;
      fc.getContext("2d")!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, cur.width, cur.height), 0, 0);
      this.satCanvas = null;
      this.previewOnScreen = true;
      this.gpuBadge.hidden = false;
      this.draw();
    } catch { /* no preview: the exact render shows the result */ }
    finally {
      this.gpuBusy = false;
      if (this.gpuAgain) { this.gpuAgain = false; void this.gpuPreview(); }
    }
  }

  private async doRender() {
    const s = this.ctx.store;
    const chain = s.chain(this.chainId);
    const has = !!chain && chain.filters.length > 0;
    this.welcome.hidden = s.project.chains.length > 0;
    if (!has) { this.current = null; this.msg.hidden = true; this.draw(); return; }
    const sel = s.selectedFilter(chain!.id);
    const input = this.primary && s.ui.showInput;
    const tool = s.ui.tool;
    const want = { hist: this.primary && (tool === "histogram" || s.ui.showSaturated), hash: this.primary && s.prefs.frameHash && !s.ui.playing && (tool === "pointer" || tool === "histogram") };
    const frame = s.frameOf(chain!.id);
    const key = JSON.stringify([chain!.id, sel?.id, frame, input, want, s.project.modified]);
    if (key === this.lastKey && this.current) return;
    this.busy = true;
    this.pending = false;
    const spin = setTimeout(() => { this.spinner.hidden = false; }, 180);
    let res;
    const prefetch = this.primary && s.ui.playing ? this.ctx.player.predictNext(frame) : undefined;
    const mod = s.project.modified;
    try { res = await this.ctx.engine.call("render", { chainId: chain!.id, filterId: sel?.id ?? null, frame, input, want, channel: `viewer:${this.id}`, prefetch }); }
    catch (e) { res = { ok: false, error: (e as Error).message }; }
    clearTimeout(spin);
    this.spinner.hidden = true;
    this.busy = false;
    if (res.ok && this.previewOnScreen && s.project.modified !== mod) {
      // parameters changed while this frame was computed and a newer GPU preview is on screen: keep the
      // preview, the render for the current parameters follows
      this.pending = true;
    } else if (res.ok) {
      this.lastKey = key;
      this.current = res;
      this.msg.hidden = true;
      this.drawnMod = mod;
      this.shownFilter = sel?.id ?? null;
      this.previewOnScreen = false;
      this.gpuBadge.hidden = true;
      this.uploadFrame(res);
      if (this.primary) setTimeout(() => void this.gpuWarm(), 0);
      if (this.primary) {
        s.streamInfo.set(chain!.id, res.info);
        const ev = { ...res, chainId: chain!.id, filterId: sel?.id ?? null, input };
        s.lastRender = ev;
        if (res.frame !== frame) s.ui.frame = { ...s.ui.frame, [chain!.id]: res.frame };
        s.emit("rendered", ev);
      }
      this.draw();
    } else if (!res.superseded) {
      this.lastKey = "";
      this.msg.hidden = false;
      this.msg.textContent = res.error;
      if (this.primary) s.emit("renderError", { chainId: chain!.id, error: res.error, filterId: res.filterId });
      if (res.info && this.primary) s.streamInfo.set(chain!.id, res.info);
    }
    if (this.pending) { this.pending = false; void this.doRender(); }
  }

  private uploadFrame(r: RenderOk) {
    const fc = this.frameCanvas;
    if (fc.width !== r.width || fc.height !== r.height) { fc.width = r.width; fc.height = r.height; }
    fc.getContext("2d")!.putImageData(new ImageData(r.rgba as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
    this.satCanvas = null;
    const v = this.view();
    if (v.cx < 0 || v.cy < 0 || v.cx > r.width || v.cy > r.height) { v.cx = r.width / 2; v.cy = r.height / 2; }
  }

  private view(): ViewState {
    const id = this.chainId ?? "_";
    let v = this.views.get(id);
    if (!v) { v = { zoom: 1, fit: true, cx: -1, cy: -1 }; this.views.set(id, v); }
    return v;
  }

  /** Effective zoom and offset in CSS pixels. */
  private geom() {
    const v = this.view();
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    const fw = this.current?.width ?? 1, fh = this.current?.height ?? 1;
    if (v.cx < 0) { v.cx = fw / 2; v.cy = fh / 2; }
    let zoom = v.zoom;
    if (v.fit) { zoom = Math.min((W - 8) / fw, (H - 8) / fh); if (!isFinite(zoom) || zoom <= 0) zoom = 1; v.cx = fw / 2; v.cy = fh / 2; }
    // image origin on whole device pixels: no half-pixel blur, and a pixel grid that stays put while panning
    const dpr = window.devicePixelRatio || 1;
    const ox = Math.round((W / 2 - v.cx * zoom) * dpr) / dpr, oy = Math.round((H / 2 - v.cy * zoom) * dpr) / dpr;
    return { W, H, zoom, ox, oy, fw, fh };
  }

  get zoom(): number { return this.geom().zoom; }
  get isBusy(): boolean { return this.busy; }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    for (const c of [this.canvas, this.overlay]) {
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    }
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.current) {
      const g = this.geom();
      const mode = this.ctx.store.prefs.viewerInterp ?? "sharp";
      this.drawScaled(ctx, this.frameCanvas, g, dpr, mode);
      if (this.primary && this.ctx.store.ui.showSaturated) {
        if (!this.satCanvas) this.satCanvas = this.buildSat();
        this.drawScaled(ctx, this.satCanvas, g, dpr, mode === "smooth" ? "nearest" : mode);
      }
      if (this.primary) this.ctx.bus.emit("zoom", Math.round(g.zoom * 10000) / 100);
    }
    this.drawOverlay();
  }

  private sharpTmp: HTMLCanvasElement | null = null;

  /**
   * Draw an image-sized canvas with the viewer geometry, in device pixels (display only).
   * sharp: at fractional zooms plain nearest neighbor gives uneven pixels (at 154 % some image pixels get one
   *   screen pixel, others two), and bilinear blurs. So the visible region is first enlarged with nearest
   *   neighbor by the zoom rounded up to a whole number, and only the small remaining reduction is filtered:
   *   every image pixel becomes an equal-size block with at most one blended screen pixel at its edges.
   *   Integer zooms are exact nearest neighbor.
   * Below 100 % frames are averaged (high quality downscaling) except in "nearest" mode.
   */
  private drawScaled(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, g: ReturnType<ViewerPanel["geom"]>, dpr: number, mode: "sharp" | "nearest" | "smooth") {
    const z = g.zoom * dpr, ox = g.ox * dpr, oy = g.oy * dpr;
    const Wd = this.canvas.width, Hd = this.canvas.height;
    const x0 = Math.max(0, Math.floor(-ox / z)), y0 = Math.max(0, Math.floor(-oy / z));
    const x1 = Math.min(g.fw, Math.ceil((Wd - ox) / z)), y1 = Math.min(g.fh, Math.ceil((Hd - oy) / z));
    if (x1 <= x0 || y1 <= y0) return;
    const sw = x1 - x0, sh = y1 - y0, dx = ox + x0 * z, dy = oy + y0 * z, dw = sw * z, dh = sh * z;
    const k = Math.floor(z + 1e-9), integer = Math.abs(z - Math.round(z)) < 1e-6;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (z < 1 - 1e-6) {
      ctx.imageSmoothingEnabled = mode !== "nearest";
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, x0, y0, sw, sh, dx, dy, dw, dh);
    } else if (mode === "smooth") {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "low"; // bilinear
      ctx.drawImage(src, x0, y0, sw, sh, dx, dy, dw, dh);
    } else if (mode === "nearest" || integer || k < 1) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(src, x0, y0, sw, sh, dx, dy, dw, dh);
    } else {
      // K = ceil(zoom): the remaining factor is a mild reduction, which the GPU averages like an area filter, so
      // every image pixel keeps a flat core and at most one blended screen pixel at its edges (also between 100
      // and 200 %, where rounding down would leave plain bilinear). Very large regions use floor(zoom) instead.
      let K = Math.ceil(z);
      if (sw * K * sh * K > 16_777_216) K = k;
      const t = this.sharpTmp ??= document.createElement("canvas");
      const tw = sw * K, th = sh * K;
      if (t.width !== tw || t.height !== th) { t.width = tw; t.height = th; }
      const tc = t.getContext("2d")!;
      tc.setTransform(1, 0, 0, 1, 0, 0);
      tc.clearRect(0, 0, tw, th);
      tc.imageSmoothingEnabled = false;
      tc.drawImage(src, x0, y0, sw, sh, 0, 0, tw, th);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "low";
      ctx.drawImage(t, 0, 0, tw, th, dx, dy, dw, dh);
    }
  }

  private buildSat(): HTMLCanvasElement {
    const r = this.current!;
    const c = document.createElement("canvas");
    c.width = r.width; c.height = r.height;
    const img = new ImageData(r.width, r.height);
    const s = r.rgba, d = img.data;
    for (let i = 0; i < s.length; i += 4) {
      const hi = s[i] === 255 || s[i + 1] === 255 || s[i + 2] === 255, lo = s[i] === 0 || s[i + 1] === 0 || s[i + 2] === 0;
      if (hi) { d[i] = 255; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 200; }
      else if (lo) { d[i] = 0; d[i + 1] = 90; d[i + 2] = 255; d[i + 3] = 200; }
    }
    c.getContext("2d")!.putImageData(img, 0, 0);
    return c;
  }

  // ------------------------------------------------------------ coordinates
  private toImage(e: { clientX: number; clientY: number }): Pt {
    const r = this.stage.getBoundingClientRect();
    const g = this.geom();
    return { x: (e.clientX - r.left - g.ox) / g.zoom, y: (e.clientY - r.top - g.oy) / g.zoom };
  }
  private toScreen(p: Pt): Pt { const g = this.geom(); return { x: g.ox + p.x * g.zoom, y: g.oy + p.y * g.zoom }; }

  // ------------------------------------------------------------ overlay targets (filter parameters)
  private targets(): Target[] {
    if (!this.primary) return [];
    const s = this.ctx.store;
    const f = s.selectedFilter();
    if (!f) return [];
    const def = FILTERS[f.type];
    if (!def?.overlayOn) return [];
    if (def.overlayOn === "input" && !s.ui.showInput) return [];
    const out: Target[] = [];
    let k = 0;
    for (const pd of def.params) {
      if (!isOverlayParam(pd) || (pd.show && !pd.show(f.params)) || (pd.overlayIf && !pd.overlayIf(f.params))) continue;
      out.push({ key: pd.key, type: pd.type, value: f.params[pd.key], color: COLORS[k++ % COLORS.length], closed: pd.type === "points" ? pd.closed : false, polyline: pd.type === "points" ? pd.polyline || pd.closed : false, maxPoints: pd.type === "points" ? pd.maxPoints : undefined });
    }
    return out;
  }

  private activeTarget(ts: Target[]): Target | null {
    const key = this.ctx.store.ui.activeOverlay;
    return ts.find((t) => t.key === key) ?? ts.find((t) => t.value === null || (Array.isArray(t.value) && t.value.length === 0 && t.type === "points")) ?? ts[0] ?? null;
  }

  private setParam(key: string, value: any, coalesce = true) {
    const f = this.ctx.store.selectedFilter();
    if (!f) return;
    this.ctx.actions.setParam(f.id, key, value, coalesce ? `ov:${f.id}:${key}` : undefined);
  }

  // ------------------------------------------------------------ pointer handling
  private bindPointer() {
    const ov = this.overlay;
    const touch = (e: PointerEvent) => e.pointerType === "touch";
    ov.addEventListener("pointerdown", (e) => (touch(e) ? this.touchDown(e) : this.onDown(e)));
    ov.addEventListener("pointermove", (e) => (touch(e) ? this.touchMove(e) : this.onMove(e)));
    ov.addEventListener("pointerup", (e) => (touch(e) ? this.touchUp(e) : this.onUp(e)));
    ov.addEventListener("pointercancel", (e) => { if (touch(e)) this.touchCancel(e); else this.drag = null; });
    ov.addEventListener("pointerleave", (e) => {
      if (touch(e)) return; // keep the pixel readout of the last touched point
      this.hover = null; if (this.primary) this.ctx.store.setUi({ cursor: null }); this.drawOverlay();
    });
    ov.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    // Touch gestures are recognized from pointer events below; ignore the platform's duplicates.
    ov.addEventListener("dblclick", (e) => { if (performance.now() - this.lastTouch > 800) this.onDbl(e); });
    ov.addEventListener("contextmenu", (e) => { if (performance.now() - this.lastTouch < 1200) { e.preventDefault(); return; } this.onContext(e); });
    ov.addEventListener("keydown", (e) => { if (e.key === " ") { this.space = true; e.preventDefault(); } });
    ov.addEventListener("keyup", (e) => { if (e.key === " ") this.space = false; });
  }

  private handleHit(p: Pt, t: Target): string | null {
    const g = this.geom();
    const tol = this.hitPx / g.zoom;
    const near = (a: Pt) => Math.abs(a.x - p.x) <= tol && Math.abs(a.y - p.y) <= tol;
    const v = t.value;
    if (!v) return null;
    if (t.type === "point") return near(v) ? "p" : null;
    if (t.type === "line") { if (near(v[0])) return "0"; if (near(v[1])) return "1"; if (distToSeg(p, v[0], v[1]) <= tol) return "move"; return null; }
    if (t.type === "points") { for (let i = v.length - 1; i >= 0; i--) if (near(v[i])) return String(i); return null; }
    if (t.type === "rect") return rectHit(p, v, tol);
    return null;
  }

  private onDown(e: PointerEvent) {
    this.overlay.focus({ preventScroll: true });
    this.hitPx = e.pointerType === "mouse" ? 7 : 18; // fingers need larger handles
    if (!this.current) return;
    const p = this.toImage(e);
    const s = this.ctx.store;
    capturePointer(this.overlay, e.pointerId);
    const v = this.view();
    if (e.button === 1 || (e.button === 0 && this.space)) { this.drag = { kind: "pan", sx: e.clientX, sy: e.clientY, cx: this.geom().ox, cy: this.geom().oy }; return; }
    if (e.button !== 0) return;
    // 1) filter parameter overlays
    const ts = this.targets();
    for (const t of ts) {
      const hdl = this.handleHit(p, t);
      if (hdl) { s.setUi({ activeOverlay: t.key }); this.drag = { kind: "overlay", target: t, handle: hdl, a: p, orig: structuredClone(t.value) }; return; }
    }
    const at = this.activeTarget(ts);
    if (at && s.ui.tool !== "zoom") {
      const cp = { x: clamp(p.x, 0, this.current.width), y: clamp(p.y, 0, this.current.height) };
      if (at.type === "point") { this.setParam(at.key, cp, false); this.drag = { kind: "overlay", target: { ...at, value: cp }, handle: "p", a: p, orig: cp }; return; }
      if (at.type === "points") {
        const list: Pt[] = [...(at.value || [])];
        if (!at.maxPoints || list.length < at.maxPoints) { list.push(cp); this.setParam(at.key, list, false); this.drag = { kind: "overlay", target: { ...at, value: list }, handle: String(list.length - 1), a: p, orig: list }; }
        return;
      }
      if (at.type === "line") { const l: [Pt, Pt] = [cp, { ...cp }]; this.drag = { kind: "overlay", target: { ...at, value: l }, handle: "1", a: p, orig: l, created: true }; return; }
      if (at.type === "rect") { const r = { x: cp.x, y: cp.y, w: 0, h: 0 }; this.drag = { kind: "overlay", target: { ...at, value: r }, handle: "se", a: p, orig: r, created: true }; return; }
    }
    // 2) tools
    const tool = s.ui.tool;
    if (tool === "zoom") { this.drag = { kind: "zoomrect", a: p, b: p }; return; }
    if (tool === "selector") {
      const sel = s.ui.selection;
      const hdl = sel ? rectHit(p, sel, this.hitPx / this.geom().zoom) : null;
      this.drag = { kind: "tool", tool, a: p, b: p, handle: hdl ?? undefined, orig: sel ? { ...sel } : null };
      return;
    }
    if (tool === "ruler" || tool === "curve") { this.drag = { kind: "tool", tool, a: p, b: p }; return; }
    if (tool === "polygon") { s.setUi({ polygon: [...s.ui.polygon, p] }); return; }
    if (tool === "crosshair") {
      // A finger has no hover: dragging moves the crosshair (the locked one too); a tap or click locks / unlocks it.
      if (this.touchDragStart) { this.drag = { kind: "tool", tool, a: p, b: p }; if (s.ui.crosshair) s.setUi({ crosshair: p }); return; }
      s.setUi({ crosshair: s.ui.crosshair ? null : p }); return;
    }
    v.fit = v.fit && false;
    this.drag = { kind: "pan", sx: e.clientX, sy: e.clientY, cx: this.geom().ox, cy: this.geom().oy };
  }

  private onMove(e: PointerEvent) {
    if (!this.current) return;
    const p = this.toImage(e);
    this.hover = p;
    const s = this.ctx.store;
    if (this.primary) {
      const x = Math.floor(p.x), y = Math.floor(p.y), r = this.current;
      const inside = x >= 0 && y >= 0 && x < r.width && y < r.height;
      const k = (y * r.width + x) * 4;
      s.setUi({ cursor: { x: p.x, y: p.y, rgba: inside ? [r.rgba[k], r.rgba[k + 1], r.rgba[k + 2], r.rgba[k + 3]] : null } });
    }
    const d = this.drag;
    if (!d) { this.updateCursor(p); this.drawOverlay(); return; }
    if (d.kind === "pan") {
      const v = this.view(), g = this.geom();
      if (v.fit) { v.fit = false; v.zoom = g.zoom; }
      const ox = d.cx + (e.clientX - d.sx), oy = d.cy + (e.clientY - d.sy);
      v.cx = (g.W / 2 - ox) / v.zoom; v.cy = (g.H / 2 - oy) / v.zoom;
      this.draw();
      this.ctx.bus.emit("view", null);
      return;
    }
    if (d.kind === "zoomrect") { d.b = p; this.drawOverlay(); return; }
    if (d.kind === "tool") {
      d.b = p;
      if (d.tool === "selector") {
        let r: RectP;
        if (d.handle && d.orig) r = dragRect(d.orig, d.handle, p.x - d.a.x, p.y - d.a.y);
        else r = normRect({ x: d.a.x, y: d.a.y, w: p.x - d.a.x, h: p.y - d.a.y });
        s.setUi({ selection: clipRect(roundRect(r), this.current.width, this.current.height) });
      } else if (d.tool === "ruler") s.setUi({ ruler: [d.a, p] });
      else if (d.tool === "curve") s.setUi({ profile: [d.a, p] });
      else if (d.tool === "crosshair") { if (s.ui.crosshair) s.setUi({ crosshair: p }); else this.drawOverlay(); }
      return;
    }
    if (d.kind === "overlay") {
      const t = d.target, dx = p.x - d.a.x, dy = p.y - d.a.y;
      let nv: any;
      if (t.type === "point") nv = { x: d.orig.x + dx, y: d.orig.y + dy };
      else if (t.type === "line") {
        const l = d.orig as [Pt, Pt];
        if (d.handle === "move") nv = [{ x: l[0].x + dx, y: l[0].y + dy }, { x: l[1].x + dx, y: l[1].y + dy }];
        else { nv = [{ ...l[0] }, { ...l[1] }]; nv[+d.handle] = { x: l[+d.handle].x + dx, y: l[+d.handle].y + dy }; }
      } else if (t.type === "points") { nv = (d.orig as Pt[]).map((q, i) => (String(i) === d.handle ? { x: q.x + dx, y: q.y + dy } : q)); }
      else if (t.type === "rect") nv = clipRect(roundRect(d.created ? normRect({ x: d.orig.x, y: d.orig.y, w: p.x - d.orig.x, h: p.y - d.orig.y }) : dragRect(d.orig, d.handle, dx, dy)), this.current.width, this.current.height);
      t.value = nv;
      this.setParam(t.key, nv);
      return;
    }
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    try { this.overlay.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!d) return;
    if (d.kind === "zoomrect") {
      const r = normRect({ x: d.a.x, y: d.a.y, w: d.b.x - d.a.x, h: d.b.y - d.a.y });
      const g = this.geom();
      if (r.w * g.zoom < 6 || r.h * g.zoom < 6) this.zoomAt(d.a, e.altKey || e.shiftKey ? 0.5 : 2);
      else this.zoomToRect(r);
    }
    if (d.kind === "overlay" && d.created && d.target.type === "line") {
      const l = d.target.value as [Pt, Pt];
      if (Math.hypot(l[1].x - l[0].x, l[1].y - l[0].y) < 1) return;
    }
    if (d.kind === "tool" && d.tool === "selector" && !d.handle && Math.abs(d.b.x - d.a.x) < 2 && Math.abs(d.b.y - d.a.y) < 2) this.ctx.store.setUi({ selection: null });
    this.drawOverlay();
  }

  // ------------------------------------------------------------ touch
  // One finger: the action is deferred until the finger moves (drag with the current tool) or
  // lifts (tap = click), so a second finger can still turn the gesture into a pinch.
  // Two fingers: pinch zoom + pan. Long press: context menu. Double tap: zoom in / fit.
  private touchDown(e: PointerEvent) {
    this.lastTouch = performance.now();
    try { this.overlay.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.touchPts.size === 2) {
      this.cancelTouchPending();
      if (this.drag) { this.drag = null; this.drawOverlay(); }
      if (this.current) this.startPinch();
      return;
    }
    if (this.touchPts.size > 2 || this.pinchLock) return;
    this.overlay.focus({ preventScroll: true });
    const timer = window.setTimeout(() => this.touchLongPress(), 520);
    this.touchPending = { down: e, sx: e.clientX, sy: e.clientY, started: false, long: false, timer };
  }

  private touchMove(e: PointerEvent) {
    const t = this.touchPts.get(e.pointerId);
    if (!t) return;
    this.lastTouch = performance.now();
    t.x = e.clientX; t.y = e.clientY;
    if (this.pinch) { this.updatePinch(); return; }
    const p = this.touchPending;
    if (!p || this.pinchLock || p.long) return;
    if (!p.started) {
      if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < 9) return;
      clearTimeout(p.timer);
      p.started = true;
      this.onMove(p.down);
      this.touchDragStart = true;
      try { this.onDown(p.down); } finally { this.touchDragStart = false; }
    }
    this.onMove(e);
  }

  private touchUp(e: PointerEvent) {
    this.lastTouch = performance.now();
    const known = this.touchPts.delete(e.pointerId);
    try { this.overlay.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.pinch) { if (this.touchPts.size < 2) { this.pinch = null; this.pinchLock = this.touchPts.size > 0; } return; }
    if (this.pinchLock) { if (!this.touchPts.size) this.pinchLock = false; return; }
    const p = this.touchPending;
    this.touchPending = null;
    if (!p || !known) return;
    clearTimeout(p.timer);
    if (p.long) return;
    if (p.started) { this.onUp(e); return; }
    // tap: show the pixel under the finger and click with the current tool
    this.onMove(p.down);
    this.onDown(p.down);
    this.onUp(e);
    const now = performance.now();
    if (this.lastTap && now - this.lastTap.t < 380 && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 30) {
      this.lastTap = null;
      this.touchDoubleTap(e);
    } else this.lastTap = { t: now, x: e.clientX, y: e.clientY };
  }

  private touchCancel(e: PointerEvent) {
    this.touchPts.delete(e.pointerId);
    this.cancelTouchPending();
    if (this.touchPts.size < 2) this.pinch = null;
    if (!this.touchPts.size) this.pinchLock = false;
    this.drag = null;
  }

  private cancelTouchPending() {
    if (this.touchPending) { clearTimeout(this.touchPending.timer); this.touchPending = null; }
  }

  private touchLongPress() {
    const p = this.touchPending;
    if (!p || p.started || !this.current) return;
    p.long = true;
    noteLongPress();
    try { navigator.vibrate?.(12); } catch { /* not allowed */ }
    this.onMove(p.down);
    this.onContext(p.down);
  }

  private touchDoubleTap(e: PointerEvent) {
    const s = this.ctx.store;
    const navTool = ["pointer", "histogram", "fileinfo", "clock"].includes(s.ui.tool);
    if (navTool && !this.targets().length && this.current) {
      // like photo apps: double tap zooms in around the finger, or back to fit
      if (this.isFit) this.zoomAt(this.toImage(e), 2.5);
      else this.fit();
      return;
    }
    this.onDbl(e);
  }

  private startPinch() {
    const [a, b] = [...this.touchPts.values()];
    const g = this.geom(), r = this.stage.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    this.pinch = { d0: Math.max(12, Math.hypot(a.x - b.x, a.y - b.y)), z0: g.zoom, ix: (mx - g.ox) / g.zoom, iy: (my - g.oy) / g.zoom };
  }

  private updatePinch() {
    const pz = this.pinch!;
    const [a, b] = [...this.touchPts.values()];
    const r = this.stage.getBoundingClientRect();
    const v = this.view();
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    const z = clamp(pz.z0 * Math.hypot(a.x - b.x, a.y - b.y) / pz.d0, 0.01, 64);
    const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    v.fit = false; v.zoom = z;
    v.cx = pz.ix - (mx - W / 2) / z; v.cy = pz.iy - (my - H / 2) / z;
    this.draw();
    this.ctx.bus.emit("view", null);
  }

  private onDbl(e: MouseEvent) {
    const s = this.ctx.store;
    if (s.ui.tool === "polygon" && s.ui.polygon.length > 2) return;
    const ts = this.targets();
    const p = this.toImage(e);
    for (const t of ts) {
      if (t.type !== "points") continue;
      const hdl = this.handleHit(p, t);
      if (hdl) { const list = (t.value as Pt[]).filter((_, i) => String(i) !== hdl); this.setParam(t.key, list, false); return; }
    }
    if (!ts.length && (s.ui.tool === "pointer" || s.ui.tool === "histogram" || s.ui.tool === "fileinfo" || s.ui.tool === "clock")) this.fit();
  }

  private onContext(e: MouseEvent) {
    e.preventDefault();
    const s = this.ctx.store;
    const p = this.toImage(e);
    const ts = this.targets();
    const dpr = window.devicePixelRatio || 1, mode = s.prefs.viewerInterp ?? "sharp";
    const setMode = (m: "sharp" | "nearest" | "smooth") => s.savePrefs({ viewerInterp: m });
    const items: any[] = [
      { label: "Fit Window", shortcut: "0", action: () => this.fit() },
      { label: "Zoom 100%", shortcut: "1", action: () => this.setZoom(1) },
      // on scaled displays 100 % is one CSS pixel; this is one physical screen pixel per image pixel
      ...(Math.abs(dpr - 1) > 0.01 ? [{ label: `Actual Pixels (1 image pixel = 1 screen pixel, ${+(100 / dpr).toFixed(2)}%)`, action: () => this.setZoom(1 / dpr) }] : []),
      { label: "Zoom In", shortcut: "+", action: () => this.zoomAt(p, 2) },
      { label: "Zoom Out", shortcut: "-", action: () => this.zoomAt(p, 0.5) },
      { label: "Display", items: [
        { label: "Sharp (equal-size pixels at any zoom)", checked: mode === "sharp", action: () => setMode("sharp") },
        { label: "Nearest Neighbor", checked: mode === "nearest", action: () => setMode("nearest") },
        { label: "Smooth (Bilinear)", checked: mode === "smooth", action: () => setMode("smooth") },
      ] },
      "-",
      { label: "Copy Frame to Clipboard", action: () => void this.ctx.actions.copyFrame() },
      { label: "Save Snapshot…", action: () => void this.ctx.actions.snapshot() },
    ];
    if (ts.length) {
      items.push("-");
      for (const t of ts) items.push({ label: `Clear "${t.key}"`, action: () => this.setParam(t.key, t.type === "points" ? [] : null, false) });
    }
    if (s.ui.selection) items.push("-", { label: "Crop to Selection", action: () => this.ctx.actions.addFilter("crop", { rect: { ...s.ui.selection! } }) });
    showContextMenu(e.clientX, e.clientY, items);
  }

  private onWheel(e: WheelEvent) {
    if (!this.current) return;
    e.preventDefault();
    const p = this.toImage(e);
    this.zoomAt(p, Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1)));
  }

  private updateCursor(p: Pt) {
    const s = this.ctx.store;
    let cur = "default";
    for (const t of this.targets()) { const hdl = this.handleHit(p, t); if (hdl) { cur = hdl === "move" || hdl === "in" ? "move" : /^[nsew]+$/.test(hdl) ? `${hdl}-resize` : "pointer"; break; } }
    if (cur === "default") {
      if (this.targets().length) cur = "crosshair";
      else if (s.ui.tool === "zoom") cur = "zoom-in";
      else if (["selector", "ruler", "polygon", "curve", "crosshair"].includes(s.ui.tool)) cur = "crosshair";
      else cur = "grab";
    }
    this.overlay.style.cursor = cur;
  }

  // ------------------------------------------------------------ zoom API
  fit() { const v = this.view(); v.fit = true; this.draw(); this.ctx.bus.emit("view", null); }
  setZoom(z: number, at?: Pt) {
    const v = this.view(), g = this.geom();
    const c = at ?? { x: v.fit ? g.fw / 2 : v.cx, y: v.fit ? g.fh / 2 : v.cy };
    if (v.fit) { v.cx = g.fw / 2; v.cy = g.fh / 2; }
    const nz = clamp(z, 0.01, 64);
    if (at) {
      const sx = g.ox + at.x * g.zoom, sy = g.oy + at.y * g.zoom;
      v.cx = at.x - (sx - g.W / 2) / nz; v.cy = at.y - (sy - g.H / 2) / nz;
    } else { v.cx = c.x; v.cy = c.y; }
    v.zoom = nz; v.fit = false;
    this.draw();
    this.ctx.bus.emit("view", null);
  }
  zoomAt(p: Pt, factor: number) { this.setZoom(this.geom().zoom * factor, p); }
  zoomToRect(r: RectP) {
    const g = this.geom(), v = this.view();
    v.zoom = clamp(Math.min(g.W / r.w, g.H / r.h) * 0.95, 0.01, 64); v.fit = false; v.cx = r.x + r.w / 2; v.cy = r.y + r.h / 2;
    this.draw(); this.ctx.bus.emit("view", null);
  }
  centerOn(p: Pt) { const v = this.view(), g = this.geom(); if (v.fit) { v.zoom = g.zoom; v.fit = false; } v.cx = p.x; v.cy = p.y; this.draw(); this.ctx.bus.emit("view", null); }
  viewport(): RectP | null {
    if (!this.current) return null;
    const g = this.geom();
    return { x: -g.ox / g.zoom, y: -g.oy / g.zoom, w: g.W / g.zoom, h: g.H / g.zoom };
  }
  get isFit() { return this.view().fit; }
  frameCanvasEl() { return this.frameCanvas; }

  // ------------------------------------------------------------ overlay drawing
  drawOverlay() {
    const dpr = window.devicePixelRatio || 1;
    const c = this.overlay.getContext("2d")!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!this.current) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = this.ctx.store, ui = s.ui;
    const g = this.geom();
    const S = (p: Pt) => this.toScreen(p);
    c.lineWidth = 1.5;
    if (this.primary) {
      if (ui.selection) {
        const r = ui.selection, a = S({ x: r.x, y: r.y });
        c.save(); c.setLineDash([5, 4]); c.strokeStyle = "#ffffff"; c.strokeRect(a.x, a.y, r.w * g.zoom, r.h * g.zoom);
        c.lineDashOffset = 5; c.strokeStyle = "#000"; c.strokeRect(a.x, a.y, r.w * g.zoom, r.h * g.zoom); c.restore();
        if (ui.tool === "selector") drawRectHandles(c, a.x, a.y, r.w * g.zoom, r.h * g.zoom, "#fff");
      }
      if (ui.ruler) drawMeasureLine(c, S(ui.ruler[0]), S(ui.ruler[1]), "#ffd400", `${Math.hypot(ui.ruler[1].x - ui.ruler[0].x, ui.ruler[1].y - ui.ruler[0].y).toFixed(1)} px`);
      if (ui.profile) drawMeasureLine(c, S(ui.profile[0]), S(ui.profile[1]), "#00e5ff", "profile");
      if (ui.polygon.length) {
        c.strokeStyle = "#7cff4f"; c.fillStyle = "rgba(124,255,79,0.15)";
        c.beginPath(); ui.polygon.forEach((q, i) => { const a = S(q); i ? c.lineTo(a.x, a.y) : c.moveTo(a.x, a.y); });
        if (ui.polygon.length > 2) c.closePath();
        c.fill(); c.stroke();
        for (const q of ui.polygon) { const a = S(q); c.fillStyle = "#7cff4f"; c.fillRect(a.x - 3, a.y - 3, 6, 6); }
      }
      const ch = ui.crosshair ?? (ui.tool === "crosshair" ? this.hover : null);
      if (ch) {
        const a = S(ch);
        c.strokeStyle = ui.crosshair ? "#ff3b30" : "rgba(255,59,48,0.7)"; c.setLineDash([]);
        c.beginPath(); c.moveTo(0, a.y); c.lineTo(g.W, a.y); c.moveTo(a.x, 0); c.lineTo(a.x, g.H); c.stroke();
        label(c, `${ch.x.toFixed(1)}, ${ch.y.toFixed(1)}`, a.x + 8, a.y + 8, "#ff3b30");
      }
      // filter parameter overlays
      const ts = this.targets();
      const act = this.activeTarget(ts);
      for (const t of ts) {
        const active = act?.key === t.key;
        c.strokeStyle = t.color; c.fillStyle = t.color; c.lineWidth = active ? 2 : 1.4; c.setLineDash(active ? [] : [6, 4]);
        const v = t.value;
        if (!v || (Array.isArray(v) && !v.length)) continue;
        if (t.type === "rect") { const a = S({ x: v.x, y: v.y }); c.strokeRect(a.x, a.y, v.w * g.zoom, v.h * g.zoom); c.setLineDash([]); drawRectHandles(c, a.x, a.y, v.w * g.zoom, v.h * g.zoom, t.color); label(c, `${Math.round(v.w)}×${Math.round(v.h)}`, a.x + 4, a.y - 18, t.color); }
        else if (t.type === "point") { const a = S(v); c.setLineDash([]); c.beginPath(); c.arc(a.x, a.y, 6, 0, Math.PI * 2); c.stroke(); c.beginPath(); c.moveTo(a.x - 10, a.y); c.lineTo(a.x + 10, a.y); c.moveTo(a.x, a.y - 10); c.lineTo(a.x, a.y + 10); c.stroke(); }
        else if (t.type === "line") { drawMeasureLine(c, S(v[0]), S(v[1]), t.color, `${Math.hypot(v[1].x - v[0].x, v[1].y - v[0].y).toFixed(1)} px`); }
        else if (t.type === "points") {
          if (t.polyline) {
            c.beginPath(); (v as Pt[]).forEach((q, i) => { const a = S(q); i ? c.lineTo(a.x, a.y) : c.moveTo(a.x, a.y); });
            if (t.closed && v.length === (t.maxPoints ?? 0)) c.closePath();
            c.stroke();
          } else for (const q of v as Pt[]) { const a = S(q); c.beginPath(); c.arc(a.x, a.y, 9, 0, Math.PI * 2); c.stroke(); }
          c.setLineDash([]);
          (v as Pt[]).forEach((q, i) => { const a = S(q); c.fillStyle = "#000"; c.fillRect(a.x - 4, a.y - 4, 8, 8); c.fillStyle = t.color; c.fillRect(a.x - 3, a.y - 3, 6, 6); if (t.maxPoints && t.maxPoints <= 8) label(c, String(i + 1), a.x + 6, a.y + 4, t.color); });
        }
      }
      c.setLineDash([]);
      const f = s.selectedFilter();
      const def = f ? FILTERS[f.type] : null;
      if (def?.overlayOn === "input" && !ui.showInput && def.params.some((pd: ParamDef) => isOverlayParam(pd))) {
        label(c, "Press \"Show Input\" in Filter Settings to edit this filter on the Viewer", 10, g.H - 26, "#ffd400");
      }
    }
    const d = this.drag;
    if (d?.kind === "zoomrect") {
      const a = S(d.a), b = S(d.b);
      c.strokeStyle = "#fff"; c.setLineDash([4, 3]); c.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); c.setLineDash([]);
    }
  }
}

// ---------------------------------------------------------------- geometry helpers
function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (!l2) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
  return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
}

function rectHit(p: Pt, r: RectP, tol: number): string | null {
  const l = r.x, t = r.y, rr = r.x + r.w, b = r.y + r.h;
  const nx = Math.abs(p.x - l) <= tol, fx = Math.abs(p.x - rr) <= tol, ny = Math.abs(p.y - t) <= tol, fy = Math.abs(p.y - b) <= tol;
  const inX = p.x > l - tol && p.x < rr + tol, inY = p.y > t - tol && p.y < b + tol;
  if (nx && ny) return "nw"; if (fx && ny) return "ne"; if (nx && fy) return "sw"; if (fx && fy) return "se";
  if (ny && inX) return "n"; if (fy && inX) return "s"; if (nx && inY) return "w"; if (fx && inY) return "e";
  if (p.x > l && p.x < rr && p.y > t && p.y < b) return "move";
  return null;
}

function dragRect(o: RectP, hdl: string, dx: number, dy: number): RectP {
  let { x, y, w, h: hh } = o;
  if (hdl === "move") return { x: x + dx, y: y + dy, w, h: hh };
  if (hdl.includes("w")) { x += dx; w -= dx; }
  if (hdl.includes("e")) w += dx;
  if (hdl.includes("n")) { y += dy; hh -= dy; }
  if (hdl.includes("s")) hh += dy;
  return normRect({ x, y, w, h: hh });
}

const normRect = (r: RectP): RectP => ({ x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) });
const roundRect = (r: RectP): RectP => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
function clipRect(r: RectP, W: number, H: number): RectP {
  const x = clamp(r.x, 0, W), y = clamp(r.y, 0, H);
  return { x, y, w: clamp(r.w, 0, W - x), h: clamp(r.h, 0, H - y) };
}

function drawRectHandles(c: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, color: string) {
  c.fillStyle = color;
  for (const [px, py] of [[x, y], [x + w, y], [x, y + hh], [x + w, y + hh], [x + w / 2, y], [x + w / 2, y + hh], [x, y + hh / 2], [x + w, y + hh / 2]]) { c.fillStyle = "#000"; c.fillRect(px - 4, py - 4, 8, 8); c.fillStyle = color; c.fillRect(px - 3, py - 3, 6, 6); }
}

function drawMeasureLine(c: CanvasRenderingContext2D, a: Pt, b: Pt, color: string, text: string) {
  c.save();
  c.strokeStyle = "#000"; c.lineWidth = 3.5; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
  c.strokeStyle = color; c.lineWidth = 1.6; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
  for (const q of [a, b]) { c.fillStyle = "#000"; c.beginPath(); c.arc(q.x, q.y, 4.5, 0, Math.PI * 2); c.fill(); c.fillStyle = color; c.beginPath(); c.arc(q.x, q.y, 3, 0, Math.PI * 2); c.fill(); }
  label(c, text, (a.x + b.x) / 2 + 8, (a.y + b.y) / 2 + 6, color);
  c.restore();
}

function label(c: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  c.save();
  c.font = "12px 'Segoe UI', Roboto, sans-serif";
  const w = c.measureText(text).width;
  c.fillStyle = "rgba(0,0,0,0.7)"; c.fillRect(x - 3, y - 1, w + 6, 16);
  c.fillStyle = color; c.textBaseline = "top"; c.fillText(text, x, y + 1);
  c.restore();
}
