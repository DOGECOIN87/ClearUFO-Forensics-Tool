// Filter Settings: parameter form generated from the filter schema.
import type { ViewHandle } from "@danfessler/trellis";
import { FILTERS, defaultParams, isOverlayParam, type FilterDef, type ParamDef } from "../shared/filters";
import { psfForFilter } from "../shared/psf";
import type { FilterInstance, Pt } from "../shared/types";
import type { AppCtx } from "../app/context";
import { checkBox, colorSwatch, iconBtn, selectBox, slider, spinBox } from "../ui/controls";
import { clear, fmtBytes, fmtTime, h } from "../ui/dom";
import { capturePointer, isTouchUi, touchText } from "../ui/touch";
import { I } from "../ui/icons";
import { alertDialog } from "../ui/dialog";
import { isLossy } from "../shared/formats";

interface Ctl { def: ParamDef; row: HTMLElement; set?: (v: any) => void }

export class FilterSettingsPanel {
  el: HTMLElement;
  private toolbar: HTMLElement;
  private tabsEl: HTMLElement;
  private body: HTMLElement;
  private hint: HTMLElement;
  private buttons: HTMLElement;
  private empty: HTMLElement;
  private enableChk!: HTMLInputElement;
  private showInputBtn!: HTMLButtonElement;
  private ctls = new Map<string, Ctl>();
  private filterId: string | null = null;
  private tab = "";
  private modified = false;
  private psfCanvas: HTMLCanvasElement | null = null;
  private disposers: (() => void)[] = [];

  constructor(private ctx: AppCtx, private view: ViewHandle) {
    this.toolbar = h("div", { class: "fs-toolbar" });
    this.tabsEl = h("div", { class: "fs-tabs" });
    this.body = h("div", { class: "fs-body" });
    this.hint = h("div", { class: "fs-hint" });
    this.buttons = h("div", { class: "fs-buttons" });
    this.empty = h("div", { class: "panel-empty" }, h("div", { class: "panel-empty-title" }, "The settings of the current filter"), h("div", null, isTouchUi() ? "Add a filter from the Filters panel: tap it and press Add, or double-tap it" : "Add a filter by clicking on the Filters panel on the left"));
    this.el = h("div", { class: "panel fs-panel" }, this.toolbar, this.tabsEl, h("div", { class: "fs-scroll" }, this.body, this.hint), this.buttons, this.empty);
    this.buildToolbar();
    const s = ctx.store;
    this.disposers.push(
      s.on("project", () => this.sync()),
      s.on("ui", (k) => { if (k.has("selected") || k.has("chainId")) this.sync(true); if (k.has("showInput")) this.updateTitle(); if (k.has("activeOverlay")) this.markActiveOverlay(); }),
      s.on("rendered", () => { if (this.modified) { this.modified = false; this.updateTitle(); } }),
      s.on("renderError", () => { if (this.modified) { this.modified = false; this.updateTitle(); } }),
      s.on("sources", () => this.sync(true)),
      s.on("prefs", () => this.sync(true)), // "Lossless exports only" changes the writer formats on offer
      ctx.bus.on("layout", () => this.updateTitle()),
    );
    this.sync(true);
  }

  dispose() { this.disposers.forEach((d) => d()); }

  private get filter(): FilterInstance | undefined { return this.ctx.store.selectedFilter(); }

