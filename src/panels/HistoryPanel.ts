// History: tree of chains and their filters.
import { BRAND } from "../brand";
import { FILTERS, formatParam } from "../shared/filters";
import type { AppCtx } from "../app/context";
import { clear, h, svg } from "../ui/dom";
import { I, logoSvg } from "../ui/icons";
import { showContextMenu, type MenuDef } from "../ui/menu";
import { isCoarsePointer, isTouchUi, onContextMenu, onDoubleActivate } from "../ui/touch";

export class HistoryPanel {
  el: HTMLElement;
  private tree: HTMLElement;
  private empty: HTMLElement;
  private collapsed = new Set<string>();
  private dragId: string | null = null;

  constructor(private ctx: AppCtx) {
    this.tree = h("div", { class: "tree", tabindex: "0" });
    this.empty = h("div", { class: "panel-empty" });
    this.el = h("div", { class: "panel history" }, this.tree, this.empty, h("div", { class: "history-logo", html: logoSvg(BRAND.letters, 54) + `<div class="history-logo-text">${BRAND.name}<br><span>FORENSIC</span></div>` }));
    ctx.store.on("project", () => this.render());
    ctx.store.on("ui", (k) => { if (k.has("chainId") || k.has("selected")) this.render(); });
    ctx.store.on("renderError", () => this.render());
    ctx.store.on("rendered", () => { if (this.tree.querySelector(".tree-row.error")) this.render(); });
    this.tree.addEventListener("keydown", (e) => this.onKey(e));
    this.render();
  }

  private errorFilter: string | null = null;

  render() {
    const s = this.ctx.store;
    const chains = s.project.chains;
    clear(this.tree);
    this.empty.hidden = chains.length > 0;
    if (!this.empty.hidden) this.renderEmpty();
    for (const c of chains) {
      const open = !this.collapsed.has(c.id);
      const caret = h("span", { class: "tree-caret" }, svg(open ? I.caretDown : I.caretRight));
      caret.addEventListener("click", (e) => { e.stopPropagation(); open ? this.collapsed.add(c.id) : this.collapsed.delete(c.id); this.render(); });
      const row = h("div", { class: `tree-row tree-chain${c.id === s.ui.chainId ? " current" : ""}` }, caret, h("span", { class: "tree-link" }, svg(I.link)), h("span", { class: "tree-name" }, c.name));
      row.addEventListener("click", () => s.setUi({ chainId: c.id }));
      onDoubleActivate(row, `chain:${c.id}`, () => void this.ctx.actions.renameChain(c.id));
      onContextMenu(row, (x, y) => showContextMenu(x, y, this.chainMenu(c.id)));
      this.tree.appendChild(row);
      if (!open) continue;
      const sel = s.ui.chainId === c.id ? s.selectedFilter(c.id)?.id : s.ui.selected[c.id] ?? c.filters[c.filters.length - 1]?.id;
      const last = s.lastRender;
      c.filters.forEach((f, i) => {
        const def = FILTERS[f.type];
        const isLoader = def?.kind === "loader" || i === 0;
        const box = h("input", { type: "checkbox", class: "chk tree-chk", title: isLoader ? "The source cannot be disabled" : "Enable / disable" }) as HTMLInputElement;
        box.checked = f.enabled;
        box.disabled = isLoader;
        box.addEventListener("click", (e) => e.stopPropagation());
        box.addEventListener("change", () => this.ctx.actions.toggleFilter(f.id, box.checked));
        const icon = isLoader ? h("span", { class: "tree-loader" }, svg(I.loader)) : box;
        const tip = def ? `${def.name}\n${def.params.filter((p) => !["action", "psf", "info", "fileinfo", "source"].includes(p.type)).slice(0, 10).map((p) => `${p.label}: ${formatParam(p, f.params[p.key], (id) => s.chain(id)?.name ?? "?")}`).join("\n")}` : f.type;
        const err = this.errorFilter === f.id;
        const r = h("div", {
          class: `tree-row tree-filter${f.id === sel && c.id === s.ui.chainId ? " selected" : ""}${!f.enabled ? " disabled" : ""}${err ? " error" : ""}${i === c.filters.length - 1 ? " last" : ""}`,
          title: tip, draggable: isLoader || isCoarsePointer() ? "false" : "true", dataset: { id: f.id, chain: c.id },
        }, h("span", { class: "tree-guide" }), icon, h("span", { class: "tree-name" }, def?.name ?? f.type), def?.slow ? h("span", { class: "tree-tag" }, "slow") : null);
        r.addEventListener("click", () => { if (s.ui.chainId !== c.id) s.setUi({ chainId: c.id }); s.selectFilter(f.id, c.id); this.tree.focus({ preventScroll: true }); });
        onDoubleActivate(r, `filter:${f.id}`, () => { if (s.ui.chainId !== c.id) s.setUi({ chainId: c.id }); s.selectFilter(f.id, c.id); this.ctx.bus.emit("focusSettings"); });
        onContextMenu(r, (x, y) => { if (s.ui.chainId !== c.id) s.setUi({ chainId: c.id }); s.selectFilter(f.id, c.id); showContextMenu(x, y, this.filterMenu(c.id, f.id, i)); });
        r.addEventListener("dragstart", (e) => { this.dragId = f.id; e.dataTransfer!.effectAllowed = "move"; e.dataTransfer!.setData("text/x-lucid-filter", f.id); });
        r.addEventListener("dragover", (e) => { if (!this.dragId || this.dragId === f.id) return; e.preventDefault(); r.classList.add("drop-target"); });
        r.addEventListener("dragleave", () => r.classList.remove("drop-target"));
        r.addEventListener("drop", (e) => { e.preventDefault(); r.classList.remove("drop-target"); if (this.dragId) this.ctx.actions.moveFilterTo(this.dragId, c.id, Math.max(1, i)); this.dragId = null; });
        r.addEventListener("dragend", () => { this.dragId = null; });
        this.tree.appendChild(r);
      });
      void last;
    }
  }

