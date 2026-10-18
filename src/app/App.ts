// Application shell: title bar, menus, toolbar, Trellis dockable workspace, status bar,
// keyboard shortcuts, drag & drop and session restore.
import { createDocument, createWorkspace, layout as L, sanitize, type LayoutDocument, type LayoutSpec, type ViewHandle, type ViewTypes, type WorkspaceHandle } from "@danfessler/trellis";
import { BRAND } from "../brand";
import { CATEGORIES, FILTER_LIST } from "../shared/filters";
import { migrateProject } from "../shared/project";
import type { SourceInfo } from "../shared/types";
import { FiltersPanel } from "../panels/FiltersPanel";
import { FilterSettingsPanel } from "../panels/FilterSettingsPanel";
import { HistoryPanel } from "../panels/HistoryPanel";
import { PlayerPanel } from "../panels/PlayerPanel";
import { ToolsPanel } from "../panels/ToolsPanel";
import { ViewerPanel } from "../panels/ViewerPanel";
import { alertDialog, confirmDialog, dialog, toast } from "../ui/dialog";
import { debounce, Emitter, fmtBytes, h, pickFiles, svg } from "../ui/dom";
import { I, logoSvg } from "../ui/icons";
import { MenuBar, type MenuDef } from "../ui/menu";
import { isTouchUi } from "../ui/touch";
import { Actions } from "./actions";
import { AudioEngine } from "./audio";
import type { AppCommand, AppCtx, BusEvents } from "./context";
import { EngineClient } from "./engineClient";
import { MediaElementFrames } from "./mtVideo";
import { fmtSpeed, Player, SPEED_PRESETS } from "./player";
import { Agent } from "../ai/agent";
import { Mcp } from "../mcp";
import { openMcpDialog } from "../panels/McpDialog";
import { AiPanel } from "../panels/AiPanel";
import { openPalette } from "../ui/palette";
import { Session } from "./session";
import { emptyProject, Store } from "./store";

const PANELS: { type: string; title: string }[] = [
  { type: "filters", title: "Filters" }, { type: "tools", title: "Tools" }, { type: "settings", title: "Filter Settings" },
  { type: "history", title: "History" }, { type: "player", title: "Player" }, { type: "ai", title: "AI Assistant" },
];

/**
 * Workspace layouts. "desktop" is the reference layout (identical to the classic desktop
 * application). Small screens get a touch friendly arrangement of the same panels:
 * "stack" (portrait: Viewer / Player / tabbed tools) and "side" (landscape: Viewer and
 * Player / tabbed tools). Every layout keeps its own user customizations.
 */
export type LayoutMode = "desktop" | "stack" | "side";
const LAYOUT_VERSION = 5;
const VIEW_IDS = { filters: "filters-main", tools: "tools-main", viewer: "viewer-main", settings: "settings-main", history: "history-main", player: "player-main", ai: "ai-main" } as const;
type PanelType = keyof typeof VIEW_IDS;

export class App implements AppCtx {
  engine = new EngineClient();
  store = new Store(this.engine);
  actions = new Actions();
  bus = new Emitter<BusEvents>();
  audio = new AudioEngine();
  mtVideo = new MediaElementFrames();
  player: Player;
  /** The AI assistant (outlives its panel). */
  agent: Agent;
  mcp: Mcp;
  private aiPanel: AiPanel | null = null;
  private workspace: WorkspaceHandle | null = null;
  private mainViewer: ViewerPanel | null = null;
  private viewers = new Map<string, ViewerPanel>();
  private filtersPanel: FiltersPanel | null = null;
  private history: HistoryPanel | null = null;
  private session = new Session();
  private root: HTMLElement;
  private titleEl!: HTMLElement;
  private statusMsg!: HTMLElement;
  private statusFile!: HTMLElement;
  private statusProg!: HTMLElement;
  private statusCache!: HTMLElement;
  private tasks = new Map<string, { label: string; value: number }>();
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  layoutMode: LayoutMode = "desktop";
  private viewTypes: ViewTypes = {};

  constructor(private host: HTMLElement) {
    this.actions.ctx = this;
    this.player = new Player(this.store, this.audio, () => this.mainViewer?.isBusy ?? false);
    this.mcp = new Mcp(this);
    this.agent = new Agent(this);
    this.root = h("div", { class: "app" });
    host.appendChild(this.root);
    this.applyTheme();
    this.buildChrome();
    this.buildWorkspace();
    this.wire();
    void this.engine.call("setCacheLimit", this.store.prefs.cacheMB);
    void this.engine.call("setThreads", this.store.prefs.threads);
    this.updateTitle();
    void this.maybeRestore();
    void this.mcp.start();
    // staging files left by LUCID tabs that were closed (downloads of earlier sessions)
    setTimeout(() => void this.actions.staging.sweep(), 5000);
    // fingerprinting protections that perturb canvas readback would alter some decoded pixels
    setTimeout(() => void this.actions.warnIfPixelsPerturbed(), 1500);
  }

  // ------------------------------------------------------------ AppCtx
  viewer() { return this.mainViewer; }
  ws() { return this.workspace; }

  applyTheme() {
    const t = this.store.prefs.theme;
    document.documentElement.dataset.theme = t;
    this.workspace?.update({ theme: t === "classic" ? "medium" : "dark" });
  }

  updateTitle() {
    if (!this.titleEl) return;
    const t = `${BRAND.name} ${BRAND.edition} - ${this.store.project.name}${this.store.dirty ? "*" : ""}`;
    this.titleEl.textContent = t;
    document.title = t;
  }

  newProject() {
    this.player.pause();
    for (const id of this.store.sources.keys()) void this.engine.call("closeSource", id);
    this.store.sources.clear();
    this.store.files.clear();
    this.store.fileHandle = null;
    this.store.loadProject(emptyProject());
    this.store.setUi({ selection: null, ruler: null, polygon: [], profile: null, crosshair: null, showInput: false });
    this.store.emit("sources");
    void this.session.clear();
    this.updateTitle();
  }