  private buildToolbar() {
    const s = this.ctx.store, a = this.ctx.actions;
    this.enableChk = h("input", { type: "checkbox", class: "chk", title: "Enable/disable the filter" }) as HTMLInputElement;
    this.enableChk.addEventListener("change", () => { const f = this.filter; if (f) a.toggleFilter(f.id, this.enableChk.checked); });
    this.showInputBtn = iconBtn(I.swap, "Show input / output", () => s.setUi({ showInput: !s.ui.showInput }), "ibtn fs-ib") as HTMLButtonElement;
    this.toolbar.append(
      h("label", { class: "fs-enable" }, this.enableChk),
      this.showInputBtn,
      iconBtn(I.help, "Filter help", () => this.showHelp(), "ibtn fs-ib"),
      h("span", { class: "flex1" }),
      iconBtn(I.resetList, "Reset parameters to default", () => { const f = this.filter; if (f) a.resetFilter(f.id); }, "ibtn fs-ib"),
      iconBtn(I.arrowLeft, "Previous filter", () => this.step(-1), "ibtn fs-ib"),
      iconBtn(I.arrowRight, "Next filter", () => this.step(1), "ibtn fs-ib"),
    );
    const showBtn = h("button", { class: "fs-btn" }, "Show Input");
    showBtn.addEventListener("click", () => s.setUi({ showInput: !s.ui.showInput }));
    const apply = h("button", { class: "fs-btn" }, "Apply");
    apply.addEventListener("click", () => {
      const f = this.filter;
      if (f && FILTERS[f.type]?.overlayOn === "input") s.setUi({ showInput: false });
      this.ctx.viewer()?.requestRender();
      this.ctx.store.status("Filter settings applied.");
    });
    this.buttons.append(showBtn, apply);
    s.on("ui", (k) => { if (k.has("showInput")) showBtn.textContent = s.ui.showInput ? "Show Output" : "Show Input"; });
  }

  private step(dir: number) {
    const s = this.ctx.store, c = s.chain(), f = this.filter;
    if (!c || !f) return;
    const i = c.filters.findIndex((x) => x.id === f.id) + dir;
    if (i >= 0 && i < c.filters.length) s.selectFilter(c.filters[i].id);
  }

  private showHelp() {
    const f = this.filter;
    if (!f) return;
    const def = FILTERS[f.type];
    void alertDialog(def.name, h("div", { class: "help-box" },
      h("p", null, h("b", null, "Category: "), def.category),
      h("p", null, def.description),
      def.hint ? h("p", { class: "muted" }, touchText(def.hint)) : null,
      ...def.params.filter((p) => p.help).map((p) => h("p", { class: "small" }, h("b", null, `${p.label}: `), touchText(p.help!))),
      def.reference ? h("p", { class: "muted small" }, h("b", null, "Reference: "), def.reference) : null,
      def.slow ? h("p", { class: "warn" }, "This filter is computationally intensive.") : null));
  }

  private updateTitle() {
    const f = this.filter, s = this.ctx.store;
    const def = f ? FILTERS[f.type] : null;
    const compact = !!document.documentElement.dataset.layout && document.documentElement.dataset.layout !== "desktop";
    this.view.setTitle(compact ? "Settings" : def ? `Filter Settings - ${def.name} [${s.ui.showInput ? "input" : "output"}] [${this.modified ? "modified" : "updated"}]` : "Filter Settings");
    this.showInputBtn.classList.toggle("on", s.ui.showInput);
  }

  private markActiveOverlay() {
    const key = this.ctx.store.ui.activeOverlay;
    this.body.querySelectorAll<HTMLElement>("[data-overlay]").forEach((el) => el.classList.toggle("active", el.dataset.overlay === key));
  }

  /** Rebuild on structural change, otherwise update control values in place. */
  sync(force = false) {
    const f = this.filter;
    const has = !!f;
    this.empty.hidden = has;
    for (const el of [this.toolbar, this.tabsEl, this.buttons, this.body.parentElement!]) el.hidden = !has;
    if (!f) { this.filterId = null; this.updateTitle(); return; }
    const def = FILTERS[f.type];
    if (!def) return;
    if (force || f.id !== this.filterId) {
      if (f.id !== this.filterId) this.tab = (def.tabs ?? ["Settings"])[0];
      this.filterId = f.id;
      this.build(f, def);
    } else {
      for (const [k, c] of this.ctls) {
        c.set?.(f.params[k]);
        if (c.def.show) c.row.hidden = !c.def.show(f.params) || (c.def.tab ?? (def.tabs ?? ["Settings"])[0]) !== this.tab;
      }
      this.drawPsf(f);
    }
    this.enableChk.checked = f.enabled;
    this.enableChk.disabled = def.kind === "loader" || this.ctx.store.chain()?.filters[0]?.id === f.id;
    this.updateTitle();
  }

