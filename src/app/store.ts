// Application state: the project document (undoable) and the UI state.
import { PROJECT_SCHEMA } from "../shared/project";
import type { WriteFormat } from "../shared/formats";
import { BRAND } from "../brand";
import type { AiLogEntry, ChainDoc, FilterInstance, ProgressEvent, ProjectDoc, Pt, RectP, RenderOk, SourceInfo, StreamInfo } from "../shared/types";
import { Emitter } from "../ui/dom";
import type { EngineClient } from "./engineClient";

export type ToolId = "pointer" | "zoom" | "histogram" | "fileinfo" | "clock" | "selector" | "ruler" | "polygon" | "curve" | "crosshair";

export interface UiState {
  chainId: string | null;
  selected: Record<string, string | null>;
  frame: Record<string, number>;
  showInput: boolean;
  tool: ToolId;
  selection: RectP | null;
  ruler: [Pt, Pt] | null;
  polygon: Pt[];
  profile: [Pt, Pt] | null;
  crosshair: Pt | null;
  cursor: { x: number; y: number; rgba: number[] | null } | null;
  inOut: Record<string, [number | null, number | null]>;
  activeOverlay: string | null;
  showSaturated: boolean;
  histChannel: "all" | "r" | "g" | "b" | "y";
  playing: boolean;
}

export interface Prefs {
  theme: "midnight" | "classic";
  cacheMB: number;
  /** Processing threads for heavy filters: 0 = automatic (logical CPUs − 1), 1 = single thread. */
  threads: number;
  /** Show a WebGPU preview while a filter is adjusted (replaced by the exact result automatically). */
  gpuPreview: boolean;
  livePreview: boolean;
  frameHash: boolean;
  playAllFrames: boolean;
  autoSave: boolean;
  defaultFps: number;
  confirmDelete: boolean;
  /** Workspace layout: automatic (compact on small screens), always desktop or always compact. */
  layout: "auto" | "desktop" | "compact";
  /** Hide and refuse every export format with lossy compression (MP4, WebM, Motion JPEG, JPEG, WebP). */
  losslessOnly: boolean;
  /** Read lossless exports back after writing and compare every frame bit for bit. */
  verifyExports: boolean;
  /** Ask where to save exports and stream them straight to disk (File System Access, Chrome/Edge). */
  saveToDisk: boolean;
  /** Last formats chosen in the Write Video / Write Images dialogs. */
  videoFormat: WriteFormat;
  imageFormat: WriteFormat;
  /**
   * How the Viewer scales the frame to the screen. "sharp": every image pixel is drawn as an equal block of
   * screen pixels at any zoom (integer nearest-neighbor upscale, then a sub-pixel smoothing of the remainder);
   * "nearest": plain nearest neighbor (uneven pixel sizes at fractional zooms); "smooth": bilinear.
   * Below 100 % all modes but "nearest" average (high quality downscaling). Display only: never the pixels.
   */
  viewerInterp: "sharp" | "nearest" | "smooth";
}

/**
 * Frame cache that fits the device. Mobile browsers kill tabs that use too much memory, so phones
 * and tablets get less. deviceMemory (GB, capped at 8) is only reported by Chromium browsers.
 */
export function defaultCacheMB(): number {
  const dm = typeof navigator !== "undefined" ? (navigator as { deviceMemory?: number }).deviceMemory : undefined;
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  if (dm) return Math.max(128, Math.min(768, Math.round(dm * (coarse ? 64 : 96))));
  return coarse ? 256 : 768;
}

const DEFAULT_PREFS: Prefs = { theme: "midnight", cacheMB: 768, threads: 0, gpuPreview: true, livePreview: true, frameHash: true, playAllFrames: false, autoSave: true, defaultFps: 25, confirmDelete: true, layout: "auto", losslessOnly: true, verifyExports: true, saveToDisk: true, videoFormat: "avi-raw", imageFormat: "tiff16", viewerInterp: "sharp" };

export function emptyProject(): ProjectDoc {
  const now = new Date().toISOString();
  return { app: BRAND.fullName, schema: PROJECT_SCHEMA, name: "New Project", chains: [], sources: {}, caseInfo: { caseNumber: "", examiner: "", agency: "", exhibit: "", notes: "" }, bookmarks: [], created: now, modified: now };
}

type Events = {
  project: [{ structural: boolean }];
  ui: [Set<keyof UiState>];
  rendered: [RenderOk & { chainId: string; filterId: string | null; input: boolean }];
  renderError: [{ chainId: string; error: string; filterId?: string }];
  sources: [];
  progress: [ProgressEvent];
  status: [string];
  prefs: [];
  dirty: [boolean];
  aiLog: [AiLogEntry];
};

export class Store extends Emitter<Events> {
  project: ProjectDoc = emptyProject();
  ui: UiState = {
    chainId: null, selected: {}, frame: {}, showInput: false, tool: "pointer", selection: null, ruler: null, polygon: [], profile: null,
    crosshair: null, cursor: null, inOut: {}, activeOverlay: null, showSaturated: false, histChannel: "all", playing: false,
  };
  prefs: Prefs;
  sources = new Map<string, SourceInfo>();
  /** Files for each source (kept on the UI thread for relinking, audio and the media element engine). */
  files = new Map<string, File[]>();
  /** Last stream info seen for each chain output (from renders). */
  streamInfo = new Map<string, StreamInfo>();
  lastRender: (RenderOk & { chainId: string; filterId: string | null; input: boolean }) | null = null;
  dirty = false;
  fileHandle: any = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private lastCoalesce: string | null = null;
  private lastMutate = 0;