  private renderEmpty() {
    const touch = isTouchUi();
    clear(this.empty);
    this.empty.append(
      h("div", { class: "panel-empty-title" }, "The list of applied filters"),
      h("div", null, "After you add filters:"),
      h("div", null, touch ? "Tap to view" : "Single click to view"),
      h("div", null, touch ? "Double-tap to configure" : "Double click to configure"),
      h("div", null, touch ? "Long-press for more" : "Right click for more"));
  }

  setError(filterId: string | null) { this.errorFilter = filterId; this.render(); }

  private chainMenu(id: string): MenuDef[] {
    const a = this.ctx.actions;
    return [
      { label: "Rename Chain…", action: () => void a.renameChain(id) },
      { label: "Duplicate Chain", action: () => a.duplicateChain(id) },
      { label: "Open in New Viewer", action: () => a.openViewer(id) },
      { label: "Ask AI About This Chain…", action: () => this.ctx.focusAi(`About the chain “${this.ctx.store.chain(id)?.name ?? id}” (${id}): `) },
      "-",
      { label: "Write Video…", action: () => { this.ctx.store.setUi({ chainId: id }); void a.writeVideo(); } },
      { label: "Hash Output Frames…", action: () => void a.hashFrames(id) },
      "-",
      { label: "Delete Chain", action: () => void a.deleteChain(id) },
    ];
  }

  private filterMenu(chainId: string, filterId: string, idx: number): MenuDef[] {
    const a = this.ctx.actions, s = this.ctx.store;
    const c = s.chain(chainId)!;
    const f = c.filters[idx];
    const first = idx === 0;
    return [
      { label: "Configure", action: () => this.ctx.bus.emit("focusSettings") },
      { label: "Ask AI About This Filter…", action: () => this.ctx.focusAi(`About the ${FILTERS[f.type]?.name ?? f.type} filter (${f.id}, step ${idx + 1} of “${c.name}”): `) },
      { label: f.enabled ? "Disable" : "Enable", disabled: first, action: () => a.toggleFilter(filterId, !f.enabled) },
      "-",
      { label: "Move Up", disabled: idx <= 1, action: () => a.moveFilter(filterId, -1) },
      { label: "Move Down", disabled: first || idx >= c.filters.length - 1, action: () => a.moveFilter(filterId, 1) },
      { label: "Duplicate", disabled: first, action: () => a.duplicateFilter(filterId) },
      { label: "Copy Filter", action: () => a.copyFilter(filterId) },
      { label: "Paste Filter After", disabled: !a.hasClipboardFilter, action: () => a.pasteFilter() },
      { label: "Reset Parameters", action: () => a.resetFilter(filterId) },
      "-",
      { label: "New Chain From Here", action: () => a.chainFromHere(chainId, filterId) },
      { label: "Remove Filters After", disabled: idx >= c.filters.length - 1, action: () => a.removeAfter(chainId, filterId) },
      { label: "Remove", shortcut: "Del", disabled: first && c.filters.length > 1, action: () => void a.removeFilter(filterId) },
    ];
  }

  private onKey(e: KeyboardEvent) {
    const s = this.ctx.store, c = s.chain(), f = s.selectedFilter();
    if (!c || !f) return;
    const i = c.filters.findIndex((x) => x.id === f.id);
    if (e.key === "ArrowDown" && i < c.filters.length - 1) { s.selectFilter(c.filters[i + 1].id); e.preventDefault(); }
    else if (e.key === "ArrowUp" && i > 0) { s.selectFilter(c.filters[i - 1].id); e.preventDefault(); }
    else if (e.key === "Delete" || e.key === "Backspace") { void this.ctx.actions.removeFilter(f.id); e.preventDefault(); }
    else if (e.key === " " && i > 0) { this.ctx.actions.toggleFilter(f.id, !f.enabled); e.preventDefault(); }
    else if (e.key === "Enter") this.ctx.bus.emit("focusSettings");
  }
}