  private build(f: FilterInstance, def: FilterDef) {
    clear(this.body); clear(this.tabsEl);
    this.ctls.clear();
    this.psfCanvas = null;
    const tabs = def.tabs ?? ["Settings"];
    for (const t of tabs) {
      const tab = h("div", { class: `fs-tab${t === this.tab ? " active" : ""}` }, t);
      tab.addEventListener("click", () => { this.tab = t; this.build(f, def); });
      this.tabsEl.appendChild(tab);
    }
    for (const pd of def.params) {
      const row = this.control(f, def, pd);
      if (!row) continue;
      const tab = pd.tab ?? tabs[0];
      row.hidden = tab !== this.tab || (pd.show ? !pd.show(f.params) : false);
      this.body.appendChild(row);
    }
    if (!def.params.length) this.body.appendChild(h("div", { class: "prm-info" }, "This filter has no parameters."));
    this.hint.textContent = def.hint ? touchText(def.hint) : "";
    this.hint.hidden = !def.hint;
    this.drawPsf(f);
    this.markActiveOverlay();
  }

  private set(f: FilterInstance, key: string, v: any, final = true) {
    this.modified = true;
    this.updateTitle();
    this.ctx.actions.setParam(f.id, key, v, final ? undefined : `p:${f.id}:${key}`);
  }

