// Filters: categories and filters, quick search, description.
import { CATEGORIES, FILTER_LIST, filtersInCategory, type Category, type FilterDef } from "../shared/filters";
import type { AppCtx } from "../app/context";
import { clear, h } from "../ui/dom";
import { isCoarsePointer, isTouchUi, onDoubleActivate } from "../ui/touch";

export class FiltersPanel {
  el: HTMLElement;
  private search: HTMLInputElement;
  private cats: HTMLElement;
  private list: HTMLElement;
  private desc: HTMLElement;
  private cat: Category = "Load";
  private sel: string | null = null;
  private results: FilterDef[] = [];

  constructor(private ctx: AppCtx) {
    this.search = h("input", { class: "quick-search", type: "search", placeholder: "Quick Search: select and press enter", spellcheck: "false" }) as HTMLInputElement;
    this.cats = h("div", { class: "cat-list", role: "listbox" });
    this.list = h("div", { class: "flt-list", role: "listbox", tabindex: "0" });
    this.desc = h("div", { class: "filter-desc" });
    this.el = h("div", { class: "panel filters-panel" }, this.search, h("div", { class: "filters-lists" }, this.cats, this.list), this.desc);
    this.search.addEventListener("input", () => this.renderList());
    this.search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { const id = this.sel ?? this.results[0]?.id; if (id) this.add(id); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { this.move(e.key === "ArrowDown" ? 1 : -1); e.preventDefault(); }
      else if (e.key === "Escape") { this.search.value = ""; this.renderList(); }
    });
    this.list.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.sel) this.add(this.sel);
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { this.move(e.key === "ArrowDown" ? 1 : -1); e.preventDefault(); }
    });
    this.renderCats();
    this.renderList();
  }

  focusSearch() { this.search.focus(); this.search.select(); }

  private renderCats() {
    clear(this.cats);
    for (const c of CATEGORIES) {
      const el = h("div", { class: `cat-item${c.name === this.cat ? " active" : ""}`, role: "option" }, c.name);
      el.addEventListener("click", () => { this.cat = c.name; this.search.value = ""; this.sel = null; this.renderCats(); this.renderList(); });
      this.cats.appendChild(el);
    }
  }

  private renderList() {
    const q = this.search.value.trim().toLowerCase();
    this.results = q ? FILTER_LIST.filter((f) => f.name.toLowerCase().includes(q) || f.category.toLowerCase().includes(q) || f.description.toLowerCase().includes(q)) : filtersInCategory(this.cat);
    if (q && this.results.length && !this.results.some((r) => r.id === this.sel)) this.sel = this.results[0].id;
    clear(this.list);
    for (const f of this.results) {
      const el = h("div", { class: `flt-item${f.id === this.sel ? " active" : ""}`, role: "option", title: f.description, draggable: isCoarsePointer() ? "false" : "true", dataset: { id: f.id } }, q ? h("span", null, f.name, h("span", { class: "flt-cat" }, ` — ${f.category}`)) : f.name);
      el.addEventListener("click", () => { if (this.sel === f.id) return; this.sel = f.id; this.renderList(); this.list.focus({ preventScroll: true }); });
      onDoubleActivate(el, `flt:${f.id}`, () => this.add(f.id));
      el.addEventListener("dragstart", (e) => { e.dataTransfer!.setData("text/x-lucid-new-filter", f.id); e.dataTransfer!.effectAllowed = "copy"; });
      this.list.appendChild(el);
    }
    const cur = this.results.find((r) => r.id === this.sel);
    clear(this.desc);
    this.desc.append(cur ? cur.description : q ? `${this.results.length} filters found` : CATEGORIES.find((c) => c.name === this.cat)?.description ?? "");
    // Touch screens: double-tap is not discoverable, so the selected filter gets an explicit Add button.
    if (cur && isTouchUi()) {
      const add = h("button", { class: "btn primary flt-add", type: "button" }, cur.kind === "loader" ? `Open: ${cur.name}` : `Add ${cur.name}`);
      add.addEventListener("click", () => this.add(cur.id));
      this.desc.append(add);
    }
  }

  private move(d: number) {
    if (!this.results.length) return;
    const i = this.results.findIndex((r) => r.id === this.sel);
    this.sel = this.results[Math.max(0, Math.min(this.results.length - 1, (i < 0 ? -1 : i) + d))].id;
    this.renderList();
    this.list.querySelector(".flt-item.active")?.scrollIntoView({ block: "nearest" });
  }

  private add(id: string) {
    const s = this.ctx.store, before = s.selectedFilter()?.id;
    this.ctx.actions.addFilter(id);
    // In the compact layouts Filters and Filter Settings share a tab group: show the new filter's settings.
    if (document.documentElement.dataset.layout !== "desktop" && s.selectedFilter()?.id !== before) this.ctx.bus.emit("focusSettings");
  }

  /** Re-renders (e.g. after a layout change between desktop and compact). */
  refresh() { this.renderList(); }
}
