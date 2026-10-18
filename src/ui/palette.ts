// Command palette (Ctrl+K), as in IDEs: every menu command, filter, panel and player action by name — and
// anything else typed as a sentence goes to the AI assistant.
import type { AppCommand } from "../app/context";
import { h } from "./dom";

let current: { close: () => void } | null = null;

/** Lower is better; null when a word is missing. */
function score(c: AppCommand, words: string[]): number | null {
  const label = c.label.toLowerCase(), hay = `${label} ${c.group.toLowerCase()} ${(c.keywords ?? "").toLowerCase()}`;
  let s = 0;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i < 0) return null;
    s += i;
  }
  if (label.startsWith(words[0])) s -= 100;
  else if (label.includes(` ${words[0]}`)) s -= 40;
  return s + (c.kind === "menu" ? 0 : c.kind === "filter" ? 5 : 10);
}

export function openPalette(commands: AppCommand[], opts: { onAsk?: (text: string) => void; initial?: string } = {}) {
  current?.close();
  const overlay = h("div", { class: "pal-overlay" });
  const input = h("input", { class: "pal-inp", type: "text", spellcheck: "false", placeholder: opts.onAsk ? "Type a command or filter — or ask the AI assistant anything…" : "Type a command or filter…", "aria-label": "Command" }) as HTMLInputElement;
  const list = h("div", { class: "pal-list", role: "listbox" });
  const box = h("div", { class: "pal", role: "dialog", "aria-label": "Command palette" }, input, list, h("div", { class: "pal-hint" }, "↑↓ choose · Enter run · Esc close"));
  overlay.appendChild(box);
  let shown: { label: string; group: string; shortcut?: string; disabled?: boolean; ask?: boolean; run: () => void | Promise<void> }[] = [];
  let sel = 0;
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); if (current?.close === close) current = null; };
  const run = (i: number) => {
    const it = shown[i];
    if (!it || it.disabled) return;
    close();
    void Promise.resolve().then(() => it.run());
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    let hits = words.length ? commands.map((c) => ({ c, s: score(c, words) })).filter((x): x is { c: AppCommand; s: number } => x.s !== null).sort((a, b) => a.s - b.s).map((x) => x.c) : commands.filter((c) => c.kind === "menu");
    hits = hits.slice(0, 60);
    shown = hits.map((c) => ({ label: c.label, group: c.group, shortcut: c.shortcut, disabled: c.disabled, run: c.run }));
    if (opts.onAsk && q) {
      const ask = { label: `Ask AI: ${input.value.trim()}`, group: "AI Assistant", ask: true, run: () => opts.onAsk!(input.value.trim()) };
      // a sentence (or nothing found) is most likely meant for the assistant
      if (words.length >= 3 || !shown.length) shown.unshift(ask); else shown.splice(Math.min(5, shown.length), 0, ask);
    }
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((it, i) => {
      const row = h("div", { class: `pal-item${i === sel ? " sel" : ""}${it.disabled ? " disabled" : ""}${it.ask ? " ask" : ""}`, role: "option", "aria-selected": String(i === sel) },
        h("span", { class: "pal-group" }, it.group), h("span", { class: "pal-label" }, it.label), it.shortcut ? h("span", { class: "pal-key" }, it.shortcut) : null);
      row.addEventListener("mousedown", (e) => { e.preventDefault(); run(i); });
      row.addEventListener("mousemove", () => { if (sel !== i) { sel = i; mark(); } });
      return row;
    }));
    if (!shown.length) list.appendChild(h("div", { class: "pal-empty" }, "No command matches."));
  };
  const mark = () => {
    list.querySelectorAll(".pal-item").forEach((el, i) => { el.classList.toggle("sel", i === sel); el.setAttribute("aria-selected", String(i === sel)); });
    (list.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  };
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); run(sel); }
  }
  input.addEventListener("input", () => { sel = 0; render(); });
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
  input.value = opts.initial ?? "";
  render();
  input.focus();
  current = { close };
  return { close };
}