  constructor(public engine: EngineClient) {
    super();
    let saved: Partial<Prefs> = {};
    try { saved = JSON.parse(localStorage.getItem("lucid.prefs") || "{}"); } catch { /* ignore */ }
    const cacheMB = defaultCacheMB();
    // 768 was the fixed default of earlier versions (saved along with any other preference):
    // on devices with less memory it is replaced by the device default.
    if (saved.cacheMB === 768 && cacheMB < 768) delete saved.cacheMB;
    this.prefs = { ...DEFAULT_PREFS, cacheMB, ...saved };
  }

  savePrefs(patch: Partial<Prefs>) {
    this.prefs = { ...this.prefs, ...patch };
    try { localStorage.setItem("lucid.prefs", JSON.stringify(this.prefs)); } catch { /* storage unavailable (sandboxed context) */ }
    this.emit("prefs");
  }

  // ------------------------------------------------------------ project
  private snapshot() { return JSON.stringify({ chains: this.project.chains, bookmarks: this.project.bookmarks, sources: this.project.sources, caseInfo: this.project.caseInfo, name: this.project.name }); }

  mutate(fn: (p: ProjectDoc) => void, opts: { coalesce?: string; structural?: boolean } = {}) {
    const now = Date.now();
    if (!(opts.coalesce && opts.coalesce === this.lastCoalesce && now - this.lastMutate < 1500)) {
      this.undoStack.push(this.snapshot());
      if (this.undoStack.length > 300) this.undoStack.shift();
      this.redoStack = [];
    }
    this.lastCoalesce = opts.coalesce ?? null;
    this.lastMutate = now;
    fn(this.project);
    this.project.modified = new Date().toISOString();
    this.setDirty(true);
    this.syncEngine();
    this.emit("project", { structural: opts.structural ?? true });
  }

  syncEngine() { void this.engine.call("setProject", this.project.chains); }

  setDirty(d: boolean) { if (this.dirty !== d) { this.dirty = d; this.emit("dirty", d); } }

  /** Serialized state of the undoable part of the project (AI checkpoints). */
  checkpoint(): string { return this.snapshot(); }

  /** Return to a checkpoint as one undoable step. */
  restoreCheckpoint(snap: string) {
    if (snap === this.snapshot()) return;
    this.undoStack.push(this.snapshot());
    this.redoStack = [snap]; // a new branch of history; restore() below pops it and applies it
    this.restore(this.redoStack, []);
  }

  /** Append to the AI audit trail (not undoable: the record of what happened stays). */
  appendAiLog(entry: AiLogEntry) {
    this.project.aiLog = [...(this.project.aiLog ?? []), entry];
    this.setDirty(true);
    this.emit("aiLog", entry);
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  undo() { this.restore(this.undoStack, this.redoStack); }
  redo() { this.restore(this.redoStack, this.undoStack); }
  private restore(from: string[], to: string[]) {
    const s = from.pop();
    if (!s) return;
    to.push(this.snapshot());
    Object.assign(this.project, JSON.parse(s));
    this.lastCoalesce = null;
    const chainIds = new Set(this.project.chains.map((c) => c.id));
    if (this.ui.chainId && !chainIds.has(this.ui.chainId)) this.ui.chainId = this.project.chains[0]?.id ?? null;
    if (!this.ui.chainId && this.project.chains.length) this.ui.chainId = this.project.chains[0].id;
    this.setDirty(true);
    this.syncEngine();
    this.emit("project", { structural: true });
    this.emit("ui", new Set(["chainId", "selected"] as (keyof UiState)[]));
  }

  loadProject(p: ProjectDoc) {
    this.project = p;
    this.undoStack = []; this.redoStack = [];
    this.ui.chainId = p.chains[0]?.id ?? null;
    this.ui.selected = {}; this.ui.frame = {}; this.ui.inOut = {};
    this.streamInfo.clear();
    this.lastRender = null;
    this.setDirty(false);
    this.syncEngine();
    this.emit("project", { structural: true });
    this.emit("ui", new Set(["chainId", "selected", "frame"] as (keyof UiState)[]));
  }

  // ------------------------------------------------------------ accessors
  chain(id = this.ui.chainId): ChainDoc | undefined { return this.project.chains.find((c) => c.id === id); }

  selectedFilter(chainId = this.ui.chainId): FilterInstance | undefined {
    const c = this.chain(chainId);
    if (!c) return undefined;
    const sel = this.ui.selected[c.id];
    return (sel && c.filters.find((f) => f.id === sel)) || c.filters[c.filters.length - 1];
  }

  frameOf(chainId = this.ui.chainId): number { return chainId ? this.ui.frame[chainId] ?? 0 : 0; }

  setUi(patch: Partial<UiState>) {
    const keys = new Set<keyof UiState>();
    for (const k of Object.keys(patch) as (keyof UiState)[]) {
      if ((this.ui as any)[k] !== (patch as any)[k]) { (this.ui as any)[k] = (patch as any)[k]; keys.add(k); }
    }
    if (keys.size) this.emit("ui", keys);
  }

  setFrame(frame: number, chainId = this.ui.chainId) {
    if (!chainId) return;
    const info = this.streamInfo.get(chainId);
    const n = info ? info.frameCount : Infinity;
    const f = Math.max(0, Math.min(n - 1, Math.round(frame)));
    if (this.ui.frame[chainId] === f) return;
    this.ui.frame = { ...this.ui.frame, [chainId]: f };
    this.emit("ui", new Set(["frame"] as (keyof UiState)[]));
  }

  selectFilter(filterId: string | null, chainId = this.ui.chainId) {
    if (!chainId) return;
    this.ui.selected = { ...this.ui.selected, [chainId]: filterId };
    this.ui.activeOverlay = null;
    this.emit("ui", new Set(["selected", "activeOverlay"] as (keyof UiState)[]));
  }

  status(msg: string) { this.emit("status", msg); }
}
