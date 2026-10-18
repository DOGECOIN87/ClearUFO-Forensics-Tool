// User commands.
import { BRAND } from "../brand";
import { FILTERS, defaultParams, normalizeParams } from "../shared/filters";
import type { ChainDoc, DvrScanResult, FilterInstance, ProjectDoc, SourceInfo, SourceKind, StreamInfo, WriteRequest, WriteResult } from "../shared/types";
import { estimateBytes, FORMATS, formatLabel, frameBytes, IMAGE_EXPORT, isWriteFormat, outputFile, VIDEO_EXPORT, type WriteFormat } from "../shared/formats";
import { encodePNG, rgbFromRGBA } from "../shared/codecs/image";
import { canvasReadbackExact } from "../engine/pixelcheck";
import { FileSink, STORAGE_FULL } from "../shared/codecs/sink";
import { captureLossless } from "./capture";
import { Staging, type StagingStatus } from "./staging";
import { alertDialog, confirmDialog, dialog, progressDialog, promptDialog, toast } from "../ui/dialog";
import { download, fmtBytes, fmtTime, h, pickFiles, uid } from "../ui/dom";
import { touchText } from "../ui/touch";
import { checkBox, selectBox, spinBox } from "../ui/controls";
import { autoThreads } from "../shared/threads";
import { gpuStatus } from "../gpu/preview";
import type { AppCtx } from "./context";
import { buildReport } from "./report";
import { sniffFile, withArticle, type Sniffed } from "../shared/sniff";
import { explainError } from "../shared/errors";
import { migrateProject, validateProject } from "../shared/project";

const IMAGE_EXT = /\.(png|jpe?g|bmp|gif|webp|avif|tiff?|ico|heic|heif)$/i;
const baseName = (n: string) => n.replace(/\.[^.]+$/, "");

/** Pages shown inside another site may not open save dialogs (File System Access throws SecurityError). */
const crossOriginFrame = (() => { try { return window.top !== window.self && !window.top!.location.href; } catch { return true; } })();

/** Where an export goes: a file the user picks, a staging file in the browser's storage, or memory. */
export type ExportTarget = { kind: "picker" } | { kind: "staging"; status: StagingStatus } | { kind: "memory"; status: StagingStatus | null };

/** Safari cannot encode WebP (canvas encoders fall back to PNG without an error). */
function canEncodeWebP(): boolean {
  try { const c = document.createElement("canvas"); c.width = c.height = 1; return c.toDataURL("image/webp").startsWith("data:image/webp"); } catch { return false; }
}

export class Actions {
  private clipboard: FilterInstance | null = null;
  private lastDvr: { codec: string; fps: number; container: string } = { codec: "auto", fps: 0, container: "auto" };
  ctx!: AppCtx;

  get hasClipboardFilter() { return !!this.clipboard; }
  private stagingMgr: Staging | null = null;
  /** Staged downloads (browser storage on disk) for browsers that cannot write to a picked file. */
  get staging(): Staging { return (this.stagingMgr ??= new Staging(this.e)); }
  private get s() { return this.ctx.store; }
  private get e() { return this.ctx.engine; }

  // ------------------------------------------------------------ media loading
  async openMedia() {
    const files = await pickFiles("image/*,video/*,.avi,.mkv,.mov,.mp4,.m4v,.ts,.mts,.m2ts,.webm,.3gp,.h264,.264,.h265,.265,.hevc,.dav,.mjpg,.mjpeg,.ps,.mpg,.tif,.tiff", true);
    if (files.length) await this.loadFiles(files);
  }

  async openSequence() {
    const files = await pickFiles("image/*,.tif,.tiff", true);
    if (files.length) await this.loadFiles(files, "sequence");
  }

  /**
   * Single entry point for files coming from pickers, drag & drop and the toolbar. Files are
   * routed by their content (magic bytes), never by extension or by the command used to pick
   * them: a project is opened as a project, media is loaded as media, anything else is
   * refused with an explanation.
   */
  async loadFiles(files: File[], kind: SourceKind | "auto" = "auto") {
    if (!files.length) return;
    const sniffed = await Promise.all(files.map((f) => sniffFile(f)));
    const info = new Map(files.map((f, i) => [f, sniffed[i]] as const));
    const pi = sniffed.findIndex((s) => s.kind === "project");
    if (pi >= 0 && kind === "auto") {
      if (files.length > 1) toast(`Opening the project “${files[pi].name}”. The other ${files.length - 1} selected file(s) were not loaded.`, "info", 7000);
      await this.openProjectFile(files[pi], sniffed[pi]);
      return;
    }
    const refused = files.filter((f) => { const s = info.get(f)!; return s.kind === "project" || (s.definite && (s.kind === "other" || s.kind === "audio")); });
    if (refused.length) this.explainRefused(refused.map((f) => [f, info.get(f)!]), files.length);
    const usable = files.filter((f) => !refused.includes(f));
    const images = usable.filter((f) => { const s = info.get(f)!; return s.kind === "image" || (s.kind === "other" && (IMAGE_EXT.test(f.name) || f.type.startsWith("image/"))); });
    const others = usable.filter((f) => !images.includes(f));
    if (kind === "sequence" || (images.length > 1 && kind === "auto" && (await this.askSequence(images.length)))) {
      if (images.length) await this.loadGroup(images, "sequence");
    } else for (const f of images) await this.loadGroup([f], "image");
    for (const f of others) await this.loadGroup([f], kind === "dvr" ? "dvr" : "auto");
  }

  private explainRefused(list: [File, Sniffed][], total: number) {
    const why = (f: File, s: Sniffed) =>
      s.kind === "project" ? `“${f.name}” is a project file. Open it with File › Open Project….`
      : s.kind === "audio" ? `“${f.name}” is ${withArticle(s.label)} file without video. ${BRAND.name} analyzes images and video: load the video that contains this audio instead.`
      : `“${f.name}” is ${withArticle(s.label)}, not an image or a video.`;
    if (total === 1) void alertDialog("Unable to load the file", h("div", { class: "dlg-msg" }, why(...list[0])));
    else for (const [f, s] of list) toast(`Skipped: ${why(f, s)}`, "error", 9000);
  }

  private askSequence(n: number): Promise<boolean> {
    return new Promise((resolve) => {
      let r = false;
      dialog({ title: "Load Images", body: h("div", { class: "dlg-msg" }, `${n} images were selected. Load them as a single image sequence (video) or as separate chains?`), onClose: () => resolve(r),
        buttons: [{ label: "Separate Chains" }, { label: "Image Sequence", primary: true, action: () => { r = true; } }] });
    });
  }