  openViewer(chainId?: string) {
    const ws = this.workspace;
    if (!ws) return;
    const id = `viewer2_${Date.now().toString(36)}`;
    const mainView = ws.views({ type: "viewer" })[0];
    ws.open("viewer2", { id, params: { chainId: chainId ?? this.store.ui.chainId }, placement: mainView ? { beside: mainView.panelId, edge: "right", share: 0.5 } : "stage" });
  }

  // ------------------------------------------------------------ AI assistant and commands
  /** Show the AI Assistant panel (restoring it if hidden) and focus its input. */
  focusAi(prefill?: string) {
    const ws = this.workspace;
    if (!ws) return;
    const v = ws.views({ type: "ai" })[0];
    if (!v) ws.open("ai", { id: VIEW_IDS.ai, focus: false });
    else if (v.placement === "hidden") ws.restore(v.panelId);
    // bring the tab forward without Trellis moving the focus (it would land on the first button)
    ws.select(VIEW_IDS.ai);
    // focus at once when the panel is there (keys typed right after Ctrl+I must reach it, not the shortcuts);
    // a panel that is still being mounted is focused as soon as it exists
    this.whenAiPanel((p) => p.focus(prefill));
  }

  /** Run `fn` with the AI panel once it is mounted and shown (focus() is ignored on hidden elements):
   *  now, or on the next frames while its tab is being brought forward (up to ~1 s). */
  private whenAiPanel(fn: (p: AiPanel) => void, tries = 60) {
    const p = this.aiPanel;
    if (p && p.el.isConnected && p.el.getClientRects().length > 0) { fn(p); return; }
    if (tries > 0) requestAnimationFrame(() => this.whenAiPanel(fn, tries - 1));
    else if (p) fn(p);
  }

  aiSettings() { this.focusAi(); this.whenAiPanel((p) => p.settings()); }

  /** Command palette (Ctrl+K): every command; a sentence goes to the AI assistant. */
  palette() {
    openPalette(this.commands(), { onAsk: (t) => { this.focusAi(); this.whenAiPanel((p) => p.ask(t)); } });
  }

  commands(): AppCommand[] {
    const out: AppCommand[] = [];
    const walk = (group: string, items: MenuDef[]) => {
      for (const it of items) {
        if (it === "-") continue;
        if (it.items) { walk(`${group} › ${it.label}`, it.items); continue; }
        if (!it.action) continue;
        out.push({ id: `menu:${group.replace(/ › /g, "/")}/${it.label.replace(/…$/, "")}`, label: it.label, group, kind: "menu", shortcut: it.shortcut, disabled: it.disabled, run: it.action });
      }
    };
    for (const m of this.menus()) walk(m.label, m.items());
    const hasChain = !!this.store.chain();
    for (const f of FILTER_LIST) {
      if (f.kind === "loader" && f.id !== "test_pattern") continue;
      out.push({ id: `filter:${f.id}`, label: f.name, group: `Add Filter › ${f.category}`, kind: "filter", keywords: `${f.id} ${f.description}`, disabled: !hasChain && f.kind !== "loader", run: () => this.actions.addFilter(f.id) });
    }
    for (const v of SPEED_PRESETS) out.push({ id: `speed:${v}`, label: `Playback Speed ${fmtSpeed(v)}×`, group: "Player", kind: "player", keywords: "slow motion speed", run: () => this.player.setSpeed(v) });
    out.push({ id: "player:toggle", label: "Play / Pause", group: "Player", kind: "player", shortcut: "Space", run: () => this.player.toggle() });
    out.push({ id: "ai:ask", label: "Ask the AI Assistant…", group: "AI Assistant", kind: "panel", shortcut: "Ctrl+I", keywords: "chat agent copilot llm", run: () => this.focusAi() });
    out.push({ id: "ai:settings", label: "AI Settings…", group: "AI Assistant", kind: "panel", keywords: "provider model api key openai anthropic gemini ollama", run: () => this.aiSettings() });
    out.push({ id: "ai:new", label: "New AI Chat", group: "AI Assistant", kind: "panel", run: () => { this.agent.newChat(); this.focusAi(); } });
    out.push({ id: "ai:mcp", label: "MCP: AI Applications and MCP Servers…", group: "AI Assistant", kind: "panel", keywords: "model context protocol claude cursor vscode codex gemini webmcp server client bridge", run: () => openMcpDialog(this) });
    return out;
  }

  // ------------------------------------------------------------ chrome
  private buildChrome() {
    this.titleEl = h("span", { class: "title-text" });
    const fs = h("button", { class: "title-btn", title: "Full screen (F11)", hidden: !this.canFullscreen() }, svg(I.fullscreen));
    fs.addEventListener("click", () => this.toggleFullscreen());
    const titlebar = h("div", { class: "titlebar" }, h("span", { class: "title-logo", html: logoSvg(BRAND.letters, 20) }), this.titleEl, h("span", { class: "flex1" }), fs);
    const menubar = h("div", { class: "menubar" });
    new MenuBar(menubar, this.menus());
    const a = this.actions;
    const tb = (icon: string, title: string, fn: () => void) => { const b = h("button", { class: "tb-btn", title, "aria-label": title }, svg(icon)); b.addEventListener("click", fn); return b; };
    this.undoBtn = tb(I.undo, "Undo (Ctrl+Z)", () => this.store.undo()) as HTMLButtonElement;
    this.redoBtn = tb(I.redo, "Redo (Ctrl+Y)", () => this.store.redo()) as HTMLButtonElement;
    const toolbar = h("div", { class: "toolbar" },
      tb(I.newProject, "New Project", () => void a.newProject()),
      tb(I.open, "Open Project / Media (Ctrl+O)", () => void this.openAny()),
      tb(I.save, "Save Project (Ctrl+S)", () => void a.saveProject()),
      tb(I.writeVideo, "Write Video", () => void a.writeVideo()),
      h("span", { class: "tb-sep" }),
      tb(I.info, "File Info", () => this.store.setUi({ tool: "fileinfo" })),
      tb(I.dvr, "Convert DVR", () => void a.convertDvr()),
      tb(I.report, "Generate Report", () => void a.generateReport()),
      h("span", { class: "tb-sep" }),
      this.undoBtn, this.redoBtn,
      h("span", { class: "tb-sep" }),
      tb(I.settings, "Settings", () => a.preferences()),
      h("span", { class: "tb-sep" }),
      tb(I.ai, "AI Assistant (Ctrl+I) — command palette: Ctrl+K", () => this.focusAi()));
    this.statusMsg = h("span", { class: "sb-msg" }, "Ready.");
    this.statusFile = h("span", { class: "sb-file" });
    this.statusProg = h("span", { class: "sb-prog", hidden: true }, h("span", { class: "sb-prog-label" }), h("span", { class: "sb-bar" }, h("i")));
    this.statusCache = h("span", { class: "sb-cache", title: "Engine frame cache" });
    const statusbar = h("div", { class: "statusbar" }, this.statusMsg, this.statusFile, this.statusProg, h("span", { class: "flex1" }), this.statusCache, h("span", { class: "sb-grip" }));
    const wsHost = h("div", { class: "ws-host" });
    this.root.append(titlebar, menubar, toolbar, wsHost, statusbar);
  }