  private control(f: FilterInstance, def: FilterDef, pd: ParamDef): HTMLElement | null {
    const a = this.ctx.actions, s = this.ctx.store;
    const v = f.params[pd.key];
    const reg = (row: HTMLElement, set?: (v: any) => void) => { this.ctls.set(pd.key, { def: pd, row, set }); return row; };
    const labelEl = h("span", { class: "prm-label", title: pd.help ? touchText(pd.help) : null }, `${pd.label}:`);
    switch (pd.type) {
      case "number": case "int": {
        const dec = pd.type === "int" ? 0 : pd.decimals ?? 2;
        let sl: ReturnType<typeof slider> | null = null;
        const sp = spinBox({ value: v ?? pd.default, min: pd.min, max: pd.max, decimals: dec, step: pd.step, width: 96, onChange: (nv) => { sl?.set(nv); this.set(f, pd.key, nv); } });
        const rows: HTMLElement[] = [h("div", { class: "prm-row" }, labelEl, sp.el)];
        if (pd.slider !== false) {
          sl = slider({ min: pd.min, max: pd.max, value: v ?? pd.default, log: pd.log, step: pd.type === "int" ? 1 : undefined, decimals: dec > 2 ? 4 : dec,
            onInput: (nv) => { sp.set(nv); this.set(f, pd.key, pd.type === "int" ? Math.round(nv) : nv, false); },
            onChange: (nv) => this.set(f, pd.key, pd.type === "int" ? Math.round(nv) : nv, false) });
          rows.push(sl.el);
        }
        return reg(h("div", { class: "prm" }, ...rows), (nv) => { if (nv === undefined || nv === null) return; sp.set(nv); if (document.activeElement !== sl?.range) sl?.set(nv); });
      }
      case "select": {
        // Writer formats: lossy ones are hidden while "Lossless exports only" is on (an older project
        // may still use one: it stays visible, with a warning, until a lossless format is chosen).
        const cur = v ?? pd.default;
        const writerFormat = def.kind === "writer" && pd.key === "format" && s.prefs.losslessOnly;
        const opts = writerFormat ? pd.options.filter(([o]) => !isLossy(o) || o === cur) : pd.options;
        const sel = selectBox(opts, cur, (nv) => { this.set(f, pd.key, nv); this.sync(true); });
        const row = h("div", { class: "prm prm-row" }, labelEl, sel);
        if (writerFormat && isLossy(cur)) {
          return reg(h("div", { class: "prm" }, row, h("div", { class: "prm-info warn" }, "This format is lossy, and lossy formats are disabled (Settings › Lossless exports only). Choose an uncompressed format to write.")), (nv) => { if (sel.value !== nv) sel.value = nv; });
        }
        return reg(row, (nv) => { if (sel.value !== nv) sel.value = nv; });
      }
      case "bool": {
        const cb = checkBox(pd.label, !!v, (nv) => { this.set(f, pd.key, nv); this.sync(true); });
        return reg(h("div", { class: "prm" }, cb.el), (nv) => cb.set(!!nv));
      }
      case "color": {
        const sw = colorSwatch(v ?? pd.default, (nv) => this.set(f, pd.key, nv, false));
        return reg(h("div", { class: "prm prm-row" }, labelEl, sw.el), (nv) => sw.set(nv));
      }
      case "text": {
        const inp = (pd.multiline ? h("textarea", { class: "inp", rows: "3" }) : h("input", { class: "inp", type: "text" })) as HTMLInputElement;
        inp.value = v ?? "";
        inp.addEventListener("input", () => this.set(f, pd.key, inp.value, false));
        return reg(h("div", { class: "prm prm-col" }, labelEl, inp), (nv) => { if (document.activeElement !== inp) inp.value = nv ?? ""; });
      }
      case "frame": {
        const sp = spinBox({ value: v ?? pd.default, min: pd.allowLast ? -1 : 0, max: 1e7, width: 96, onChange: (nv) => this.set(f, pd.key, nv) });
        const cur = h("button", { class: "btn sm", title: "Use the current frame" }, "Current");
        cur.addEventListener("click", () => { const fr = s.frameOf(); sp.set(fr); this.set(f, pd.key, fr); });
        const last = pd.allowLast ? h("button", { class: "btn sm", title: "Last frame" }, "Last") : null;
        last?.addEventListener("click", () => { sp.set(-1); this.set(f, pd.key, -1); });
        return reg(h("div", { class: "prm prm-row" }, labelEl, h("div", { class: "prm-inline" }, sp.el, cur, last)), (nv) => sp.set(nv));
      }
      case "chain": case "chains": {
        const others = s.project.chains.filter((c) => c.id !== s.ui.chainId);
        if (pd.type === "chain") {
          const sel = selectBox([["", others.length ? "— select —" : "— no other chains —"], ...others.map((c) => [c.id, c.name] as [string, string])], v ?? "", (nv) => this.set(f, pd.key, nv));
          return reg(h("div", { class: "prm prm-row" }, labelEl, sel), (nv) => { if (sel.value !== (nv ?? "")) sel.value = nv ?? ""; });
        }
        const list = h("div", { class: "prm-list" });
        const cur: string[] = [...(v ?? [])];
        if (!others.length) list.appendChild(h("div", { class: "muted small" }, "Create or load other chains to combine them."));
        for (const c of others) {
          const cb = checkBox(c.name, cur.includes(c.id), (on) => {
            const next = on ? [...new Set([...((f.params[pd.key] as string[]) ?? []), c.id])] : ((f.params[pd.key] as string[]) ?? []).filter((x) => x !== c.id);
            this.set(f, pd.key, next);
          });
          list.appendChild(cb.el);
        }
        return reg(h("div", { class: "prm prm-col" }, labelEl, list));
      }
      case "rect": case "point": case "points": case "line": return reg(this.overlayControl(f, def, pd), (nv) => this.updateOverlayText(pd, nv));
      case "curve": return reg(this.curveEditor(f, pd));
      case "source": case "image": {
        const info = v ? s.sources.get(v) : undefined;
        const ref = v ? s.project.sources[v] : undefined;
        const path = h("input", { class: "inp", type: "text", readonly: true, value: info ? `${info.name}${info.fileCount > 1 ? ` (+${info.fileCount - 1} files)` : ""}` : ref ? `${ref.name}  [not loaded — Browse to relink]` : "" }) as HTMLInputElement;
        const viewB = h("button", { class: "btn sm" }, "View");
        viewB.addEventListener("click", () => { if (info) a.showSourceInfo(info.id); });
        const browse = h("button", { class: "btn sm" }, "Browse");
        browse.addEventListener("click", () => void (pd.type === "image" ? a.pickAuxImage(f.id, pd.key) : a.browseSource(f.id)));
        const note = info?.browserConversion ? h("div", { class: "prm-info" }, "This browser converts the video to RGB itself, so the Color Matrix and Range settings have no effect (details: View, Color Conversion).") : null;
        return reg(h("div", { class: "prm" }, h("div", { class: "prm-row" }, h("span", { class: "prm-label" }, pd.type === "image" ? `${pd.label}:` : "File:"), h("div", { class: "prm-inline" }, viewB, browse)), path, note));
      }
      case "action": {
        const b = h("button", { class: "btn wide" }, pd.label);
        b.addEventListener("click", () => void a.filterAction(pd.action, f.id));
        return reg(h("div", { class: "prm" }, b));
      }
      case "psf": {
        this.psfCanvas = h("canvas", { class: "psf-canvas", width: "160", height: "160" });
        return reg(h("div", { class: "prm prm-col" }, h("span", { class: "prm-label" }, `${pd.label}:`), this.psfCanvas));
      }
      case "fileinfo": {
        const sid = f.params.source;
        const info = sid ? s.sources.get(sid) : undefined;
        if (!info) return reg(h("div", { class: "prm muted" }, "No file loaded."));
        return reg(h("div", { class: "prm" }, this.ctx.actions.sourceInfoTable(info)));
      }
      case "info": return reg(h("div", { class: "prm prm-info" }, pd.label));
    }
    return null;
  }