  async loadGroup(files: File[], kind: SourceKind | "auto", options: Record<string, any> = {}, existingId?: string): Promise<SourceInfo | null> {
    const id = existingId ?? uid("src");
    if (files.length > 1) { const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }); files = [...files].sort((a, b) => coll.compare(a.name, b.name)); }
    const name = files.length > 1 ? `${files[0].name} (+${files.length - 1})` : files[0].name;
    this.s.status(`Loading ${name}…`);
    try {
      const info = await this.e.call<SourceInfo>("openSource", id, files, kind, { fps: this.s.prefs.defaultFps, ...options });
      this.registerSource(info, files, options);
      if (!existingId) {
        const loader = info.kind === "image" ? "image_loader" : info.kind === "sequence" ? "sequence_loader" : "video_loader";
        const def = FILTERS[loader];
        const chain: ChainDoc = { id: uid("chain"), name: baseName(files[0].name), filters: [{ id: uid("f"), type: loader, params: { ...defaultParams(def), source: id, ...(loader === "sequence_loader" ? { fps: info.fps } : {}) }, enabled: true }] };
        this.s.mutate((p) => p.chains.push(chain));
        this.s.setUi({ chainId: chain.id });
        this.s.selectFilter(null, chain.id);
      } else {
        this.s.syncEngine();
        this.s.emit("project", { structural: true });
      }
      for (const w of info.warnings) toast(w, "info", 7000);
      if (info.kind === "video") iosPickerTip();
      this.s.status(`Loaded ${name}: ${info.width} x ${info.height}, ${info.frameCount} frame${info.frameCount === 1 ? "" : "s"}${info.frameCount > 1 ? `, ${info.fps.toFixed(3)} fps` : ""}.`);
      return info;
    } catch (err) {
      this.s.status("Ready.");
      void alertDialog("Unable to load the file", h("div", { class: "dlg-msg" }, h("b", null, name), h("p", null, (err as Error).message), h("p", { class: "muted small" }, "Tip: for proprietary DVR formats use Utilities › Convert DVR. Browsers cannot decode some legacy codecs (e.g. MPEG-4 Part 2).")));
      return null;
    }
  }

  registerSource(info: SourceInfo, files: File[], options: Record<string, any> = {}) {
    this.s.sources.set(info.id, info);
    this.s.files.set(info.id, files);
    this.ctx.mtVideo.register(info.id, files[0]);
    this.s.project.sources[info.id] = { ...(this.s.project.sources[info.id] ?? {}), id: info.id, kind: info.kind, name: info.name, files: files.map((f) => ({ name: f.name, size: f.size, lastModified: f.lastModified, type: f.type })), options };
    if (info.hasAudio && files.length === 1) void this.ctx.audio.load(info.id, files[0]);
    this.s.emit("sources");
  }

  async pasteImage(blob?: Blob) {
    try {
      if (!blob) {
        if (!navigator.clipboard?.read) { toast("This browser cannot read images from the clipboard here. Use Ctrl+V (or long-press › Paste on a text field), or File › Load Image or Video.", "error"); return; }
        const items = await navigator.clipboard.read();
        for (const it of items) { const t = it.types.find((x) => x.startsWith("image/")); if (t) { blob = await it.getType(t); break; } }
      }
      if (!blob) { toast("The clipboard does not contain an image.", "error"); return; }
      const file = new File([blob], `Pasted Image ${new Date().toLocaleTimeString().replace(/:/g, ".")}.png`, { type: blob.type || "image/png" });
      await this.loadGroup([file], "image");
    } catch (e) { const m = explainError(e, "Paste Image", { permission: "clipboard" }); if (m) toast(m, "error"); }
  }

  addTestPattern(params: Record<string, any> = {}, name = "Test Pattern") {
    const def = FILTERS.test_pattern;
    const chain: ChainDoc = { id: uid("chain"), name, filters: [{ id: uid("f"), type: "test_pattern", params: { ...defaultParams(def), ...params }, enabled: true }] };
    this.s.mutate((p) => p.chains.push(chain));
    this.s.setUi({ chainId: chain.id });
    return chain;
  }

  async captureVideo() {
    if (!navigator.mediaDevices?.getUserMedia) { toast("Video capture is not available in this browser (it requires a secure https:// page).", "error"); return; }
    // Lossless capture grabs every frame uncompressed; the browser recorder (lossy) is offered only
    // when lossy formats are allowed.
    const recorder = typeof MediaRecorder !== "undefined";
    const lossyAllowed = !this.s.prefs.losslessOnly && recorder;
    let mode = "lossless" as "lossless" | "compressed";
    let stream: MediaStream;
    // phones and tablets cannot capture the screen: offer the camera only
    const canScreen = typeof navigator.mediaDevices.getDisplayMedia === "function";
    const src = await new Promise<string | null>((resolve) => {
      let r: string | null = null;
      const how = lossyAllowed
        ? h("div", { class: "form-row" }, h("span", null, "Recording:"), selectBox([["lossless", "Lossless: every frame uncompressed (AVI)"], ["compressed", "Compressed: browser recorder (smaller, lossy)"]], mode, (v) => { mode = v as typeof mode; }))
        : h("p", { class: "muted small" }, "Lossless: every frame is captured uncompressed (AVI, RGB 8 bits per channel), exactly as the browser delivers it.");
      dialog({ title: "Video Input", body: h("div", { class: "form" }, h("div", { class: "dlg-msg" }, canScreen ? "Record from a camera or capture a screen/window. The recording is loaded as a new chain." : "Record from a camera. The recording is loaded as a new chain."), how), onClose: () => resolve(r),
        buttons: [{ label: "Cancel" }, ...(canScreen ? [{ label: "Screen", action: () => { r = "screen"; } }] : []), { label: "Camera", primary: true, action: () => { r = "camera"; } }] });
    });
    if (!src) return;
    const audio = mode === "compressed";
    try { stream = src === "screen" ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }) : await navigator.mediaDevices.getUserMedia({ video: true, audio }); }
    catch (e) {
      // the camera may be fine but the microphone denied or missing: retry without audio
      if (src === "camera" && audio && (e as Error).name !== "AbortError") { try { stream = await navigator.mediaDevices.getUserMedia({ video: true }); } catch (e2) { const m = explainError(e2, "Video Input", { permission: "camera" }); if (m) toast(m, "error"); return; } }
      else { const m = explainError(e, "Video Input", { permission: src === "screen" ? "screen" : "camera", notAllowedIsCancel: src === "screen" }); if (m) toast(m, "error"); return; }
    }
    if (mode === "lossless") {
      await captureLossless({ canSaveToDisk: () => this.canSaveToDisk(), pickSaveFile: (n, m, x, d) => this.pickSaveFile(n, m, x, d), loadFile: async (f) => { await this.loadGroup([f], "video"); }, staging: this.staging }, stream);
      return;
    }
    const video = h("video", { autoplay: true, muted: true, playsinline: true, style: { width: "100%", background: "#000" } }) as HTMLVideoElement;
    video.srcObject = stream;
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    const status = h("div", { class: "muted small" }, "Recording (compressed)…");
    const t0 = Date.now();
    const timer = setInterval(() => { status.textContent = `Recording (compressed)… ${fmtTime((Date.now() - t0) / 1000)}`; }, 250);
    rec.start(500);
    await new Promise<void>((resolve) => dialog({ title: "Video Input — Recording", body: h("div", null, video, status), width: 560, onClose: resolve, buttons: [{ label: "Stop and Load", primary: true }] }));
    clearInterval(timer);
    await new Promise<void>((r) => { rec.onstop = () => r(); rec.stop(); });
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: rec.mimeType || "video/webm" });
    if (!blob.size) return;
    await this.loadGroup([new File([blob], `Capture ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${blob.type.includes("mp4") ? "mp4" : "webm"}`, { type: blob.type })], "video");
  }

  // ------------------------------------------------------------ chains
  newChain() {
    toast("Load an image or video to create a new chain (File › Open), or add a Load / Link filter.", "info");
  }

  async renameChain(id: string) {
    const c = this.s.chain(id);
    if (!c) return;
    const n = await promptDialog("Rename Chain", "Name:", c.name);
    if (n && n.trim()) this.s.mutate((p) => { p.chains.find((x) => x.id === id)!.name = n.trim(); });
  }

  duplicateChain(id: string) {
    const c = this.s.chain(id);
    if (!c) return;
    const copy: ChainDoc = { id: uid("chain"), name: `${c.name} (copy)`, filters: c.filters.map((f) => ({ ...structuredClone(f), id: uid("f") })) };
    this.s.mutate((p) => p.chains.splice(p.chains.findIndex((x) => x.id === id) + 1, 0, copy));
    this.s.setUi({ chainId: copy.id });
  }

  async deleteChain(id: string) {
    const c = this.s.chain(id);
    if (!c) return;
    if (this.s.prefs.confirmDelete && c.filters.length > 1 && !(await confirmDialog("Delete Chain", `Delete the chain "${c.name}" and its ${c.filters.length} filters?`, "Delete", true))) return;
    const idx = this.s.project.chains.findIndex((x) => x.id === id);
    this.s.mutate((p) => {
      p.chains = p.chains.filter((x) => x.id !== id);
      p.bookmarks = p.bookmarks.filter((b) => b.chainId !== id);
      for (const ch of p.chains) for (const f of ch.filters) for (const [k, v] of Object.entries(f.params)) {
        if (v === id) f.params[k] = "";
        else if (Array.isArray(v) && v.includes(id)) f.params[k] = v.filter((x: string) => x !== id);
      }
    });
    if (this.s.ui.chainId === id) this.s.setUi({ chainId: this.s.project.chains[Math.max(0, idx - 1)]?.id ?? null });
  }

  openViewer(chainId?: string) {
    this.ctx.openViewer(chainId ?? this.s.ui.chainId ?? undefined);
  }

  // ------------------------------------------------------------ filters
  addFilter(type: string, params: Record<string, any> = {}) {
    const def = FILTERS[type];
    if (!def) return;
    const s = this.s;
    if (def.kind === "loader") {
      if (type === "test_pattern") { this.addTestPattern(params); return; }
      if (type === "sequence_loader") { void this.openSequence(); return; }
      void this.openMedia();
      return;
    }
    let chain = s.chain();
    if (!chain) { toast("Load an image or video first (drag it on the Viewer or use File › Open).", "info"); return; }
    const sel = s.selectedFilter();
    let idx = sel ? chain.filters.findIndex((f) => f.id === sel.id) + 1 : chain.filters.length;
    if (idx < 1) idx = 1;
    const p = { ...defaultParams(def), ...this.defaultsFor(type, chain), ...params };
    const f: FilterInstance = { id: uid("f"), type, params: p, enabled: true };
    s.mutate((pr) => { pr.chains.find((c) => c.id === chain!.id)!.filters.splice(idx, 0, f); });
    s.selectFilter(f.id);
    const firstOverlay = def.params.find((pd) => ["rect", "points", "line", "point"].includes(pd.type));
    if (def.overlayOn === "input" && firstOverlay && (p[firstOverlay.key] === null || (Array.isArray(p[firstOverlay.key]) && !p[firstOverlay.key].length) || type === "crop")) s.setUi({ showInput: true });
    else if (s.ui.showInput) s.setUi({ showInput: false });
    s.status(`Added ${def.name}.${def.slow ? " (intensive filter: processing may take a few seconds)" : ""}`);
  }

  /** Parameters that depend on the context (selection, current frame, size, other chains) for a new filter. */
  defaultsFor(type: string, chain: ChainDoc): Record<string, any> {
    const s = this.s, r = s.lastRender, sel = s.ui.selection;
    const W = r?.width ?? 640, H = r?.height ?? 480;
    const center = (k: number) => ({ x: Math.round(W * (1 - k) / 2), y: Math.round(H * (1 - k) / 2), w: Math.round(W * k), h: Math.round(H * k) });
    const others = s.project.chains.filter((c) => c.id !== chain.id).map((c) => c.id);
    const frame = s.frameOf();
    const io = s.ui.inOut[chain.id];
    switch (type) {
      case "crop": return { rect: sel ? { ...sel } : center(0.6) };
      case "hide_selection": case "spotlight": case "magnify": return { rect: sel ? { ...sel } : center(0.3) };
      case "add_shape": return { rect: sel ? { ...sel } : center(0.3), line: s.ui.ruler ?? null };
      case "local_stabilization": return { roi: sel ? { ...sel } : null, reference: frame };
      case "global_stabilization": case "demultiplexer": return { reference: frame, roi: type === "demultiplexer" && sel ? { ...sel } : null };
      case "super_resolution": case "motion_detection": case "remove_duplicates": return sel ? { roi: { ...sel } } : {};
      case "single_selector": case "freeze_frame": return { frame };
      case "range_selector": return io ? { start: io[0] ?? 0, end: io[1] ?? -1 } : {};
      case "sparse_selector": return { frames: String(frame) };
      case "add_text": return { position: { x: Math.round(W * 0.04), y: Math.round(H * 0.04) }, size: Math.max(12, Math.round(H / 18)) };
      case "add_timestamp": return { size: Math.max(12, Math.round(H / 26)) };
      case "video_mixer": return { second: others[0] ?? "" };
      case "picture_in_picture": return { inset: others[0] ?? "" };
      case "replace_channel": return { source: others[0] ?? "" };
      case "multiview": case "timeline": return { chains: others };
      case "measure_1d": return s.ui.ruler ? { refLine: s.ui.ruler } : {};
      case "motion_deblurring": {
        const l = s.ui.ruler;
        return l ? { line: l, length: Math.max(1, Math.hypot(l[1].x - l[0].x, l[1].y - l[0].y)), angle: (Math.atan2(-(l[1].y - l[0].y), l[1].x - l[0].x) * 180) / Math.PI } : {};
      }
      case "white_balance": return { point: s.ui.crosshair ?? null };
      case "resize": return { width: W * 2, height: H * 2 };
      case "add_grid": return { spacing: Math.max(8, Math.round(Math.min(W, H) / 8)) };
      default: return {};
    }
  }

  setParam(filterId: string, key: string, value: any, coalesce?: string) {
    this.s.mutate((p) => {
      for (const c of p.chains) {
        const f = c.filters.find((x) => x.id === filterId);
        if (!f) continue;
        f.params = { ...f.params, [key]: value };
        if (f.type === "motion_deblurring" && key === "line" && value) {
          const [a, b] = value;
          f.params.length = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) * 10) / 10);
          f.params.angle = Math.round(((Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI) * 10) / 10;
        }
      }
    }, { coalesce: coalesce ?? `${filterId}:${key}:${Date.now()}`, structural: false });
  }

  toggleFilter(filterId: string, enabled: boolean) {
    this.s.mutate((p) => { for (const c of p.chains) { const i = c.filters.findIndex((x) => x.id === filterId); if (i > 0) c.filters[i].enabled = enabled; } }, { structural: false });
  }

  resetFilter(filterId: string) {
    this.s.mutate((p) => {
      for (const c of p.chains) {
        const f = c.filters.find((x) => x.id === filterId);
        if (!f) continue;
        const keep = f.params.source;
        f.params = defaultParams(FILTERS[f.type]);
        if (keep) f.params.source = keep;
      }
    });
    this.s.emit("ui", new Set(["selected"]));
  }

  async removeFilter(filterId: string) {
    const c = this.s.project.chains.find((x) => x.filters.some((f) => f.id === filterId));
    if (!c) return;
    const i = c.filters.findIndex((f) => f.id === filterId);
    if (i === 0) {
      if (c.filters.length === 1) { await this.deleteChain(c.id); return; }
      toast("The source of a chain cannot be removed while other filters depend on it.", "error");
      return;
    }
    this.s.mutate((p) => { const ch = p.chains.find((x) => x.id === c.id)!; ch.filters.splice(i, 1); });
    this.s.selectFilter(c.filters[Math.min(i, c.filters.length - 1)]?.id ?? null, c.id);
  }

  removeAfter(chainId: string, filterId: string) {
    this.s.mutate((p) => { const c = p.chains.find((x) => x.id === chainId)!; const i = c.filters.findIndex((f) => f.id === filterId); c.filters.splice(i + 1); });
    this.s.selectFilter(filterId, chainId);
  }

  moveFilter(filterId: string, dir: number) {
    this.s.mutate((p) => {
      for (const c of p.chains) {
        const i = c.filters.findIndex((f) => f.id === filterId);
        if (i < 1) continue;
        const j = i + dir;
        if (j < 1 || j >= c.filters.length) return;
        [c.filters[i], c.filters[j]] = [c.filters[j], c.filters[i]];
      }
    });
  }

  moveFilterTo(filterId: string, chainId: string, index: number) {
    this.s.mutate((p) => {
      let moved: FilterInstance | null = null;
      for (const c of p.chains) { const i = c.filters.findIndex((f) => f.id === filterId); if (i > 0) { moved = c.filters.splice(i, 1)[0]; break; } }
      if (!moved) return;
      const dst = p.chains.find((c) => c.id === chainId)!;
      dst.filters.splice(Math.max(1, Math.min(dst.filters.length, index)), 0, moved);
    });
  }

  duplicateFilter(filterId: string) {
    const c = this.s.project.chains.find((x) => x.filters.some((f) => f.id === filterId));
    if (!c) return;
    const i = c.filters.findIndex((f) => f.id === filterId);
    const copy = { ...structuredClone(c.filters[i]), id: uid("f") };
    this.s.mutate((p) => p.chains.find((x) => x.id === c.id)!.filters.splice(i + 1, 0, copy));
    this.s.selectFilter(copy.id, c.id);
  }

  copyFilter(filterId: string) {
    for (const c of this.s.project.chains) { const f = c.filters.find((x) => x.id === filterId); if (f) { this.clipboard = structuredClone(f); toast(`Copied ${FILTERS[f.type]?.name}.`, "ok"); } }
  }

  pasteFilter() {
    const f = this.clipboard;
    if (!f) return;
    if (FILTERS[f.type]?.kind === "loader") { toast("Loaders cannot be pasted inside a chain.", "error"); return; }
    this.addFilter(f.type, structuredClone(f.params));
  }

  chainFromHere(chainId: string, filterId: string) {
    const c = this.s.chain(chainId);
    if (!c) return;
    const i = c.filters.findIndex((f) => f.id === filterId);
    const copy: ChainDoc = { id: uid("chain"), name: `${c.name} (from ${FILTERS[c.filters[i].type]?.name})`, filters: c.filters.slice(0, i + 1).map((f) => ({ ...structuredClone(f), id: uid("f") })) };
    this.s.mutate((p) => p.chains.push(copy));
    this.s.setUi({ chainId: copy.id });
  }

  async filterAction(action: string, filterId: string) {
    const f = this.s.project.chains.flatMap((c) => c.filters).find((x) => x.id === filterId);
    if (!f) return;
    switch (action) {
      case "convertDvr": await this.convertDvr(filterId); break;
      case "convertDvrLast": await this.convertDvr(filterId, true); break;
      case "addCurrentFrame": {
        const cur = String(f.params.frames ?? "").trim();
        this.setParam(filterId, "frames", cur ? `${cur}, ${this.s.frameOf()}` : String(this.s.frameOf()));
        break;
      }
      case "autoLevels": {
        const chainId = this.s.ui.chainId!;
        const st = await this.e.call<{ hist: Uint32Array; total: number } | null>("inputStats", chainId, filterId, this.s.frameOf());
        if (!st) return;
        let acc = 0, lo = 0, hi = 255;
        for (let v = 0; v < 256; v++) { acc += st.hist[v]; if (acc >= st.total * 0.005) { lo = v; break; } }
        acc = 0;
        for (let v = 255; v >= 0; v--) { acc += st.hist[v]; if (acc >= st.total * 0.005) { hi = v; break; } }
        this.s.mutate((p) => { const ff = p.chains.flatMap((c) => c.filters).find((x) => x.id === filterId)!; ff.params = { ...ff.params, inBlack: lo, inWhite: Math.max(lo + 1, hi) }; });
        this.s.emit("ui", new Set(["selected"]));
        break;
      }
      case "write": {
        const p = normalizeParams(FILTERS[f.type], f.params);
        const n = this.s.streamInfo.get(this.s.ui.chainId ?? "")?.frameCount ?? 1;
        const io = this.s.ui.inOut[this.s.ui.chainId ?? ""];
        let start = 0, end = n - 1;
        if (p.range === "current") start = end = this.s.frameOf();
        else if (p.range === "inout" && io) { start = io[0] ?? 0; end = io[1] ?? n - 1; }
        const info = await this.e.call<StreamInfo | null>("streamInfo", this.s.ui.chainId!, filterId).catch(() => null);
        const est = info && isWriteFormat(p.format) ? estimateBytes(p.format, info.width, info.height, start, end, p.name || "output") : null;
        await this.runWrite({ chainId: this.s.ui.chainId!, filterId, format: p.format, quality: p.quality ?? 0.92, start, end, fps: p.fps || 0, name: p.name || "output", taskId: uid("write") }, est);
        break;
      }
    }
  }

  // ------------------------------------------------------------ sources
  sourceInfoTable(info: SourceInfo): HTMLElement {
    const ref = this.s.project.sources[info.id];
    const par = info.par ? info.par[0] / info.par[1] : 1;
    const dar = (info.width * par) / Math.max(1, info.height);
    const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
    const ar = (w: number, hh: number) => { const k = g(Math.round(w), Math.round(hh)) || 1; return `${Math.round(w) / k}:${Math.round(hh) / k}`; };
    const rows: [string, string][] = [
      ["File Name", info.name], ["Type", info.kind === "image" ? "Image" : info.kind === "sequence" ? "Image Sequence" : info.kind === "synthetic" ? "Synthetic" : "Video"],
      ["Size", fmtBytes(info.fileSize)], ["Format", info.container ?? "—"], ["Codec", info.codec ?? "—"], ["Width", String(info.width)], ["Height", String(info.height)],
      ["Fps", info.fps.toFixed(4)], ["Length (frames)", String(info.frameCount)], ["Duration", fmtTime(info.duration)],
      ["SAR", ar(info.width, info.height)], ["DAR", Math.abs(dar - 4 / 3) < 0.02 ? "4:3" : Math.abs(dar - 16 / 9) < 0.02 ? "16:9" : dar.toFixed(4)], ["PAR", info.par ? `${info.par[0]}:${info.par[1]}` : "1:1"],
      ["Color Range", info.colorRange ?? "—"], ["Color Matrix", info.colorMatrix ?? "—"],
      ["Video Streams", String(info.videoStreams)], ["Audio Streams", String(info.audioStreams)], ["Subtitle Streams", String(info.subtitleStreams)],
      ...(info.audio ? [["Audio", `${info.audio.codec}, ${info.audio.sampleRate} Hz, ${info.audio.channels} ch`] as [string, string]] : []),
      ["Decoding Engine", info.engine],
      ...(info.conversion ? [["Color Conversion", info.conversion] as [string, string]] : []),
      ...(ref?.md5 ? [["MD5", ref.md5], ["SHA-1", ref.sha1 ?? ""], ["SHA-256", ref.sha256 ?? ""]] as [string, string][] : []),
      ...info.metadata.filter(([k]) => !["Size", "Container", "Codec"].includes(k)),
    ];
    return h("table", { class: "info-table" }, h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Value"))), h("tbody", null, ...rows.map(([k, v]) => h("tr", null, h("td", null, k), h("td", { class: k.startsWith("SHA") || k === "MD5" ? "mono sel-all" : "" }, v)))));
  }

  showSourceInfo(id: string) {
    const info = this.s.sources.get(id);
    if (!info) return;
    void alertDialog(`File Info — ${info.name}`, h("div", { class: "scroll-box" }, this.sourceInfoTable(info)));
  }

  async browseSource(filterId: string) {
    const f = this.s.project.chains.flatMap((c) => c.filters).find((x) => x.id === filterId);
    if (!f) return;
    const isSeq = f.type === "sequence_loader", isImg = f.type === "image_loader";
    const files = await pickFiles(isImg || isSeq ? "image/*,.tif,.tiff" : "video/*,image/*,.avi,.mkv,.mov,.mp4,.ts,.h264,.264,.h265,.hevc,.dav,.mjpg", isSeq);
    if (!files.length) return;
    const id = f.params.source || uid("src");
    const info = await this.loadGroup(files, isSeq ? "sequence" : isImg ? "image" : "auto", {}, id);
    if (info && f.params.source !== id) this.setParam(filterId, "source", id);
    if (info) this.s.mutate(() => undefined);
  }

  async pickAuxImage(filterId: string, key: string) {
    const files = await pickFiles("image/*", false);
    if (!files.length) return;
    const id = uid("img");
    try {
      const info = await this.e.call<SourceInfo>("openSource", id, files, "image", {});
      this.registerSource(info, files);
      this.setParam(filterId, key, id);
    } catch (e) { toast((e as Error).message, "error"); }
  }

  async hashSource(id: string) {
    const files = this.s.files.get(id);
    if (!files?.length) return;
    const taskId = uid("hash");
    const pd = progressDialog("Computing Hashes", () => void this.e.call("cancel", taskId));
    const off = this.e.on("progress", (p) => { if (p.taskId === taskId) pd.set(p.label, p.value); });
    try {
      const r = await this.e.call<{ md5: string; sha1: string; sha256: string }>("hashFile", files[0], taskId);
      this.s.mutate((p) => { Object.assign(p.sources[id], r); }, { structural: false });
      pd.close();
      void alertDialog("File Hashes", h("table", { class: "info-table" }, h("tbody", null, ...[["File", files[0].name], ["Size", `${fmtBytes(files[0].size)} (${files[0].size} bytes)`], ["MD5", r.md5], ["SHA-1", r.sha1], ["SHA-256", r.sha256]].map(([k, v]) => h("tr", null, h("td", null, k), h("td", { class: "mono sel-all" }, v))))));
      this.s.emit("sources");
    } catch (e) { pd.close(); if (!pd.cancelled) toast((e as Error).message, "error"); }
    finally { off(); }
  }

  async hashAnyFile() {
    const files = await pickFiles("*/*", false);
    if (!files.length) return;
    const taskId = uid("hash");
    const pd = progressDialog("Computing Hashes", () => void this.e.call("cancel", taskId));
    const off = this.e.on("progress", (p) => { if (p.taskId === taskId) pd.set(p.label, p.value); });
    try {
      const r = await this.e.call<{ md5: string; sha1: string; sha256: string }>("hashFile", files[0], taskId);
      pd.close();
      void alertDialog("File Hashes", h("table", { class: "info-table" }, h("tbody", null, ...[["File", files[0].name], ["Size", `${fmtBytes(files[0].size)} (${files[0].size} bytes)`], ["Modified", new Date(files[0].lastModified).toISOString()], ["MD5", r.md5], ["SHA-1", r.sha1], ["SHA-256", r.sha256]].map(([k, v]) => h("tr", null, h("td", null, k), h("td", { class: "mono sel-all" }, v))))));
    } catch (e) { pd.close(); if (!pd.cancelled) toast((e as Error).message, "error"); }
    finally { off(); }
  }

  async hashFrames(chainId: string) {
    const taskId = uid("fh");
    const pd = progressDialog("Hashing Output Frames", () => void this.e.call("cancel", taskId));
    const off = this.e.on("progress", (p) => { if (p.taskId === taskId) pd.set(p.label, p.value); });
    try {
      const list = await this.e.call<string[]>("hashFrames", chainId, taskId);
      pd.close();
      const c = this.s.chain(chainId);
      const txt = `# ${BRAND.fullName} ${BRAND.version} — MD5 of output frames (8-bit RGB buffer)\n# Chain: ${c?.name}\n# Generated: ${new Date().toISOString()}\n` + list.map((m, i) => `${i}\t${m}`).join("\n");
      download(txt, `${c?.name ?? "chain"}_frame_hashes.txt`, "text/plain");
      toast(`${list.length} frame hashes saved.`, "ok");
    } catch (e) { pd.close(); if (!pd.cancelled) toast((e as Error).message, "error"); }
    finally { off(); }
  }

  // ------------------------------------------------------------ Convert DVR
  async convertDvr(filterId?: string, useLast = false) {
    const opts = { ...this.lastDvr };
    let file: File | null = null;
    if (useLast) { const f = await pickFiles("*/*", false); if (!f.length) return; file = f[0]; }
    else {
      const ok = await new Promise<boolean>((resolve) => {
        let r = false;
        const fileLbl = h("span", { class: "muted" }, "No file selected");
        const browse = h("button", { class: "btn sm" }, "Browse…");
        browse.addEventListener("click", async () => { const f = await pickFiles("*/*", false); if (f.length) { file = f[0]; fileLbl.textContent = `${f[0].name} (${fmtBytes(f[0].size)})`; } });
        const cont = selectBox([["auto", "Auto Detect"], ["raw", "Raw H.264/H.265 Stream"], ["ps", "MPEG-PS / Hikvision"], ["dhav", "Dahua DAV (DHAV)"]], opts.container, (v) => { opts.container = v; });
        const codec = selectBox([["auto", "Auto Detect"], ["h264", "H.264 / AVC"], ["hevc", "H.265 / HEVC"]], opts.codec, (v) => { opts.codec = v; });
        const fps = spinBox({ value: opts.fps, min: 0, max: 240, decimals: 3, width: 100, onChange: (v) => { opts.fps = v; } });
        const body = h("div", { class: "form" },
          h("p", { class: "muted small" }, "Recovers the video stream from proprietary DVR/CCTV files and remuxes it without re-encoding (no quality loss) into a standard MP4 container with exact frame indexing."),
          h("div", { class: "form-row" }, h("span", null, "File:"), h("div", { class: "prm-inline" }, browse, fileLbl)),
          h("div", { class: "form-row" }, h("span", null, "Container:"), cont),
          h("div", { class: "form-row" }, h("span", null, "Codec:"), codec),
          h("div", { class: "form-row" }, h("span", null, "Frame Rate (0 = from stream):"), fps.el));
        dialog({ title: "Convert DVR", body, width: 520, onClose: () => resolve(r), buttons: [{ label: "Cancel" }, { label: "Convert", primary: true, action: () => { if (!file) { toast("Select a file first.", "error"); return false; } r = true; } }] });
      });
      if (!ok || !file) return;
    }
    this.lastDvr = opts;
    const f = file as File;
    const id = uid("src");
    const pd = progressDialog(`Convert DVR — ${f.name}`);
    const off = this.e.on("progress", (p) => { if (p.taskId === `dvr:${id}`) pd.set(p.label, p.value); });
    try {
      const r = await this.e.call<{ info: SourceInfo; scan: DvrScanResult }>("scanDvr", id, f, opts);
      pd.close();
      this.registerSource(r.info, [f], { ...opts, dvr: true });
      this.s.project.sources[id].kind = "dvr";
      const target = filterId ? this.s.project.chains.flatMap((c) => c.filters).find((x) => x.id === filterId) : null;
      if (target && target.type === "video_loader") this.setParam(target.id, "source", id);
      else {
        const chain: ChainDoc = { id: uid("chain"), name: baseName(f.name), filters: [{ id: uid("f"), type: "video_loader", params: { ...defaultParams(FILTERS.video_loader), source: id }, enabled: true }] };
        this.s.mutate((p) => p.chains.push(chain));
        this.s.setUi({ chainId: chain.id });
      }
      const save = h("button", { class: "btn" }, "Save Converted MP4…");
      save.addEventListener("click", async () => { const c = await this.e.call<{ name: string; buffer: ArrayBuffer } | null>("convertedFile", id); if (c) download(c.buffer, c.name, "video/mp4"); });
      void alertDialog("Convert DVR — Completed", h("div", null,
        h("table", { class: "info-table" }, h("tbody", null, ...[["Container", r.scan.container], ["Codec", r.scan.codec.toUpperCase()], ["Resolution", `${r.scan.width} x ${r.scan.height}`], ["Frames", String(r.scan.frames)], ["Frame Rate", r.scan.fps.toFixed(3)]].map(([k, v]) => h("tr", null, h("td", null, k), h("td", null, v))))),
        h("ul", { class: "notes" }, ...r.scan.notes.map((n) => h("li", null, n))), r.scan.codec !== "unknown" ? save : null));
    } catch (e) {
      pd.close();
      void alertDialog("Convert DVR — Failed", h("div", { class: "dlg-msg" }, (e as Error).message));
    } finally { off(); }
  }

  // ------------------------------------------------------------ writing
  /** Exports above this size may not fit in memory where files cannot be written straight to disk. */
  memoryExportLimit(): number {
    const dm = (navigator as { deviceMemory?: number }).deviceMemory;
    const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    return (dm ? Math.max(0.25, dm / 4) : coarse ? 0.5 : 1.5) * 1073741824;
  }

  /** Whether this browser offers save dialogs that hand out writable files (Chrome and Edge on computers). */
  hasSavePicker(): boolean {
    return typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function" && FileSink.supported() && !crossOriginFrame;
  }

  /** Whether exports can be streamed straight to a file the user picks (Chrome and Edge on computers). */
  canSaveToDisk(): boolean { return this.s.prefs.saveToDisk && this.hasSavePicker(); }

  /** Where exports of this browser go (for the notes of the Write dialogs). */
  async exportTarget(): Promise<ExportTarget> {
    if (this.canSaveToDisk()) return { kind: "picker" };
    const status = await this.staging.status().catch(() => null);
    return status?.ok ? { kind: "staging", status } : { kind: "memory", status };
  }

  /** Whether a source of the project reads this file (staged recordings stay while they are in use). */
  private fileInUse(f: File | null): boolean {
    if (!f) return false;
    for (const files of this.s.files.values()) if (files.includes(f)) return true;
    return false;
  }

  /**
   * Decides whether an export without a picked file is staged in the browser's storage. Returns the staging
   * entry, "memory", or null when the user cancelled. Frees earlier staged downloads or asks for more
   * storage (Firefox) when the export does not fit.
   */
  private async planStaging(format: WriteFormat, name: string, estimate: number | null): Promise<{ entry: string } | { memory: string } | null> {
    if (format === "mp4" || format === "webm") return { memory: "" }; // the encoder output is built in memory anyway
    if (estimate !== null && estimate < this.staging.minBytes) return { memory: "" };
    let st = await this.staging.status();
    if (!st.ok) return { memory: "" };
    const need = (estimate ?? 0) + 16 * 1048576;
    const short = () => st.room !== null && need > st.room;
    if (short()) {
      const old = this.staging.list().filter((i) => !this.fileInUse(i.file));
      const oldBytes = old.reduce((n, i) => n + i.bytes, 0);
      if (old.length && st.room! + oldBytes >= need) {
        const ok = await confirmDialog("Free Browser Storage", `This export needs ${fmtBytes(need)} of the browser's storage and ${fmtBytes(st.room!)} is free. ${old.length} earlier download${old.length === 1 ? "" : "s"} staged there use${old.length === 1 ? "s" : ""} ${fmtBytes(oldBytes)}. Remove ${old.length === 1 ? "it" : "them"}? Do this only if ${old.length === 1 ? "its download has" : "their downloads have"} finished.`, "Remove and Continue");
        if (ok) { await this.staging.free(old.map((i) => i.entry)); st = await this.staging.status(); }
      }
    }
    if (short() && st.canPersist) {
      const ok = await confirmDialog("More Browser Storage", `This export needs ${fmtBytes(need)}; the browser currently lets this site store ${fmtBytes(st.room!)} more. Firefox allows up to half of the disk to sites that may store data persistently. Ask the browser for that permission?`, "Ask");
      if (ok) { await this.staging.requestPersistence(); st = await this.staging.status(); }
    }
    if (short()) return { memory: `the browser's storage for this site has only ${fmtBytes(st.room!)} free` };
    return { entry: await this.staging.reserve(name, "export") };
  }

  /** Asks where to save (File System Access). undefined: download instead; null: the user cancelled. */
  async pickSaveFile(name: string, mime: string, ext: string, description: string): Promise<FileSystemFileHandle | null | undefined> {
    if (!this.canSaveToDisk()) return undefined;
    try {
      return await (window as unknown as { showSaveFilePicker(o: unknown): Promise<FileSystemFileHandle> }).showSaveFilePicker({ suggestedName: name, types: [{ description, accept: { [mime]: [`.${ext}`] } }] });
    } catch (e) {
      if ((e as Error).name === "AbortError") return null;
      return undefined; // e.g. not allowed in an embedded frame: download instead
    }
  }

  /**
   * Write with explicit settings (the assistant's exports): the same path as the Write dialogs — save picker or
   * staging, verification, lossy formats refused when "lossless exports only" is on. Call it from a click.
   */
  async writeWith(o: { chainId: string; filterId: string | null; format: WriteFormat; start: number; end: number; name: string; fps?: number; quality?: number }): Promise<WriteResult | null> {
    const info = await this.e.call<StreamInfo | null>("streamInfo", o.chainId, o.filterId).catch(() => null);
    const est = info ? estimateBytes(o.format, info.width, info.height, o.start, o.end, o.name) : null;
    return this.runWrite({ chainId: o.chainId, filterId: o.filterId, format: o.format, quality: o.quality ?? 0.92, start: o.start, end: o.end, fps: o.fps ?? 0, name: o.name, taskId: uid("write") }, est);
  }

  private async runWrite(req: WriteRequest, estimate: number | null = null): Promise<WriteResult | null> {
    if (!isWriteFormat(req.format)) { toast(`Unknown output format "${req.format}".`, "error"); return null; }
    const fi = FORMATS[req.format];
    if (this.s.prefs.losslessOnly && fi.lossy) {
      void alertDialog("Lossy Format Disabled", `${fi.short} compresses the frames and discards detail. "Lossless exports only" is on (Edit › Settings): choose an uncompressed format such as ${FORMATS[fi.video ? "avi-raw" : "tiff16"].short}, or turn the setting off to allow lossy formats.`);
      return null;
    }
    const out = outputFile(req.format, req.name, req.end - req.start + 1);
    const handle = await this.pickSaveFile(out.name, out.mime, out.ext, out.zip ? "ZIP archive" : fi.short);
    if (handle === null) return null;
    let stage: string | undefined, whyMemory = "";
    if (!handle) {
      const plan = await this.planStaging(req.format, out.name, estimate);
      if (!plan) return null;
      if ("entry" in plan) stage = plan.entry; else whyMemory = plan.memory;
    }
    const limit = this.memoryExportLimit();
    if (!handle && !stage && estimate !== null && estimate > limit) {
      const ok = await confirmDialog("Large Export", `This export is about ${fmtBytes(estimate)}. ${whyMemory ? `This browser cannot write straight to a file and ${whyMemory}` : "This browser cannot write straight to disk"}, so the whole file is assembled in memory before it is saved, which may fail above about ${fmtBytes(limit)}. Export a shorter range${whyMemory ? ", free browser storage (Settings › Export)," : ""} or use Chrome or Edge on a computer to write directly to disk.`, "Export Anyway");
      if (!ok) return null;
    }
    const verify = this.s.prefs.verifyExports && !fi.lossy;
    const pd = progressDialog(`Writing ${handle?.name ?? out.name}`, () => void this.e.call("cancel", req.taskId));
    const off = this.e.on("progress", (p) => { if (p.taskId === req.taskId) pd.set(p.label || "Writing…", p.value); });
    try {
      const r = await this.e.call<WriteResult>("write", { ...req, handle, verify, stage });
      pd.close();
      if (r.file && stage) { this.staging.done(stage, r.file, r.bytes); this.staging.download(stage); }
      else if (r.blob) download(r.blob, r.name, r.mime);
      const what = `${r.frames} frame${r.frames === 1 ? "" : "s"}, ${r.width}×${r.height}, ${r.codec ?? fi.short}, ${fmtBytes(r.bytes)}`;
      if (r.verified && !r.verified.ok && !r.verified.cancelled) {
        void alertDialog("Verification Failed", h("div", { class: "dlg-msg" }, `${r.name} was written (${what}), but reading it back did not reproduce the processed frames: ${r.verified.message}. Do not rely on this file; write it again, to another disk if possible.`));
      } else {
        const v = r.verified ? (r.verified.ok ? " Verified: every frame read back from the file is bit-identical." : ` ${r.verified.message}.`) : "";
        const where = r.savedToDisk ? " to disk" : r.file ? " (staged on disk in the browser's storage and downloaded from there)" : "";
        toast(`Written ${r.name} (${what})${where}.${v}`, "ok", 8000);
      }
      return r.verified && !r.verified.ok && !r.verified.cancelled ? null : r;
    } catch (e) {
      pd.close();
      if (stage) await this.staging.discard(stage);
      const m = (e as Error).message;
      if (!pd.cancelled) void alertDialog("Write Failed", h("div", { class: "dlg-msg" }, m.startsWith(STORAGE_FULL) ? `${m}. Free space in Settings › Export (staged downloads), export a shorter range, or use Chrome or Edge on a computer to write directly to a file.` : m));
      return null;
    }
    finally { off(); }
  }

  private async writeDialog(kind: "video" | "images") {
    const s = this.s, chain = s.chain();
    if (!chain) { toast("Nothing to write: load a file first.", "info"); return; }
    const filterId = s.selectedFilter()?.id ?? null;
    const info = (await this.e.call<StreamInfo | null>("streamInfo", chain.id, filterId).catch(() => null)) ?? s.streamInfo.get(chain.id) ?? null;
    const n = info?.frameCount ?? 1;
    const io = s.ui.inOut[chain.id];
    const lossless = s.prefs.losslessOnly;
    const list = (kind === "video" ? VIDEO_EXPORT : IMAGE_EXPORT).filter((f) => !(lossless && FORMATS[f].lossy) && (f !== "webp" || canEncodeWebP()));
    const pref = kind === "video" ? s.prefs.videoFormat : s.prefs.imageFormat;
    const target = await this.exportTarget();
    const st = { format: (list.includes(pref) ? pref : list[0]) as WriteFormat, quality: 0.92, fps: 0, range: kind === "video" ? "all" : n > 1 ? "current" : "all", name: kind === "video" ? chain.name : `${chain.name}_frame`, verify: s.prefs.verifyExports };
    const rangeOf = (): [number, number] => {
      if (st.range === "current") { const f = s.frameOf(); return [f, f]; }
      if (st.range === "inout" && io) return [io[0] ?? 0, io[1] ?? n - 1];
      return [0, n - 1];
    };
    const ok = await new Promise<boolean>((resolve) => {
      let r = false;
      const fmts = list.map((f) => [f, formatLabel(f, kind === "video")] as [string, string]);
      const ranges: [string, string][] = [["all", `All Frames (${n})`], ...(io ? [["inout", `In/Out Range (${io[0] ?? 0}–${io[1] ?? n - 1})`] as [string, string]] : []), ...(kind === "images" ? [["current", `Current Frame (${s.frameOf()})`] as [string, string]] : [])];
      const nameInp = h("input", { class: "inp", type: "text", value: st.name }) as HTMLInputElement;
      const qRow = h("div", { class: "form-row" }, h("span", null, "Quality (lossy):"), spinBox({ value: st.quality, min: 0.1, max: 1, decimals: 2, step: 0.01, width: 90, onChange: (v) => { st.quality = v; } }).el);
      const verifyCb = checkBox("Verify after writing: read the file back and compare every frame bit for bit", st.verify, (v) => { st.verify = v; });
      const note = h("div", { class: "export-note" });
      const update = () => {
        const fi = FORMATS[st.format];
        qRow.hidden = !fi.lossy;
        verifyCb.el.hidden = fi.lossy;
        const [a, b] = rangeOf();
        const count = b - a + 1;
        const est = info ? estimateBytes(st.format, info.width, info.height, a, b, nameInp.value || st.name) : null;
        const fb = info ? frameBytes(st.format, info.width, info.height) : null;
        const lines: (string | HTMLElement)[] = [];
        if (fi.lossy) lines.push(h("b", { class: "warn" }, "Lossy: the encoder discards detail to make the file smaller. Do not use it when every frame must be preserved exactly."));
        else lines.push(h("b", null, "No compression: "), `every frame is stored exactly as processed${info ? ` (${info.width}×${info.height}, ${fi.depth} per channel${fb ? `, ${fmtBytes(fb)} per frame` : ""})` : ""}.`);
        if (est !== null) lines.push(h("br"), `${count > 1 && !fi.video ? `${count} files in a ZIP archive (stored, not compressed). ` : ""}Size: ${fmtBytes(est)}.`);
        lines.push(h("br"), this.targetNote(target, est, st.format));
        note.replaceChildren(...lines);
      };
      const body = h("div", { class: "form" },
        h("div", { class: "form-row" }, h("span", null, "Chain:"), h("b", null, chain.name)),
        h("div", { class: "form-row" }, h("span", null, "Format:"), selectBox(fmts, st.format, (v) => { st.format = v as WriteFormat; update(); })),
        h("div", { class: "form-row" }, h("span", null, "Frames:"), selectBox(ranges, st.range, (v) => { st.range = v; update(); })),
        qRow,
        kind === "video" ? h("div", { class: "form-row" }, h("span", null, "Frame Rate (0 = chain):"), spinBox({ value: 0, min: 0, max: 240, decimals: 3, width: 90, onChange: (v) => { st.fps = v; } }).el) : null,
        h("div", { class: "form-row" }, h("span", null, "File Name:"), nameInp),
        verifyCb.el,
        note,
        lossless ? null : h("p", { class: "muted small" }, "Lossy formats are listed because Settings › Lossless exports only is off."));
      update();
      dialog({ title: kind === "video" ? "Write Video" : "Write Images", body, width: 580, onClose: () => resolve(r), buttons: [{ label: "Cancel" }, { label: "Write", primary: true, action: () => { st.name = nameInp.value || st.name; r = true; } }] });
    });
    if (!ok) return;
    const [start, end] = rangeOf();
    s.savePrefs(kind === "video" ? { videoFormat: st.format, verifyExports: st.verify } : { imageFormat: st.format, verifyExports: st.verify });
    const est = info ? estimateBytes(st.format, info.width, info.height, start, end, st.name) : null;
    await this.runWrite({ chainId: chain.id, filterId, format: st.format, quality: st.quality, start, end, fps: st.fps, name: st.name, taskId: uid("write") }, est);
  }

  /** One line on where the file goes (Write dialogs). */
  private targetNote(t: ExportTarget, est: number | null, format: WriteFormat): string | HTMLElement {
    if (t.kind === "picker") return "You choose where to save; the file is written straight to disk.";
    const memLimit = this.memoryExportLimit();
    const memory = () => est !== null && est > memLimit ? h("span", { class: "warn" }, `This browser assembles the file in memory before saving it; above about ${fmtBytes(memLimit)} this may fail.`) : "The file is downloaded when it is ready.";
    if (t.kind === "memory" || format === "mp4" || format === "webm" || (est !== null && est < this.staging.minBytes)) return memory();
    const room = t.status.room;
    if (room !== null && est !== null && est + 16 * 1048576 > room) {
      return h("span", { class: "warn" }, `This export is larger than the browser's storage left for this site (${fmtBytes(room)}${t.status.canPersist ? "; Firefox can allow more" : ""}). Free staged downloads in Settings › Export, or the file is assembled in memory${est > memLimit ? `, which may fail above about ${fmtBytes(memLimit)}` : ""}.`);
    }
    return `The file is written to disk in the browser's storage (not held in memory), then downloaded${room !== null ? `; room for ${fmtBytes(room)}` : ""}. Until the download has finished, the disk needs space for two copies.`;
  }

  writeVideo() { return this.writeDialog("video"); }
  writeImages() { return this.writeDialog("images"); }

  async snapshot() {
    const r = this.s.lastRender, c = this.s.chain();
    if (!r || !c) return;
    // the viewer frame at full resolution, written as an uncompressed PNG (exact pixels)
    const png = encodePNG(r.width, r.height, rgbFromRGBA(r.rgba, r.width, r.height));
    download(new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" }), `${c.name}_frame${String(r.frame).padStart(5, "0")}.png`, "image/png");
    toast(`Snapshot saved (PNG, uncompressed, ${r.width}×${r.height}, ${fmtBytes(png.length)}). For 16-bit or 32-bit float use File › Write Images.`, "ok", 5000);
  }

  async copyFrame() {
    const r = this.s.lastRender;
    if (!r) return;
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") { toast("This browser cannot copy images to the clipboard. Use File › Save Snapshot instead.", "error"); return; }
    try {
      // Exact pixels: the PNG is built here (no canvas, so no color management and no fingerprinting
      // noise), synchronously, so the clipboard write starts inside the tap or click (Safari rejects
      // clipboard writes that begin after an await).
      const png = encodePNG(r.width, r.height, rgbFromRGBA(r.rgba, r.width, r.height));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" }) })]);
      toast(`Frame copied to the clipboard (${r.width}×${r.height}, exact pixels).`, "ok");
    } catch (e) { const m = explainError(e, "Copy Frame", { permission: "clipboard" }); if (m) toast(m, "error"); }
  }

  /** Result of the pixel readback self-checks (engine and page), computed once. */
  private pixels: Promise<{ engineCanvas: boolean; videoFrame: boolean; pageCanvas: boolean }> | null = null;
  pixelCheck() {
    return (this.pixels ??= Promise.all([
      this.e.call<{ canvas: boolean; videoFrame: boolean }>("pixelCheck").catch(() => ({ canvas: true, videoFrame: false })),
      canvasReadbackExact(),
    ]).then(([e, page]) => ({ engineCanvas: e.canvas, videoFrame: e.videoFrame, pageCanvas: page })));
  }

  /** Warns once when the browser perturbs pixels read back from canvases (fingerprinting protection). */
  async warnIfPixelsPerturbed() {
    const p = await this.pixelCheck();
    if (p.engineCanvas && p.pageCanvas) return;
    const affected = [p.videoFrame ? null : "JPEG, GIF, WebP and BMP images, Motion JPEG video", "videos the browser plays through a media element", "live recordings"].filter(Boolean).join(", ");
    void alertDialog("Pixels Altered by the Browser", h("div", { class: "dlg-msg" },
      "This browser adds noise to pixels that pages read back from canvases (a fingerprinting protection, e.g. Brave Shields, Firefox \"resist fingerprinting\", or Firefox and Safari private windows). "
      + `PNG and TIFF images, uncompressed AVI and videos decoded with WebCodecs are read without a canvas, and exports, snapshots and Copy Frame never use one; but ${affected} pass through a canvas and may be altered. `
      + "For exact results, turn the protection off for this site or use a normal window."));
  }

  // ------------------------------------------------------------ bookmarks
  async addBookmark() {
    const c = this.s.chain();
    if (!c) return;
    const note = await promptDialog("Add Bookmark", `Note for frame ${this.s.frameOf()}:`, "");
    if (note === null) return;
    this.s.mutate((p) => p.bookmarks.push({ id: uid("bm"), chainId: c.id, frame: this.s.frameOf(), note }), { structural: false });
    toast("Bookmark added (included in the report).", "ok");
  }

  async showBookmarks() {
    const s = this.s;
    const list = h("table", { class: "info-table" }, h("thead", null, h("tr", null, h("th", null, "Chain"), h("th", null, "Frame"), h("th", null, "Note"), h("th", null, ""))));
    const tb = h("tbody");
    for (const b of s.project.bookmarks) {
      const go = h("button", { class: "btn sm" }, "Go");
      go.addEventListener("click", () => { s.setUi({ chainId: b.chainId }); s.setFrame(b.frame, b.chainId); });
      const del = h("button", { class: "btn sm" }, "Delete");
      del.addEventListener("click", () => { s.mutate((p) => { p.bookmarks = p.bookmarks.filter((x) => x.id !== b.id); }); del.closest("tr")?.remove(); });
      tb.appendChild(h("tr", null, h("td", null, s.chain(b.chainId)?.name ?? "?"), h("td", null, String(b.frame)), h("td", null, b.note || "—"), h("td", null, go, " ", del)));
    }
    list.appendChild(tb);
    void alertDialog("Bookmarks", s.project.bookmarks.length ? list : h("div", { class: "dlg-msg" }, "No bookmarks. Use the bookmark button of the Player (or press B)."));
  }

  // ------------------------------------------------------------ project
  async newProject() {
    if (this.s.dirty && !(await confirmDialog("New Project", "Discard the changes of the current project?", "Discard", true))) return;
    this.ctx.newProject();
  }

  async openProject() {
    const files = await pickFiles(".lfp,.json,application/json", false);
    if (files.length) await this.openProjectFile(files[0]);
  }

  async openProjectFile(file: File, sniffed?: Sniffed) {
    const sn = sniffed ?? (await sniffFile(file));
    const msg = (...lines: (string | HTMLElement)[]) => h("div", { class: "dlg-msg" }, ...lines.map((l) => (typeof l === "string" ? h("p", null, l) : l)));
    const fileName = () => h("b", null, file.name);
    if (sn.kind === "image" || sn.kind === "video") {
      // A picture or a video picked with "Open Project": load it, as the user evidently wants.
      toast(`“${file.name}” is ${withArticle(sn.label)}, not a project file. It was loaded as media.`, "info", 7000);
      await this.loadFiles([file]);
      return;
    }
    if (sn.kind !== "project") {
      const hint = `${BRAND.name} projects are the ${BRAND.projectExt} files written by File › Save Project. To analyze an image or a video use File › Load Image or Video….`;
      if (!sn.definite) {
        // Unknown binary data may be a proprietary DVR export: offer to try it as media.
        let load = false;
        dialog({ title: "Open Project", body: msg(h("p", null, fileName(), ` is not a ${BRAND.name} project (${sn.label}).`), h("p", { class: "muted small" }, hint)), onClose: () => { if (load) void this.loadFiles([file], "auto"); },
          buttons: [{ label: "Cancel" }, { label: "Load as Media", primary: true, action: () => { load = true; } }] });
        return;
      }
      void alertDialog("Open Project", msg(h("p", null, fileName(), ` is ${withArticle(sn.label)}, not a ${BRAND.name} project.`), h("p", { class: "muted small" }, hint)));
      return;
    }
    if (file.size > 256 * 1024 * 1024) { void alertDialog("Open Project", msg(h("p", null, fileName(), ` (${fmtBytes(file.size)}) is too large to be a ${BRAND.name} project file.`))); return; }
    let doc: ProjectDoc;
    try { doc = JSON.parse(await file.text()) as ProjectDoc; }
    catch (e) {
      void alertDialog("Open Project", msg(h("p", null, fileName(), " looks like a project file but it cannot be read: it is probably truncated or damaged."), h("p", { class: "muted small" }, `Parser message: ${(e as Error).message}`)));
      return;
    }
    const problem = validateProject(doc);
    if (problem) { void alertDialog("Open Project", msg(h("p", null, fileName(), ` is not a valid ${BRAND.name} project: ${problem}.`))); return; }
    if (this.s.dirty && !(await confirmDialog("Open Project", "Discard the changes of the current project?", "Discard", true))) return;
    doc.app ??= BRAND.fullName; doc.schema ??= 1; doc.name ||= baseName(file.name);
    doc.bookmarks ??= []; doc.sources ??= {}; doc.caseInfo ??= { caseNumber: "", examiner: "", agency: "", exhibit: "", notes: "" };
    doc.created ??= new Date().toISOString(); doc.modified ??= doc.created;
    // results must not change on reopening: loaders from earlier versions keep their (replicate) chroma decoding
    const pinned = migrateProject(doc);
    for (const c of doc.chains) { c.name ||= "Chain"; for (const f of c.filters) { f.params = normalizeParams(FILTERS[f.type], f.params ?? {}); f.enabled ??= true; } }
    this.s.loadProject(doc);
    this.s.status(`Opened project ${file.name}.`);
    if (pinned) toast(`${file.name} was saved by an earlier version: ${pinned === 1 ? "its Video Loader keeps" : `its ${pinned} Video Loaders keep`} the Nearest chroma filter, so the results are unchanged. Choose Bicubic (Video Loader › Chroma Filter) for the highest quality.`, "info", 9000);
    const missing = Object.values(doc.sources).filter((r) => !this.s.sources.has(r.id) && r.files?.length);
    if (missing.length) await this.relinkMedia();
  }

  async relinkMedia() {
    const missing = Object.values(this.s.project.sources).filter((r) => !this.s.sources.has(r.id) && r.files?.length);
    if (!missing.length) { toast("All media files are loaded.", "ok"); return; }
    const go = await confirmDialog("Relink Media", `This project references ${missing.length} media source(s) that must be selected again (browsers cannot reopen files by path):\n\n${missing.map((m) => `• ${m.name}`).join("\n")}\n\nSelect the files now?`, "Select Files");
    if (!go) return;
    const files = await pickFiles("*/*", true);
    const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
    let ok = 0;
    for (const ref of missing) {
      const sel = ref.files.map((x) => byName.get(x.name.toLowerCase())).filter(Boolean) as File[];
      if (!sel.length) continue;
      const mismatch = sel.some((f, i) => ref.files[i] && f.size !== ref.files[i].size);
      if (mismatch) toast(`${ref.name}: file size differs from the project record.`, "error", 7000);
      const kind = ref.kind === "sequence" ? "sequence" : ref.kind === "image" ? "image" : ref.options?.dvr ? "dvr" : "auto";
      if (await this.loadGroup(sel, kind, ref.options ?? {}, ref.id)) ok++;
    }
    toast(`${ok} of ${missing.length} media sources relinked.`, ok === missing.length ? "ok" : "info");
    this.s.syncEngine();
    this.s.emit("project", { structural: true });
  }

  async saveProject(saveAs = false) {
    const s = this.s;
    const json = JSON.stringify(s.project, null, 1);
    const name = `${(s.project.name || "Project").replace(/[\\/:*?"<>|]+/g, "_")}${BRAND.projectExt}`;
    const w = window as any;
    try {
      if (w.showSaveFilePicker && (saveAs || !s.fileHandle)) s.fileHandle = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: `${BRAND.name} Project`, accept: { "application/json": [BRAND.projectExt] } }] });
      if (s.fileHandle) {
        const wr = await s.fileHandle.createWritable();
        await wr.write(json);
        await wr.close();
      } else download(json, name, "application/json");
      s.setDirty(false);
      s.status(`Project saved (${name}). Media files are referenced by name, size and hash.`);
    } catch (e) { const m = explainError(e, "Save Project"); if (m) toast(m, "error"); }
  }

  async projectInfo() {
    const s = this.s, ci = { ...s.project.caseInfo };
    const field = (k: keyof typeof ci, label: string, multi = false) => {
      const el = (multi ? h("textarea", { class: "inp", rows: "4" }) : h("input", { class: "inp", type: "text" })) as HTMLInputElement;
      el.value = ci[k];
      el.addEventListener("input", () => { ci[k] = el.value; });
      return h("div", { class: "form-row" }, h("span", null, label), el);
    };
    const nameInp = h("input", { class: "inp", type: "text", value: s.project.name }) as HTMLInputElement;
    const body = h("div", { class: "form" }, h("div", { class: "form-row" }, h("span", null, "Project Name:"), nameInp), field("caseNumber", "Case Number:"), field("exhibit", "Exhibit / Item:"), field("examiner", "Examiner:"), field("agency", "Agency / Lab:"), field("notes", "Notes:", true),
      h("p", { class: "muted small" }, `Created ${new Date(s.project.created).toLocaleString()} · Modified ${new Date(s.project.modified).toLocaleString()}`));
    dialog({ title: "Project Information", body, width: 520, buttons: [{ label: "Cancel" }, { label: "Save", primary: true, action: () => { s.mutate((p) => { p.caseInfo = ci; p.name = nameInp.value || "New Project"; }, { structural: false }); this.ctx.updateTitle(); } }] });
  }

  async generateReport() {
    if (!this.s.project.chains.length) { toast("Nothing to report: the project is empty.", "info"); return; }
    const pd = progressDialog("Generating Report");
    try {
      const html = await buildReport(this.ctx, (l, v) => pd.set(l, v));
      pd.close();
      const name = `Report_${(this.s.project.name || "Project").replace(/[\\/:*?"<>|\s]+/g, "_")}_${new Date().toISOString().slice(0, 10)}.html`;
      const openB = h("button", { class: "btn" }, "Open / Print");
      openB.addEventListener("click", () => { const w = window.open(URL.createObjectURL(new Blob([html], { type: "text/html" })), "_blank"); if (!w) toast("Pop-up blocked: use Save instead.", "error"); });
      const saveB = h("button", { class: "btn primary" }, "Save Report (HTML)");
      saveB.addEventListener("click", () => download(html, name, "text/html"));
      void alertDialog("Report Ready", h("div", null, h("p", { class: "dlg-msg" }, "The report documents the evidence (with hashes), every processing step with its parameters, scientific references and snapshots. Use Open / Print to save it as PDF from the browser."), h("div", { class: "prm-inline" }, saveB, openB)));
    } catch (e) { pd.close(); void alertDialog("Report", h("div", { class: "dlg-msg" }, (e as Error).message)); }
  }

  // ------------------------------------------------------------ samples
  async loadSampleProject() {
    if (this.s.dirty && this.s.project.chains.length && !(await confirmDialog("Sample Case", "Replace the current project with the sample case?", "Load Sample", true))) return;
    this.ctx.newProject();
    const s = this.s;
    const f = (type: string, params: Record<string, any> = {}): FilterInstance => ({ id: uid("f"), type, params: { ...defaultParams(FILTERS[type]), ...params }, enabled: true });
    const plate: ChainDoc = { id: uid("chain"), name: "Sample - License Plate", filters: [
      f("test_pattern", { pattern: "plate", frames: 40, blur: 9, blurAngle: 12, noise: 12, shake: 4, seed: 7 }),
      f("local_stabilization", { roi: { x: 205, y: 132, w: 230, h: 122 }, reference: 0, search: 24 }),
      f("frame_averaging", { mode: "all", method: "mean" }),
      f("motion_deblurring", { length: 9, angle: 12, method: "wiener", noise: 0.004 }),
      f("crop", { rect: { x: 196, y: 124, w: 248, h: 140 } }),
      f("resize", { mode: "scale", scale: 250, interp: "bicubic" }),
      f("levels", { inBlack: 12, inWhite: 236, gamma: 1.05 }),
    ] };
    const periodic: ChainDoc = { id: uid("chain"), name: "Sample - Periodic Noise", filters: [
      f("test_pattern", { pattern: "periodic", frames: 1, blur: 0, noise: 4, shake: 0, seed: 11 }),
      f("fourier_filter", { view: "filtered", filter: "notch", points: [{ x: 411.7, y: 200.1 }, { x: 341.4, y: 135.9 }], radius: 6, symmetric: true }),
    ] };
    const chart: ChainDoc = { id: uid("chain"), name: "Sample - Resolution Chart", filters: [
      f("test_pattern", { pattern: "chart", width: 800, height: 450, frames: 1, blur: 0, noise: 3, shake: 0, seed: 3 }),
      f("unsharp_mask", { radius: 1.2, amount: 0.8 }),
    ] };
    s.mutate((p) => { p.chains.push(plate, periodic, chart); p.name = "Sample Case"; p.caseInfo = { caseNumber: "DEMO-2026-001", exhibit: "Synthetic test material", examiner: "", agency: "", notes: "Synthetic, deterministic material generated by the Test Pattern loader. The plate chain demonstrates stabilization, frame averaging, motion deblurring, crop and resize." }; });
    s.setUi({ chainId: plate.id });
    s.selectFilter(null, plate.id);
    s.setDirty(false);
    this.ctx.updateTitle();
    s.status(touchText("Sample case loaded. Click the filters in History to see each processing step."));
  }

  // ------------------------------------------------------------ dialogs
  preferences() {
    const s = this.s, pr = { ...s.prefs };
    const body = h("div", { class: "form" },
      h("div", { class: "form-row" }, h("span", null, "Theme:"), selectBox([["midnight", "Midnight (2025 interface)"], ["classic", "Classic Graphite"]], pr.theme, (v) => { pr.theme = v as any; })),
      h("div", { class: "form-row" }, h("span", null, "Layout:"), selectBox([["auto", "Automatic"], ["desktop", "Desktop"], ["compact", "Compact (touch)"]], pr.layout, (v) => { pr.layout = v as any; })),
      h("div", { class: "form-row" }, h("span", null, "Frame Cache (MB):"), spinBox({ value: pr.cacheMB, min: 64, max: 8192, width: 100, onChange: (v) => { pr.cacheMB = v; } }).el),
      h("div", { class: "form-row", title: "Heavy filters (deblurring, denoising, stabilization, video conversion) are split across processor cores. Results are identical with any number of threads." },
        h("span", null, "Processing Threads:"),
        selectBox([["0", `Automatic (${autoThreads()} of ${navigator.hardwareConcurrency || "?"} logical CPUs)`], ["1", "1 (single thread)"], ["2", "2"], ["3", "3"], ["4", "4"], ["6", "6"], ["8", "8"]], String(pr.threads ?? 0), (v) => { pr.threads = Number(v); })),
      checkBox("GPU preview while adjusting a filter (WebGPU; the exact result replaces it automatically)", pr.gpuPreview !== false, (v) => { pr.gpuPreview = v; }).el,
      h("div", { class: "form-row" }, h("span", null, "Default Sequence Frame Rate:"), spinBox({ value: pr.defaultFps, min: 1, max: 240, decimals: 3, width: 100, onChange: (v) => { pr.defaultFps = v; } }).el),
      h("div", { class: "form-row", title: "How the Viewer scales frames to the screen (display only: processing and exports always use the exact pixels)." }, h("span", null, "Viewer Display:"),
        selectBox([["sharp", "Sharp: equal-size pixels at any zoom"], ["nearest", "Nearest neighbor"], ["smooth", "Smooth (bilinear)"]], pr.viewerInterp, (v) => { pr.viewerInterp = v as any; })),
      checkBox("Compute frame MD5 hash (Pointer and Histogram tools)", pr.frameHash, (v) => { pr.frameHash = v; }).el,
      checkBox("Play every frame (no frame dropping during playback)", pr.playAllFrames, (v) => { pr.playAllFrames = v; }).el,
      checkBox("Auto-save the session in the browser (restore after reload)", pr.autoSave, (v) => { pr.autoSave = v; }).el,
      checkBox("Confirm before deleting chains", pr.confirmDelete, (v) => { pr.confirmDelete = v; }).el,
      h("div", { class: "form-sep" }, "Export"),
      checkBox("Lossless exports only: hide and refuse formats with lossy compression (MP4, WebM, Motion JPEG, JPEG, WebP)", pr.losslessOnly, (v) => { pr.losslessOnly = v; }).el,
      checkBox("Verify lossless exports: read the written file back and compare every frame bit for bit", pr.verifyExports, (v) => { pr.verifyExports = v; }).el,
      this.hasSavePicker()
        ? checkBox("Choose where to save exports and write them straight to disk (no size limit)", pr.saveToDisk, (v) => { pr.saveToDisk = v; }).el
        : null,
      this.stagingSettings());
    dialog({ title: "Settings", body, width: 520, buttons: [{ label: "Cancel" }, { label: "Clear Cache", action: () => { void this.e.call("clearCache"); toast("Cache cleared.", "ok"); return false; } }, { label: "OK", primary: true, action: () => { s.savePrefs(pr); void this.e.call("setCacheLimit", pr.cacheMB); void this.e.call("setThreads", pr.threads ?? 0); this.ctx.applyTheme(); this.ctx.applyLayoutMode(); } }] });
  }

  /** Settings › Export: where downloads are staged, and the staged files of this session. */
  private stagingSettings(): HTMLElement {
    const el = h("div", { class: "muted small staging-info" }, "Checking the browser's storage…");
    void (async () => {
      const st = await this.staging.status().catch(() => null);
      const items = this.staging.list(), bytes = items.reduce((n, i) => n + i.bytes, 0);
      const picker = this.hasSavePicker();
      const parts: (string | HTMLElement)[] = [];
      if (st?.ok) {
        parts.push(`${picker ? "Without a chosen file, exports" : "Exports"} above ${fmtBytes(this.staging.minBytes)} and recordings are written to disk in the browser's storage, not memory, and downloaded from there${st.room !== null ? ` (room: ${fmtBytes(st.room)}${st.persisted ? ", persistent" : ""})` : ""}.`);
        if (st.canPersist) {
          const ask = h("button", { class: "btn sm" }, "Allow More Storage…");
          ask.addEventListener("click", async () => { const ok = await this.staging.requestPersistence(); toast(ok ? "Persistent storage allowed: the site may now use up to half of the disk." : "The browser did not allow persistent storage.", ok ? "ok" : "info", 6000); el.replaceWith(this.stagingSettings()); });
          parts.push(" ", ask);
        }
        const manage = h("button", { class: "btn sm" }, "Manage…");
        manage.addEventListener("click", () => this.stagedDownloads(() => el.replaceWith(this.stagingSettings())));
        parts.push(h("br"), `Staged downloads: ${items.length ? `${items.length} file${items.length === 1 ? "" : "s"}, ${fmtBytes(bytes)}` : "none"}. `, manage);
      } else if (!picker) {
        parts.push(`This browser cannot write straight to disk${st?.reason ? ` (${st.reason})` : ""}: exports are assembled in memory and then downloaded. Chrome and Edge on computers write exports of any size directly to disk; other browsers stage them on disk when the page is served over https.`);
      } else el.hidden = true;
      el.replaceChildren(...parts);
    })();
    return el;
  }

  /** Lists the staged downloads of this session: download again or remove. */
  stagedDownloads(onChange?: () => void) {
    const body = h("div", { class: "form" });
    const render = () => {
      const items = this.staging.list();
      const rows = items.map((it) => {
        const again = h("button", { class: "btn sm" }, "Download");
        again.addEventListener("click", () => this.staging.download(it.entry));
        const inUse = this.fileInUse(it.file);
        const del = h("button", { class: "btn sm", disabled: inUse, title: inUse ? "Loaded in the project: remove its chain first" : "" }, "Remove");
        del.addEventListener("click", async () => { await this.staging.free([it.entry]); render(); onChange?.(); });
        return h("tr", null, h("td", null, it.name), h("td", null, fmtBytes(it.bytes)), h("td", null, it.kind === "recording" ? `Recording${inUse ? " (in use)" : ""}` : "Export"), h("td", null, again, " ", del));
      });
      body.replaceChildren(
        h("div", { class: "dlg-msg" }, "These files were written to disk in the browser's storage for this site and downloaded from there. The browser copies each one into your Downloads folder: remove them once the downloads have finished. LUCID also removes them the next time it starts."),
        items.length ? h("table", { class: "info-table" }, h("thead", null, h("tr", null, h("th", null, "File"), h("th", null, "Size"), h("th", null, "Kind"), h("th", null, ""))), h("tbody", null, ...rows)) : h("p", { class: "muted" }, "No staged downloads."));
    };
    render();
    dialog({ title: "Staged Downloads", body, width: 600, buttons: [
      { label: "Remove All", danger: true, action: async () => { const ids = this.staging.list().filter((i) => !this.fileInUse(i.file)).map((i) => i.entry); const freed = await this.staging.free(ids); toast(`Freed ${fmtBytes(freed)} of browser storage.`, "ok"); render(); onChange?.(); return false; } },
      { label: "Close", primary: true },
    ] });
  }

  async systemCheck() {
    const yes = (b: boolean) => (b ? "✔ Yes" : "✖ No");
    const vc = typeof VideoDecoder !== "undefined";
    const codec = async (c: string) => { try { return vc && (await VideoDecoder.isConfigSupported({ codec: c })).supported === true; } catch { return false; } };
    const enc = async (c: string) => { try { return typeof VideoEncoder !== "undefined" && (await VideoEncoder.isConfigSupported({ codec: c, width: 640, height: 480 })).supported === true; } catch { return false; } };
    const rows: [string, string][] = [
      ["Browser", navigator.userAgent], ["Logical CPUs", String(navigator.hardwareConcurrency || "?")], ["Device Memory", (navigator as any).deviceMemory ? `${(navigator as any).deviceMemory} GB` : "?"],
      ["Web Workers", yes(typeof Worker !== "undefined")], ["OffscreenCanvas", yes(typeof OffscreenCanvas !== "undefined")],
      ["WebCodecs Decoder", yes(vc)], ["H.264 decode", yes(await codec("avc1.42E01E"))], ["H.265 decode", yes(await codec("hvc1.1.6.L93.B0"))], ["VP9 decode", yes(await codec("vp09.00.10.08"))], ["AV1 decode", yes(await codec("av01.0.04M.08"))],
      ["H.264 encode", yes(await enc("avc1.42001f"))], ["VP9 encode", yes(await enc("vp09.00.10.08"))],
      ["Processing engine", this.e.mode === "worker" ? "Background worker" : "In the page (this browser blocks file access in workers of pages opened from disk)"],
      ["Pixel kernels", await this.e.call<{ wasm?: boolean }>("stats").then((st) => (st.wasm ? "✔ WebAssembly SIMD" : "JavaScript (no WebAssembly SIMD in this browser: same results, slower display)")).catch(() => "?")],
      ["Processing threads", await this.e.call<{ pool?: { threads: number; helpers: number; broken: boolean } }>("stats").then((st) => st.pool ? (st.pool.broken ? `✖ 1 (this browser cannot start processing threads)` : `✔ ${st.pool.threads}${st.pool.threads > 1 ? ` (${st.pool.helpers} worker${st.pool.helpers === 1 ? "" : "s"} started so far; they start with the first heavy filter)` : ""}`) : "?").catch(() => "?")],
      ["WebGPU (preview while adjusting)", await gpuStatus()],
      ["ImageDecoder (animated images)", yes(typeof (window as any).ImageDecoder !== "undefined")], ["File System Access (Save)", yes(typeof (window as any).showSaveFilePicker === "function")],
      ["Canvas pixel readback", await this.pixelCheck().then((p) => (p.engineCanvas && p.pageCanvas ? "✔ Exact" : "✖ Altered by the browser (fingerprinting protection)"))],
      ["Image readback without canvas (VideoFrame)", yes(await this.pixelCheck().then((p) => p.videoFrame))],
      ["Browser storage for exports", await this.staging.status().then((st) => st.ok ? `✔ Yes (${st.api === "sync" ? "access handle" : "writable stream"}${st.room !== null ? `, room ${fmtBytes(st.room)}` : ""})` : `✖ No${st.reason ? ` (${st.reason})` : ""}`).catch(() => "✖ No")],
      ["Secure Context", yes(window.isSecureContext)],
    ];
    void alertDialog("System Check", h("div", null, h("table", { class: "info-table" }, h("tbody", null, ...rows.map(([k, v]) => h("tr", null, h("td", null, k), h("td", { class: v.startsWith("✖") ? "warn" : "" }, v))))), h("p", { class: "muted small" }, "Formats that the browser cannot decode can still be inspected (File Info, Convert DVR). Images, AVI (MJPEG/uncompressed), sequences, writing to AVI and all processing work in every modern browser.")));
  }
}

/**
 * iPhone/iPad: a video chosen from the Photos library in the browser's file picker is re-encoded by iOS
 * ("Compressing Video…") before the page receives it; a copy saved to Files is passed on untouched.
 * Told once per device, after the first video.
 */
function iosPickerTip() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!ios) return;
  try { if (localStorage.getItem("lucid.tip.iosPicker")) return; localStorage.setItem("lucid.tip.iosPicker", "1"); } catch { /* storage unavailable: tell every time */ }
  toast("iPhone/iPad: videos picked from the Photos library are re-compressed by iOS before the browser receives them. For the original quality, save the video to Files first (Photos › Share › Save to Files) and choose it with Browse.", "info", 12000);
}
