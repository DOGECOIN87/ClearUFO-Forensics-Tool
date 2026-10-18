// Menu bar and context menus.
import { h } from "./dom";
import { recentTouch } from "./touch";

export interface MenuItemDef {
  label: string;
  shortcut?: string;
  action?: () => void;
  disabled?: boolean;
  checked?: boolean;
  items?: MenuDef[];
}
export type MenuDef = MenuItemDef | "-";

let openPopup: { el: HTMLElement; close: () => void } | null = null;

export function closeMenus() { openPopup?.close(); openPopup = null; }

function buildPopup(items: MenuDef[], onDone: () => void, level = 0): HTMLElement {
  const pop = h("div", { class: "menu-popup", role: "menu" });
  let sub: HTMLElement | null = null;
  const items2 = items.filter((it, i, a) => !(it === "-" && (i === 0 || a[i - 1] === "-" || i === a.length - 1)));
  for (const it of items2) {
    if (it === "-") { pop.appendChild(h("div", { class: "menu-sep" })); continue; }
    const row = h("div", { class: `menu-item${it.disabled ? " disabled" : ""}`, role: "menuitem", tabindex: "-1" },
      h("span", { class: "menu-check" }, it.checked ? "✓" : ""),
      h("span", { class: "menu-label" }, it.label),
      h("span", { class: "menu-shortcut" }, it.shortcut ?? (it.items ? "▸" : "")),
    );
    const activate = () => {
      pop.querySelectorAll(".menu-item.active").forEach((e) => e.classList.remove("active"));
      row.classList.add("active");
      if (sub && sub.dataset.owner === it.label) return;
      sub?.remove(); sub = null;
      if (it.items && !it.disabled) {
        sub = buildPopup(it.items, onDone, level + 1);
        sub.dataset.owner = it.label;
        document.body.appendChild(sub);
        const r = row.getBoundingClientRect(), sw = sub.getBoundingClientRect().width;
        // narrow screens: no room on either side, so cascade the submenu below its parent item
        if (r.right - 2 + sw > window.innerWidth - 4 && r.left - sw < 4) positionPopup(sub, Math.min(r.left + 18, window.innerWidth - sw - 4), r.bottom - 2);
        else positionPopup(sub, r.right - 2, r.top - 3, r.left);
      }
    };
    // hover opens submenus with a mouse; after a tap the emulated mouseenter would open the
    // submenu under the finger and the tap's click would hit one of its items, so touch uses click
    row.addEventListener("mouseenter", () => { if (!recentTouch()) activate(); });
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (it.items && !it.disabled) { activate(); return; } // touch: tapping a parent opens its submenu
      if (it.disabled || it.items) return;
      onDone();
      setTimeout(() => it.action?.(), 0);
    });
    pop.appendChild(row);
  }
  const origRemove = pop.remove.bind(pop);
  pop.remove = () => { sub?.remove(); origRemove(); };
  return pop;
}

function positionPopup(pop: HTMLElement, x: number, y: number, altX?: number) {
  pop.style.left = "0px"; pop.style.top = "0px";
  const r = pop.getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  let left = x, top = y;
  if (left + r.width > W - 4) left = altX !== undefined ? Math.max(4, altX - r.width) : Math.max(4, W - r.width - 4);
  if (top + r.height > H - 4) top = Math.max(4, H - r.height - 4);
  pop.style.left = `${left}px`; pop.style.top = `${top}px`;
}

export function showContextMenu(x: number, y: number, items: MenuDef[]) {
  closeMenus();
  const pop = buildPopup(items, () => closeMenus());
  document.body.appendChild(pop);
  positionPopup(pop, x, y);
  const onDown = (e: Event) => { if (!(e.target as HTMLElement).closest(".menu-popup")) closeMenus(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeMenus(); };
  setTimeout(() => { document.addEventListener("pointerdown", onDown, true); document.addEventListener("keydown", onKey, true); }, 0);
  openPopup = { el: pop, close: () => { pop.remove(); document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey, true); } };
}

export class MenuBar {
  private active = -1;
  private buttons: HTMLElement[] = [];
  constructor(private el: HTMLElement, private menus: { label: string; items: () => MenuDef[] }[]) {
    el.classList.add("menubar");
    menus.forEach((m, i) => {
      const b = h("div", { class: "menubar-item", tabindex: "-1" }, m.label);
      b.addEventListener("pointerdown", (e) => { e.preventDefault(); this.active === i ? this.close() : this.open(i); });
      b.addEventListener("mouseenter", () => { if (this.active >= 0 && this.active !== i && !recentTouch()) this.open(i); });
      this.buttons.push(b);
      el.appendChild(b);
    });
  }
  open(i: number) {
    closeMenus();
    this.active = i;
    this.buttons.forEach((b, k) => b.classList.toggle("open", k === i));
    const pop = buildPopup(this.menus[i].items(), () => this.close());
    document.body.appendChild(pop);
    const r = this.buttons[i].getBoundingClientRect();
    positionPopup(pop, r.left, r.bottom);
    const onDown = (e: Event) => { const t = e.target as HTMLElement; if (!t.closest(".menu-popup") && !t.closest(".menubar")) this.close(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.close();
      else if (e.key === "ArrowRight") this.open((i + 1) % this.menus.length);
      else if (e.key === "ArrowLeft") this.open((i - 1 + this.menus.length) % this.menus.length);
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const rows = [...pop.querySelectorAll<HTMLElement>(":scope > .menu-item:not(.disabled)")];
        const cur = rows.findIndex((r2) => r2.classList.contains("active"));
        const next = rows[(cur + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length];
        rows.forEach((r2) => r2.classList.remove("active"));
        next?.classList.add("active");
        e.preventDefault();
      } else if (e.key === "Enter") { pop.querySelector<HTMLElement>(":scope > .menu-item.active")?.click(); }
    };
    setTimeout(() => { document.addEventListener("pointerdown", onDown, true); document.addEventListener("keydown", onKey, true); }, 0);
    openPopup = { el: pop, close: () => { pop.remove(); document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey, true); } };
  }
  close() {
    closeMenus();
    this.active = -1;
    this.buttons.forEach((b) => b.classList.remove("open"));
  }
}