  // ------------------------------------------------------------ overlay parameter rows
  private overlayText(pd: ParamDef, v: any): string {
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return "not set — draw on the Viewer";
    const p = (q: Pt) => `(${q.x.toFixed(1)}, ${q.y.toFixed(1)})`;
    switch (pd.type) {
      case "rect": return `x ${Math.round(v.x)}, y ${Math.round(v.y)}, w ${Math.round(v.w)}, h ${Math.round(v.h)}`;
      case "point": return p(v);
      case "line": return `${p(v[0])} → ${p(v[1])}  [${Math.hypot(v[1].x - v[0].x, v[1].y - v[0].y).toFixed(1)} px]`;
      case "points": return `${v.length} point${v.length === 1 ? "" : "s"}: ${(v as Pt[]).slice(0, 6).map(p).join(" ")}${v.length > 6 ? " …" : ""}`;
      default: return String(v);
    }
  }

  private updateOverlayText(pd: ParamDef, v: any) {
    const el = this.body.querySelector<HTMLElement>(`[data-overlay="${pd.key}"] .ov-value`);
    if (el) el.textContent = this.overlayText(pd, v);
  }

  private overlayControl(f: FilterInstance, def: FilterDef, pd: ParamDef): HTMLElement {
    const s = this.ctx.store;
    const value = h("div", { class: "ov-value" }, this.overlayText(pd, f.params[pd.key]));
    const draw = h("button", { class: "btn sm" }, pd.type === "point" ? "Pick" : "Draw");
    draw.addEventListener("click", () => {
      s.setUi({ activeOverlay: pd.key, ...(def.overlayOn === "input" ? { showInput: true } : {}) });
      this.ctx.store.status(`Draw "${pd.label}" on the Viewer.`);
    });
    const clearB = h("button", { class: "btn sm" }, "Clear");
    clearB.addEventListener("click", () => this.set(f, pd.key, pd.type === "points" ? [] : null));
    const extra: HTMLElement[] = [];
    if (pd.type === "rect") {
      const useSel = h("button", { class: "btn sm", title: "Use the Selector tool region" }, "Selection");
      useSel.addEventListener("click", () => { if (s.ui.selection) this.set(f, pd.key, { ...s.ui.selection }); else this.ctx.store.status("Draw a region with the Selector tool first."); });
      const full = h("button", { class: "btn sm" }, "Full");
      full.addEventListener("click", () => { const r = s.lastRender; if (r) this.set(f, pd.key, { x: 0, y: 0, w: r.width, h: r.height }); });
      extra.push(useSel, full);
    }
    if (pd.type === "points") {
      const undo = h("button", { class: "btn sm" }, "Undo Point");
      undo.addEventListener("click", () => this.set(f, pd.key, ((f.params[pd.key] as Pt[]) ?? []).slice(0, -1)));
      extra.push(undo);
    }
    return h("div", { class: "prm ov-row", dataset: { overlay: pd.key } },
      h("div", { class: "prm-row" }, h("span", { class: "prm-label" }, h("i", { class: "ov-dot" }), `${pd.label}:`), h("div", { class: "ov-btns" }, draw, ...extra, clearB)),
      value);
  }