  /** iPhone Safari only allows videos to go full screen; older Safari needs the webkit prefix. */
  private canFullscreen(): boolean {
    const d = document as Document & { webkitFullscreenEnabled?: boolean };
    return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled);
  }

  private toggleFullscreen() {
    const d = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    try {
      if (document.fullscreenElement || d.webkitFullscreenElement) { if (document.exitFullscreen) void document.exitFullscreen(); else d.webkitExitFullscreen?.(); }
      else if (el.requestFullscreen) void el.requestFullscreen().catch(() => toast("Full screen is not available here.", "info"));
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else toast("Full screen is not supported by this browser.", "info");
    } catch { toast("Full screen is not available here.", "info"); }
  }

  private async openAny() {
    const files = await pickFiles("image/*,video/*,.lfp,.json,.avi,.mkv,.mov,.mp4,.m4v,.ts,.webm,.h264,.264,.h265,.265,.hevc,.dav,.mjpg,.tif,.tiff", true);
    if (files.length) await this.actions.loadFiles(files);
  }

  private menus(): { label: string; items: () => MenuDef[] }[] {
    const a = this.actions, s = this.store, p = this.player;
    const hasChain = () => !!s.chain();
    return [
      { label: "File", items: () => [
        { label: "New Project", shortcut: "Ctrl+Alt+N", action: () => void a.newProject() },
        { label: "Open Project…", shortcut: "Ctrl+O", action: () => void a.openProject() },
        { label: "Save Project", shortcut: "Ctrl+S", action: () => void a.saveProject() },
        { label: "Save Project As…", shortcut: "Ctrl+Shift+S", action: () => void a.saveProject(true) },
        { label: "Relink Media…", action: () => void a.relinkMedia() },
        "-",
        { label: "Load Image or Video…", shortcut: "Ctrl+Shift+O", action: () => void a.openMedia() },
        { label: "Load Image Sequence…", action: () => void a.openSequence() },
        { label: "Paste Image", shortcut: "Ctrl+V", action: () => void a.pasteImage() },
        { label: "Video Input (Camera / Screen)…", action: () => void a.captureVideo() },
        { label: "Test Pattern", items: [["plate", "License Plate (degraded)"], ["bars", "Color Bars"], ["chart", "Resolution Chart"], ["zone", "Zone Plate"], ["grid", "Calibration Grid"], ["periodic", "Periodic Noise"]].map(([k, l]) => ({ label: l, action: () => a.addTestPattern({ pattern: k, frames: k === "plate" ? 60 : 1, blur: k === "plate" ? 9 : 0, shake: k === "plate" ? 4 : 0, noise: k === "plate" ? 10 : 3 }, l) })) },
        "-",
        { label: "Write Video…", disabled: !hasChain(), action: () => void a.writeVideo() },
        { label: "Write Images…", disabled: !hasChain(), action: () => void a.writeImages() },
        { label: "Save Snapshot", shortcut: "Ctrl+Shift+E", disabled: !hasChain(), action: () => void a.snapshot() },
        "-",
        { label: "Generate Report…", shortcut: "F9", disabled: !hasChain(), action: () => void a.generateReport() },
        { label: "Project Information…", action: () => void a.projectInfo() },
      ] },
      { label: "Edit", items: () => [
        { label: "Undo", shortcut: "Ctrl+Z", disabled: !s.canUndo, action: () => s.undo() },
        { label: "Redo", shortcut: "Ctrl+Y", disabled: !s.canRedo, action: () => s.redo() },
        "-",
        { label: "Copy Frame to Clipboard", shortcut: "Ctrl+Shift+C", disabled: !s.lastRender, action: () => void a.copyFrame() },
        { label: "Copy Filter", disabled: !s.selectedFilter(), action: () => a.copyFilter(s.selectedFilter()!.id) },
        { label: "Paste Filter", disabled: !a.hasClipboardFilter, action: () => a.pasteFilter() },
        { label: "Remove Filter", shortcut: "Del", disabled: !s.selectedFilter(), action: () => void a.removeFilter(s.selectedFilter()!.id) },
        { label: "Quick Search Filter", shortcut: "Ctrl+F", action: () => this.filtersPanel?.focusSearch() },
        "-",
        { label: "Settings…", action: () => a.preferences() },
      ] },
      { label: "Project", items: () => [
        { label: "Rename Chain…", disabled: !hasChain(), action: () => void a.renameChain(s.ui.chainId!) },
        { label: "Duplicate Chain", disabled: !hasChain(), action: () => a.duplicateChain(s.ui.chainId!) },
        { label: "New Chain From Selected Filter", disabled: !s.selectedFilter(), action: () => a.chainFromHere(s.ui.chainId!, s.selectedFilter()!.id) },
        { label: "Delete Chain", disabled: !hasChain(), action: () => void a.deleteChain(s.ui.chainId!) },
        "-",
        { label: "Add Bookmark", shortcut: "B", disabled: !hasChain(), action: () => void a.addBookmark() },
        { label: "Bookmarks…", action: () => void a.showBookmarks() },
        "-",
        { label: "Set In Point", shortcut: "I", disabled: !hasChain(), action: () => p.setIn(s.frameOf()) },
        { label: "Set Out Point", shortcut: "O", disabled: !hasChain(), action: () => p.setOut(s.frameOf()) },
        { label: "Clear In/Out", action: () => { p.setIn(null); p.setOut(null); } },
        "-",
        { label: "Project Information…", action: () => void a.projectInfo() },
      ] },
      { label: "Utilities", items: () => [
        { label: "Convert DVR…", action: () => void a.convertDvr() },
        { label: "Convert DVR (Last Settings)", action: () => void a.convertDvr(undefined, true) },
        "-",
        { label: "Compute File Hashes (MD5, SHA-1, SHA-256)…", action: () => void a.hashAnyFile() },
        { label: "Hash Output Frames of Chain…", disabled: !hasChain(), action: () => void a.hashFrames(s.ui.chainId!) },
        { label: "Frame Analysis (GOP Structure)", action: () => s.setUi({ tool: "clock" }) },
        { label: "File Info", action: () => s.setUi({ tool: "fileinfo" }) },
        "-",
        { label: "Clear Processing Cache", action: () => { void this.engine.call("clearCache"); toast("Cache cleared.", "ok"); this.mainViewer?.requestRender(); } },
        { label: "System Check…", action: () => void a.systemCheck() },
      ] },
      { label: "View", items: () => [
        ...PANELS.map((pp) => ({ label: pp.title, checked: this.panelVisible(pp.type), action: () => this.togglePanel(pp.type) })),
        "-",
        { label: "New Viewer for Current Chain", disabled: !hasChain(), action: () => this.openViewer() },
        { label: "Command Palette…", shortcut: "Ctrl+K", action: () => this.palette() },
        "-",
        { label: "Zoom In", shortcut: "+", action: () => this.mainViewer?.setZoom(this.mainViewer.zoom * 1.25) },
        { label: "Zoom Out", shortcut: "-", action: () => this.mainViewer?.setZoom(this.mainViewer.zoom / 1.25) },
        { label: "Zoom 100%", shortcut: "1", action: () => this.mainViewer?.setZoom(1) },
        { label: "Fit Window", shortcut: "0", action: () => this.mainViewer?.fit() },
        { label: "Show Input of Selected Filter", shortcut: "Tab", checked: s.ui.showInput, action: () => s.setUi({ showInput: !s.ui.showInput }) },
        "-",
        { label: "Theme", items: [{ label: "Midnight (2025)", checked: s.prefs.theme === "midnight", action: () => { s.savePrefs({ theme: "midnight" }); this.applyTheme(); } }, { label: "Classic Graphite", checked: s.prefs.theme === "classic", action: () => { s.savePrefs({ theme: "classic" }); this.applyTheme(); } }] },
        { label: "Layout", items: ([["auto", "Automatic (by screen size)"], ["desktop", "Desktop"], ["compact", "Compact (phones and tablets)"]] as const).map(([k, l]) => ({ label: l, checked: s.prefs.layout === k, action: () => { s.savePrefs({ layout: k }); this.applyLayoutMode(); } })) },
        { label: "Reset Layout", action: () => this.resetLayout() },
        { label: "Full Screen", shortcut: "F11", disabled: !this.canFullscreen(), action: () => this.toggleFullscreen() },
      ] },
      { label: "Help", items: () => [
        { label: "Quick Start", shortcut: "F1", action: () => this.quickStart() },
        { label: "Load Sample Case", action: () => void a.loadSampleProject() },
        { label: "Keyboard Shortcuts", action: () => this.shortcutsHelp() },
        { label: "AI Assistant Setup…", action: () => this.aiSettings() },
        { label: "MCP (AI Applications, MCP Servers)…", action: () => openMcpDialog(this) },
        { label: "Filter Reference", action: () => this.filterReference() },
        { label: "System Check…", action: () => void a.systemCheck() },
        "-",
        { label: `About ${BRAND.name}`, action: () => this.about() },
      ] },
    ];
  }

  // ------------------------------------------------------------ workspace (Trellis)
  private buildWorkspace() {
    const wsHost = this.root.querySelector(".ws-host") as HTMLElement;
    const closeAcc = (view: ViewHandle, parts: { accessory: HTMLElement }) => {
      const b = h("button", { class: "panel-x", title: "Hide panel (restore from the View menu)", "aria-label": "Hide panel" }, svg(I.close));
      b.addEventListener("click", (e) => { e.stopPropagation(); view.workspace.hide(view.panelId); });
      parts.accessory.appendChild(b);
    };
    const mountPanel = (make: (el: HTMLElement, view: ViewHandle) => HTMLElement, closable = true) => (el: HTMLElement, view: ViewHandle, parts: { icon: HTMLElement; accessory: HTMLElement }) => {
      el.classList.add("lf-content");
      el.appendChild(make(el, view));
      if (closable) closeAcc(view, parts);
    };
    this.viewTypes = {
        filters: { title: "Filters", singleton: true, closable: false, allow: { stage: false }, minSize: { width: 240, height: 180 }, scaling: false, mount: mountPanel(() => { this.filtersPanel = new FiltersPanel(this); return this.filtersPanel.el; }) },
        tools: { title: "Tools", singleton: true, closable: false, allow: { stage: false }, minSize: { width: 240, height: 160 }, scaling: false, mount: mountPanel((_el, view) => new ToolsPanel(this, view).el) },
        viewer: { title: "Viewer", singleton: true, closable: false, placement: "stage", gestures: "exclusive", scaling: false, mount: mountPanel((_el, view) => { const v = new ViewerPanel(this, view.id, true); this.mainViewer = v; this.viewers.set(view.id, v); return v.el; }, false) },
        viewer2: {
          title: (view) => `Viewer — ${this.store.chain(String(view.params.chainId))?.name ?? "chain"}`, closable: true, gestures: "exclusive", scaling: false,
          mount: (el, view) => {
            el.classList.add("lf-content");
            const v = new ViewerPanel(this, view.id, false);
            if (view.params.chainId) v.setChain(String(view.params.chainId));
            this.viewers.set(view.id, v);
            el.appendChild(v.el);
            const off = this.store.on("project", () => view.setTitle(`Viewer — ${this.store.chain(v.chainId ?? "")?.name ?? "chain"}`));
            return () => { off(); v.dispose(); this.viewers.delete(view.id); };
          },
        },
        settings: { title: "Filter Settings", singleton: true, closable: false, allow: { stage: false }, minSize: { width: 260, height: 200 }, scaling: false, mount: mountPanel((_el, view) => new FilterSettingsPanel(this, view).el) },
        history: { title: "History", singleton: true, closable: false, allow: { stage: false }, minSize: { width: 220, height: 140 }, scaling: false, mount: mountPanel(() => { this.history = new HistoryPanel(this); return this.history.el; }) },
        player: { title: "Player", singleton: true, closable: false, allow: { stage: false }, minSize: { width: 600, height: 120 }, scaling: false, mount: mountPanel(() => new PlayerPanel(this, this.audio).el) },
        ai: {
          title: "AI Assistant", singleton: true, closable: false, allow: { stage: false }, minSize: { width: 280, height: 200 }, scaling: false,
          mount: (el, view, parts) => {
            el.classList.add("lf-content");
            const panel = new AiPanel(this, this.agent);
            this.aiPanel = panel;
            el.appendChild(panel.el);
            closeAcc(view, parts);
            return () => { panel.dispose(); if (this.aiPanel === panel) this.aiPanel = null; };
          },
        },
    };
    try { localStorage.removeItem("lucid.layout"); } catch { /* storage unavailable */ }
    this.layoutMode = this.resolveLayoutMode();
    document.documentElement.dataset.layout = this.layoutMode;
    this.applyTypeChrome(this.layoutMode);
    this.workspace = createWorkspace(wsHost, {
      theme: this.store.prefs.theme === "classic" ? "medium" : "dark",
      label: `${BRAND.name} workspace`,
      tabs: { fill: true, inset: 0 },
      tokens: this.layoutTokens(this.layoutMode),
      types: this.viewTypes,
      document: this.loadLayout(this.layoutMode) ?? this.defaultDocument(this.layoutMode),
      onMissingType: () => "drop",
    });
    this.workspace.on("change", (doc) => this.saveLayout(this.layoutMode, doc));
    this.ensurePanels();
    window.addEventListener("resize", debounce(() => {
      // never re-arrange the panels while the on-screen keyboard is up for a text field
      const ae = document.activeElement as HTMLElement | null;
      if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && (ae as HTMLInputElement).type !== "range" && this.layoutMode !== "desktop") return;
      this.applyLayoutMode();
    }, 180));
  }

  /** Makes sure every panel exists (e.g. after a layout saved by an older version). */
  private ensurePanels() {
    const ws = this.workspace!;
    for (const t of ["filters", "tools", "settings", "history", "player", "viewer"] as PanelType[]) if (!ws.views({ type: t }).length) ws.open(t, { id: VIEW_IDS[t], focus: false });
    // the AI Assistant joins History as a tab (layouts saved before it existed)
    if (!ws.views({ type: "ai" }).length) {
      const hist = ws.views({ type: "history" })[0];
      ws.open("ai", { id: VIEW_IDS.ai, focus: false, ...(hist ? { placement: { into: hist.panelId } } : {}) });
    }
  }

  private layoutSpec(mode: LayoutMode): LayoutSpec {
    const V = (t: PanelType) => L.view(t, { id: VIEW_IDS[t] });
    const viewer = L.stage(L.panel(V("viewer")));
    const tabs = () => L.panel({ selected: 0 }, V("filters"), V("settings"), V("history"), V("tools"), V("ai"));
    // The Player gets about the height its (wrapping) controls need; Viewer and tools share the rest.
    const wsH = Math.max(200, window.innerHeight - 118), W = window.innerWidth;
    if (mode === "stack") {
      const rows = W < 520 ? 3 : 2;
      const pf = Math.min(0.26, Math.max(0.1, (44 + rows * 36) / wsH));
      return L.column([viewer, L.panel(V("player")), tabs()], [(1 - pf) * 0.5, pf, (1 - pf) * 0.5]);
    }
    if (mode === "side") {
      const pf = Math.min(0.36, Math.max(0.2, 100 / wsH));
      return L.row([L.column([viewer, L.panel(V("player"))], [1 - pf, pf]), tabs()], [1.7, 1]);
    }
    return L.row([
      L.column([
        L.row([L.column([V("filters"), V("tools")], [1, 1.05]), viewer], [1, 3.5]),
        V("player"),
      ], [3.7, 1]),
      L.column([V("settings"), L.panel({ selected: 0 }, V("history"), V("ai"))], [1.37, 1]),
    ], [3.9, 1]);
  }

  /**
   * Compact layouts drop the redundant "Viewer" and "Player" title bars (they are alone in their
   * panels) to give the image more room. The type objects are updated in place: passing a new
   * `types` object to Trellis would remount every panel.
   */
  private applyTypeChrome(mode: LayoutMode) {
    for (const t of ["viewer", "player"]) {
      const def = this.viewTypes[t] as { tabbar?: "always" | "auto" | "never" | "overlay" } | undefined;
      if (def) def.tabbar = mode === "desktop" ? "always" : "auto";
    }
  }

  /** Taller (finger sized) panel tab bars in the compact layouts. */
  private layoutTokens(mode: LayoutMode): Record<string, string> { return { "--trellis-tabbar-height": mode === "desktop" ? "22px" : "30px" }; }

  private defaultDocument(mode: LayoutMode): LayoutDocument { return createDocument(this.layoutSpec(mode), { version: LAYOUT_VERSION }); }

  private layoutKey(mode: LayoutMode) { return `lucid.layout.${mode}.v${LAYOUT_VERSION}`; }

  private loadLayout(mode: LayoutMode): LayoutDocument | null {
    try {
      const raw = localStorage.getItem(this.layoutKey(mode));
      if (!raw) return null;
      const doc = sanitize(JSON.parse(raw), (t) => t in this.viewTypes);
      return doc.root ? doc : null;
    } catch { return null; }
  }

  private saveLayout(mode: LayoutMode, doc: LayoutDocument) {
    try { localStorage.setItem(this.layoutKey(mode), JSON.stringify(doc)); } catch { /* storage unavailable (sandboxed context) */ }
  }

  /** Layout for the current preference and screen: phones and small windows get a compact layout. */
  private resolveLayoutMode(): LayoutMode {
    const pref = this.store.prefs.layout;
    const w = window.innerWidth, hgt = window.innerHeight;
    const compact = pref === "compact" || (pref !== "desktop" && (w < 900 || hgt < 540));
    if (!compact) return "desktop";
    return w > hgt * 1.1 ? "side" : "stack";
  }

  /** Re-evaluates the layout (after a resize, a rotation or a preference change). */
  applyLayoutMode(force = false) {
    const ws = this.workspace;
    if (!ws) return;
    const mode = this.resolveLayoutMode();
    if (mode === this.layoutMode && !force) return;
    this.layoutMode = mode;
    document.documentElement.dataset.layout = mode;
    this.applyTypeChrome(mode);
    ws.update({ tokens: this.layoutTokens(mode) });
    ws.setDocument(this.loadLayout(mode) ?? this.defaultDocument(mode), { animate: false });
    this.ensurePanels();
    this.filtersPanel?.refresh();
    this.history?.render();
    this.bus.emit("layout", mode);
    this.store.status(mode === "desktop" ? "Desktop layout." : this.store.prefs.layout === "compact" ? "Compact layout (View › Layout to change)." : "Compact layout for small screens (View › Layout to change).");
  }

  resetLayout() {
    const ws = this.workspace;
    if (!ws) return;
    ws.setDocument(this.defaultDocument(this.layoutMode), { animate: true });
    this.ensurePanels();
  }

  private panelVisible(type: string) {
    const v = this.workspace?.views({ type })[0];
    return !!v && v.placement !== "hidden";
  }

  togglePanel(type: string) {
    const ws = this.workspace;
    if (!ws) return;
    const v = ws.views({ type })[0];
    if (!v) { ws.open(type); return; }
    if (v.placement === "hidden") ws.restore(v.panelId); else ws.hide(v.panelId);
  }

  // ------------------------------------------------------------ wiring
  private wire() {
    const s = this.store, e = this.engine;
    e.handle("mtOpen", async (args) => ({ result: await this.mtVideo.meta(args.sourceId) }));
    e.handle("mtFrame", async (args) => { const r = await this.mtVideo.frame(args.sourceId, args.time); return { result: r, transfer: [(r.yuv ? r.yuv.buf : r.data!).buffer as ArrayBuffer] }; });
    e.on("progress", (p) => {
      if (p.done || p.value >= 1) this.tasks.delete(p.taskId); else this.tasks.set(p.taskId, { label: p.label, value: p.value });
      this.renderProgress();
    });
    e.on("source", (info: SourceInfo) => { s.sources.set(info.id, info); s.emit("sources"); });
    e.on("crash", (m) => toast(`Processing engine error: ${m}`, "error", 8000));
    e.on("mode", (m) => { if (m === "page") toast("This browser blocks file access for background processing in pages opened from disk, so processing runs in the page and the interface can pause during heavy filters. Opening LUCID from a web server avoids this.", "info", 10000); });
    s.on("status", (m) => { this.statusMsg.textContent = m || "Ready."; });
    s.on("dirty", () => this.updateTitle());
    s.on("project", () => { this.refreshUndo(); this.updateTitle(); this.autosave(); });
    s.on("rendered", (r) => { this.statusFile.textContent = this.fileStatus(r.frame); this.history?.setError(null); });
    s.on("renderError", (r) => { this.history?.setError(r.filterId ?? null); this.statusMsg.textContent = r.error; });
    s.on("ui", (k) => { if (k.has("chainId") || k.has("frame")) this.statusFile.textContent = this.fileStatus(s.frameOf()); });
    this.bus.on("focusSettings", () => { const v = this.workspace?.views({ type: "settings" })[0]; if (v) { if (v.placement === "hidden") this.workspace!.restore(v.panelId); this.workspace!.select(v.id); this.workspace!.focus(v.id); } });
    setInterval(async () => {
      try {
        const st = await e.call<{ cacheBytes: number; cacheLimit: number; cacheEntries: number }>("stats");
        const r = s.lastRender;
        this.statusCache.textContent = `${r ? `${r.ms.toFixed(0)} ms · ` : ""}Cache ${fmtBytes(st.cacheBytes)} / ${fmtBytes(st.cacheLimit)}`;
      } catch { /* ignore */ }
    }, 2500);
    // keyboard
    window.addEventListener("keydown", (ev) => this.onKey(ev));
    // drag & drop of files
    let depth = 0;
    const dropHint = h("div", { class: "drop-hint", hidden: true }, h("div", null, "Drop images, videos, DVR files or a project to load them"));
    document.body.appendChild(dropHint);
    window.addEventListener("dragenter", (ev) => { if (ev.dataTransfer?.types.includes("Files")) { depth++; dropHint.hidden = false; } });
    window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) dropHint.hidden = true; });
    window.addEventListener("dragover", (ev) => { if (ev.dataTransfer?.types.includes("Files") || ev.dataTransfer?.types.includes("text/x-lucid-new-filter")) ev.preventDefault(); });
    window.addEventListener("drop", (ev) => {
      depth = 0; dropHint.hidden = true;
      const dt = ev.dataTransfer;
      if (!dt) return;
      const nf = dt.getData("text/x-lucid-new-filter");
      if (nf) { ev.preventDefault(); this.actions.addFilter(nf); return; }
      if (dt.files.length) { ev.preventDefault(); void this.actions.loadFiles(Array.from(dt.files)); }
    });
    window.addEventListener("paste", (ev) => {
      const t = ev.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      const files = Array.from(ev.clipboardData?.files ?? []);
      if (files.length) { ev.preventDefault(); void this.actions.loadFiles(files); }
    });
    window.addEventListener("beforeunload", (ev) => { if (s.dirty && !s.prefs.autoSave) { ev.preventDefault(); ev.returnValue = ""; } });
    this.refreshUndo();
  }

  private renderProgress() {
    const t = [...this.tasks.values()].pop();
    this.statusProg.hidden = !t;
    if (t) {
      (this.statusProg.querySelector(".sb-prog-label") as HTMLElement).textContent = t.label;
      (this.statusProg.querySelector(".sb-bar i") as HTMLElement).style.width = `${Math.round(t.value * 100)}%`;
    }
  }

  private fileStatus(frame: number): string {
    const s = this.store, c = s.chain();
    if (!c) return "";
    const info = s.streamInfo.get(c.id);
    const sid = c.filters[0]?.params?.source;
    const src = sid ? s.sources.get(sid) : undefined;
    const name = src?.name ?? c.name;
    if (!info) return name;
    return `${name} (${info.width} x ${info.height}, ${info.frameCount} frame${info.frameCount === 1 ? "" : "s"}${info.frameCount > 1 ? `, ${info.fps.toFixed(4)} fps` : ""}), current: ${frame}`;
  }

  private refreshUndo() {
    this.undoBtn.disabled = !this.store.canUndo;
    this.redoBtn.disabled = !this.store.canRedo;
  }

  private autosave = debounce(() => { if (this.store.prefs.autoSave) void this.session.save(this.store.project, this.store.files); }, 1500);

  private async maybeRestore() {
    if (!this.store.prefs.autoSave) return;
    const saved = await this.session.load();
    if (!saved) return;
    const n = saved.project.chains.length;
    const ok = await confirmDialog("Restore Session", `Restore the previous session "${saved.project.name}" (${n} chain${n === 1 ? "" : "s"}, ${saved.files.size} media file${saved.files.size === 1 ? "" : "s"} stored in the browser)?`, "Restore");
    if (!ok) { void this.session.clear(); return; }
    migrateProject(saved.project); // a session autosaved by an earlier version keeps its decoding
    this.store.loadProject(saved.project);
    for (const [id, files] of saved.files) {
      const ref = saved.project.sources[id];
      const kind = ref?.kind === "sequence" ? "sequence" : ref?.kind === "image" ? "image" : ref?.options?.dvr ? "dvr" : "auto";
      await this.actions.loadGroup(files, kind, ref?.options ?? {}, id);
    }
    this.store.syncEngine();
    this.store.emit("project", { structural: true });
    this.store.setDirty(false);
    this.updateTitle();
    const missing = Object.keys(saved.project.sources).filter((id) => !saved.files.has(id));
    if (missing.length) toast(`${missing.length} media source(s) were too large to store: use File › Relink Media.`, "info", 8000);
  }

  // ------------------------------------------------------------ keyboard
  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    const typing = t instanceof HTMLInputElement && !["checkbox", "radio", "range", "button"].includes(t.type) || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable;
    if (document.querySelector(".dlg-overlay")) return;
    const s = this.store, a = this.actions, p = this.player, v = this.mainViewer;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod) {
      if ((k === "k" || k === "K") && !e.altKey) { e.preventDefault(); this.palette(); return; }
      if ((k === "i" || k === "I") && !e.shiftKey && !e.altKey) { e.preventDefault(); this.focusAi(); return; }
      if (k === "z" && !e.shiftKey) { if (!typing) { e.preventDefault(); s.undo(); } return; }
      if (k === "y" || (k === "Z" && e.shiftKey) || (k === "z" && e.shiftKey)) { if (!typing) { e.preventDefault(); s.redo(); } return; }
      if (k === "s" || k === "S") { e.preventDefault(); void a.saveProject(e.shiftKey); return; }
      if (k === "o" || k === "O") { e.preventDefault(); e.shiftKey ? void a.openMedia() : void this.openAny(); return; }
      if (k === "f") { e.preventDefault(); this.filtersPanel?.focusSearch(); return; }
      if ((k === "n" || k === "N") && e.altKey) { e.preventDefault(); void a.newProject(); return; }
      if ((k === "c" || k === "C") && e.shiftKey) { e.preventDefault(); void a.copyFrame(); return; }
      if ((k === "e" || k === "E") && e.shiftKey) { e.preventDefault(); void a.snapshot(); return; }
      if (k === "v" && !typing) { void a.pasteImage(); e.preventDefault(); return; }
      return;
    }
    if (typing) return;
    switch (k) {
      case " ": e.preventDefault(); p.toggle(); break;
      case "ArrowRight": e.preventDefault(); p.playing && p.pause(); s.setFrame(s.frameOf() + (e.shiftKey ? 10 : 1)); break;
      case "ArrowLeft": e.preventDefault(); p.playing && p.pause(); s.setFrame(s.frameOf() - (e.shiftKey ? 10 : 1)); break;
      case "Home": e.preventDefault(); p.first(); break;
      case "End": e.preventDefault(); p.last(); break;
      case "[": e.preventDefault(); p.slower(); break;
      case "]": e.preventDefault(); p.faster(); break;
      case "PageDown": e.preventDefault(); s.setFrame(s.frameOf() + 100); break;
      case "PageUp": e.preventDefault(); s.setFrame(s.frameOf() - 100); break;
      case "+": case "=": v?.setZoom(v.zoom * 1.25); break;
      case "-": case "_": v?.setZoom(v.zoom / 1.25); break;
      case "0": v?.fit(); break;
      case "1": v?.setZoom(1); break;
      case "2": v?.setZoom(2); break;
      case "4": v?.setZoom(4); break;
      case "i": case "I": p.setIn(s.frameOf()); break;
      case "o": case "O": p.setOut(s.frameOf()); break;
      case "b": case "B": void a.addBookmark(); break;
      case "Delete": { const f = s.selectedFilter(); if (f) void a.removeFilter(f.id); break; }
      case "Tab": e.preventDefault(); s.setUi({ showInput: !s.ui.showInput }); break;
      case "Escape": if (s.ui.polygon.length || s.ui.ruler || s.ui.selection || s.ui.profile || s.ui.crosshair) s.setUi({ polygon: [], ruler: null, selection: null, profile: null, crosshair: null }); else if (s.ui.showInput) s.setUi({ showInput: false }); break;
      case "F1": e.preventDefault(); this.quickStart(); break;
      case "F9": e.preventDefault(); void a.generateReport(); break;
      case "p": case "P": s.setUi({ tool: "pointer" }); break;
      case "z": case "Z": s.setUi({ tool: "zoom" }); break;
      case "h": case "H": s.setUi({ tool: "histogram" }); break;
      case "s": case "S": s.setUi({ tool: "selector" }); break;
      case "r": case "R": s.setUi({ tool: "ruler" }); break;
      case "g": case "G": s.setUi({ tool: "polygon" }); break;
      case "c": case "C": s.setUi({ tool: "crosshair" }); break;
    }
  }

  // ------------------------------------------------------------ help dialogs
  private quickStart() {
    const touch = isTouchUi();
    void alertDialog("Quick Start", h("div", { class: "help-box" },
      h("ol", null,
        h("li", null, h("b", null, "Load"), touch ? " — use File › Load Image or Video (or Open Image or Video… on the Viewer) to pick an image, a video or a DVR file. Each file becomes a " : " — drag an image, a video, a DVR file or a folder of images on the Viewer (or File › Load Image or Video). Each file becomes a ", h("i", null, "chain"), "."),
        h("li", null, h("b", null, "Process"), touch ? " — tap a filter in the Filters panel, then tap its Add button (or double-tap the filter). It is added after the filter selected in History." : " — double-click a filter in the Filters panel (or type in Quick Search and press Enter). It is added after the filter selected in History."),
        h("li", null, h("b", null, "Configure"), " — adjust the parameters in Filter Settings. Regions, points and lines are drawn directly on the Viewer."),
        h("li", null, h("b", null, "Review"), " — click any step in History to see its output; use Show Input, the Player and the Tools (histogram, pixel inspector, frame analysis)."),
        h("li", null, h("b", null, "Export"), " — Write Video / Images, Save Snapshot, and Generate Report to document the evidence and every processing step. Exports are uncompressed by default (AVI, TIFF/PNG 8 or 16-bit, TIFF 32-bit float) and verified frame by frame after writing; lossy formats appear only when Settings › Lossless exports only is off. Chrome and Edge on computers write straight to a file you choose; other browsers write large exports to disk in the browser's storage and download them from there."),
        h("li", null, h("b", null, "Save"), " — save the project (Ctrl+S): it stores the chains and parameters and references the evidence by name, size and hash.")),
      touch ? h("p", null, h("b", null, "Touch screens: "), "tap = click · double-tap = double-click · long-press = right-click menu · pinch = zoom · two-finger drag = pan · double-tap the image = zoom in / back to fit. With the Pointer tool a one-finger drag also pans. View › Layout switches between the compact and the desktop layout.") : null,
      h("p", { class: "muted" }, "All the processing runs locally in your browser: no media is uploaded anywhere."),
      h("p", null, h("button", { class: "btn primary", onclick: () => { document.querySelector<HTMLElement>(".dlg-x")?.click(); void this.actions.loadSampleProject(); } }, "Load the Sample Case"))));
  }

  private shortcutsHelp() {
    const rows: [string, string][] = [["Space", "Play / Pause"], ["[ / ]", "Slower / faster playback (presets 0.01× … 16×)"], ["← / →", "Previous / next frame (Shift: 10 frames)"], ["Home / End", "First / last frame"], ["PgUp / PgDn", "Back / forward 100 frames"], ["I / O", "Set In / Out point"], ["B", "Add bookmark"], ["Tab", "Show input / output of the selected filter"], ["+ / − / 0 / 1 / 2 / 4", "Zoom in / out / fit / 100% / 200% / 400%"], ["Mouse wheel", "Zoom around the cursor"], ["Middle drag / Space+drag", "Pan"], ["P Z H S R G C", "Tools: Pointer, Zoom, Histogram, Selector, Ruler, Polygon, Crosshair"], ["Del", "Remove the selected filter"], ["Esc", "Clear measurements / selection"], ["Ctrl+Z / Ctrl+Y", "Undo / Redo"], ["Ctrl+S / Ctrl+Shift+S", "Save project / Save as"], ["Ctrl+O / Ctrl+Shift+O", "Open project or media / Load media"], ["Ctrl+F", "Quick search filter"], ["Ctrl+V", "Paste image"], ["Ctrl+Shift+C", "Copy frame to clipboard"], ["Ctrl+Shift+E", "Save snapshot"], ["F9", "Generate report"], ["F1", "Quick start"]];
    void alertDialog("Keyboard Shortcuts", h("table", { class: "info-table" }, h("tbody", null, ...rows.map(([k2, v]) => h("tr", null, h("td", { class: "mono" }, k2), h("td", null, v))))));
  }

  private filterReference() {
    const box = h("div", { class: "scroll-box ref-box" });
    for (const c of CATEGORIES) {
      box.appendChild(h("h3", null, c.name));
      for (const f of FILTER_LIST.filter((x) => x.category === c.name)) box.appendChild(h("div", { class: "ref-item" }, h("b", null, f.name), " — ", f.description, f.reference ? h("div", { class: "muted small" }, f.reference) : null));
    }
    dialog({ title: `Filter Reference (${FILTER_LIST.length} filters)`, body: box, width: 760 });
  }

  private about() {
    void alertDialog(`About ${BRAND.name}`, h("div", { class: "about" },
      h("div", { class: "about-logo", html: logoSvg(BRAND.letters, 72) }),
      h("div", null,
        h("h2", null, BRAND.fullName),
        h("div", null, `${BRAND.tagline} — version ${BRAND.version} (build ${BRAND.build})`),
        h("p", { class: "muted" }, `${FILTER_LIST.length} filters in ${CATEGORIES.length} categories. Runs entirely in the browser: processing engine in a Web Worker, frame-accurate decoding with WebCodecs, 32-bit float pipeline.`),
        h("p", { class: "small" }, "Built with Trellis (dockable workspace, © Dan Fessler), Mediabunny (media toolkit, MPL-2.0) and UTIF (TIFF decoder, MIT). Icons: Codicons © Microsoft Corporation, CC BY 4.0."))));
  }
}