  // ------------------------------------------------------------ curve editor
  private curveEditor(f: FilterInstance, pd: ParamDef): HTMLElement {
    const S = 220;
    const cv = h("canvas", { class: "curve-canvas", width: String(S * 2), height: String(S * 2), style: { width: `${S}px`, height: `${S}px` } });
    const pts = (): Pt[] => ((this.filter?.params[pd.key] as Pt[]) ?? [{ x: 0, y: 0 }, { x: 255, y: 255 }]).map((p) => ({ ...p }));
    const toPx = (p: Pt) => ({ x: (p.x / 255) * S, y: S - (p.y / 255) * S });
    const fromPx = (x: number, y: number) => ({ x: Math.max(0, Math.min(255, (x / S) * 255)), y: Math.max(0, Math.min(255, ((S - y) / S) * 255)) });
    const redraw = () => {
      const c = cv.getContext("2d")!;
      c.setTransform(2, 0, 0, 2, 0, 0);
      c.fillStyle = "#11141c"; c.fillRect(0, 0, S, S);
      const hist = this.ctx.store.lastRender?.hist;
      if (hist) {
        let mx = 1;
        for (let i = 0; i < 256; i++) mx = Math.max(mx, hist[768 + i]);
        c.fillStyle = "rgba(160,170,190,0.25)";
        for (let i = 0; i < 256; i++) { const hh = (Math.sqrt(hist[768 + i]) / Math.sqrt(mx)) * S; c.fillRect((i / 256) * S, S - hh, S / 256 + 0.5, hh); }
      }
      c.strokeStyle = "rgba(255,255,255,0.1)"; c.lineWidth = 1;
      for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo((i * S) / 4, 0); c.lineTo((i * S) / 4, S); c.moveTo(0, (i * S) / 4); c.lineTo(S, (i * S) / 4); c.stroke(); }
      const P = pts().sort((a, b) => a.x - b.x);
      const fn = monotone(P);
      c.strokeStyle = "#e8e8e8"; c.lineWidth = 1.6; c.beginPath();
      for (let x = 0; x <= S; x++) { const y = fn((x / S) * 255); const q = toPx({ x: (x / S) * 255, y: Math.max(0, Math.min(255, y)) }); x ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y); }
      c.stroke();
      for (const p of P) { const q = toPx(p); c.fillStyle = "#2f80ed"; c.fillRect(q.x - 4, q.y - 4, 8, 8); c.strokeStyle = "#fff"; c.strokeRect(q.x - 4, q.y - 4, 8, 8); }
    };
    let dragIdx = -1;
    let list: Pt[] = [];
    cv.addEventListener("pointerdown", (e) => {
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      list = pts();
      dragIdx = list.findIndex((p) => { const q = toPx(p); return Math.abs(q.x - x) < 7 && Math.abs(q.y - y) < 7; });
      if (dragIdx < 0) { list.push(fromPx(x, y)); dragIdx = list.length - 1; this.set(f, pd.key, list, false); }
      capturePointer(cv, e.pointerId);
    });
    cv.addEventListener("pointermove", (e) => {
      if (dragIdx < 0) return;
      const r = cv.getBoundingClientRect();
      list[dragIdx] = fromPx(e.clientX - r.left, e.clientY - r.top);
      this.set(f, pd.key, list.map((p) => ({ ...p })), false);
      redraw();
    });
    cv.addEventListener("pointerup", () => { dragIdx = -1; });
    cv.addEventListener("dblclick", (e) => {
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const l = pts();
      const i = l.findIndex((p) => { const q = toPx(p); return Math.abs(q.x - x) < 7 && Math.abs(q.y - y) < 7; });
      if (i >= 0 && l.length > 2) { l.splice(i, 1); this.set(f, pd.key, l); }
    });
    const reset = h("button", { class: "btn sm" }, "Reset Curve");
    reset.addEventListener("click", () => this.set(f, pd.key, defaultParams(FILTERS[f.type]).curve));
    const row = h("div", { class: "prm prm-col" }, h("div", { class: "prm-row" }, h("span", { class: "prm-label" }, `${pd.label}:`), reset), cv);
    this.ctls.set(pd.key, { def: pd, row, set: () => redraw() });
    redraw();
    const off = this.ctx.store.on("rendered", () => redraw());
    this.disposers.push(off);
    return row;
  }

  private drawPsf(f: FilterInstance) {
    const cv = this.psfCanvas;
    if (!cv) return;
    const c = cv.getContext("2d")!;
    const psf = psfForFilter(f.type, f.params);
    c.fillStyle = "#000"; c.fillRect(0, 0, cv.width, cv.height);
    if (!psf) { c.fillStyle = "#888"; c.font = "11px sans-serif"; c.fillText("Add points on the Viewer", 14, cv.height / 2); return; }
    let mx = 0;
    for (const v of psf.d) mx = Math.max(mx, v);
    const k = Math.min(cv.width / psf.w, cv.height / psf.h);
    const ox = (cv.width - psf.w * k) / 2, oy = (cv.height - psf.h * k) / 2;
    for (let y = 0; y < psf.h; y++) for (let x = 0; x < psf.w; x++) {
      const v = Math.round((psf.d[y * psf.w + x] / (mx || 1)) * 255);
      if (!v) continue;
      c.fillStyle = `rgb(${v},${v},${v})`;
      c.fillRect(ox + x * k, oy + y * k, Math.ceil(k), Math.ceil(k));
    }
  }
}

/** Same monotone interpolation as the engine (Fritsch–Carlson). */
function monotone(P: Pt[]): (v: number) => number {
  const pts = P.filter((p, i, a) => i === 0 || p.x > a[i - 1].x + 1e-6);
  const n = pts.length;
  if (n < 2) return (v) => v;
  const dx: number[] = [], m: number[] = [], t = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { dx.push(pts[i + 1].x - pts[i].x); m.push((pts[i + 1].y - pts[i].y) / dx[i]); }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(m[i]) < 1e-12) { t[i] = t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  return (v) => {
    if (v <= pts[0].x) return pts[0].y;
    if (v >= pts[n - 1].x) return pts[n - 1].y;
    let i = 0;
    while (i < n - 2 && v > pts[i + 1].x) i++;
    const hh = dx[i], s = (v - pts[i].x) / hh, s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * pts[i].y + (s3 - 2 * s2 + s) * hh * t[i] + (-2 * s3 + 3 * s2) * pts[i + 1].y + (s3 - s2) * hh * t[i + 1];
  };
}

export { fmtBytes, fmtTime, isOverlayParam };
