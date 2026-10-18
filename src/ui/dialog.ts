// Modal dialogs.
import { h } from "./dom";

export interface DialogButton { label: string; primary?: boolean; danger?: boolean; action?: () => boolean | void | Promise<boolean | void> }

export interface DialogHandle { el: HTMLElement; body: HTMLElement; close: () => void; setButtons: (b: DialogButton[]) => void }

export function dialog(opts: { title: string; body: HTMLElement | string; buttons?: DialogButton[]; width?: number; onClose?: () => void; closable?: boolean }): DialogHandle {
  const overlay = h("div", { class: "dlg-overlay" });
  const body = h("div", { class: "dlg-body" });
  if (typeof opts.body === "string") body.innerHTML = opts.body; else body.appendChild(opts.body);
  const footer = h("div", { class: "dlg-footer" });
  const closeBtn = h("button", { class: "dlg-x", title: "Close", "aria-label": "Close" }, "×");
  const box = h("div", { class: "dlg", role: "dialog", "aria-modal": "true", style: { width: `${opts.width ?? 460}px` } },
    h("div", { class: "dlg-title" }, h("span", null, opts.title), closeBtn), body, footer);
  overlay.appendChild(box);
  let closed = false;
  const close = () => { if (closed) return; closed = true; overlay.remove(); document.removeEventListener("keydown", onKey, true); opts.onClose?.(); };
  const setButtons = (buttons: DialogButton[]) => {
    footer.innerHTML = "";
    for (const b of buttons) {
      const el = h("button", { class: `btn${b.primary ? " primary" : ""}${b.danger ? " danger" : ""}` }, b.label);
      el.addEventListener("click", async () => {
        const r = b.action ? await b.action() : undefined;
        if (r !== false) close();
      });
      footer.appendChild(el);
    }
    footer.style.display = buttons.length ? "" : "none";
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && opts.closable !== false) { e.stopPropagation(); close(); }
    if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
      const p = footer.querySelector<HTMLButtonElement>(".btn.primary");
      if (p) { e.preventDefault(); e.stopPropagation(); p.click(); }
    }
  };
  closeBtn.addEventListener("click", () => { if (opts.closable !== false) close(); });
  if (opts.closable === false) closeBtn.style.display = "none";
  document.addEventListener("keydown", onKey, true);
  setButtons(opts.buttons ?? [{ label: "OK", primary: true }]);
  document.body.appendChild(overlay);
  setTimeout(() => (box.querySelector("input, select, textarea, .btn.primary") as HTMLElement | null)?.focus(), 30);
  return { el: box, body, close, setButtons };
}

export function alertDialog(title: string, message: string | HTMLElement): Promise<void> {
  return new Promise((resolve) => { dialog({ title, body: typeof message === "string" ? h("div", { class: "dlg-msg" }, message) : message, onClose: resolve }); });
}

export function confirmDialog(title: string, message: string, okLabel = "OK", danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let r = false;
    dialog({ title, body: h("div", { class: "dlg-msg" }, message), onClose: () => resolve(r), buttons: [{ label: "Cancel" }, { label: okLabel, primary: true, danger, action: () => { r = true; } }] });
  });
}

export function promptDialog(title: string, label: string, value = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h("input", { class: "inp", type: "text", value, style: { width: "100%" } }) as HTMLInputElement;
    let r: string | null = null;
    dialog({ title, body: h("label", { class: "dlg-field" }, h("span", null, label), input), onClose: () => resolve(r), buttons: [{ label: "Cancel" }, { label: "OK", primary: true, action: () => { r = input.value; } }] });
    setTimeout(() => { input.focus(); input.select(); }, 40);
  });
}

export interface ProgressHandle { set(label: string, v: number): void; close(): void; cancelled: boolean }

export function progressDialog(title: string, onCancel?: () => void): ProgressHandle {
  const lab = h("div", { class: "dlg-msg" }, "Starting…");
  const bar = h("div", { class: "pbar" }, h("div", { class: "pbar-fill" }));
  const handle: ProgressHandle = { cancelled: false, set: () => undefined, close: () => undefined };
  const d = dialog({ title, body: h("div", null, lab, bar), closable: false, buttons: onCancel ? [{ label: "Cancel", action: () => { handle.cancelled = true; onCancel(); } }] : [] });
  handle.set = (label, v) => { lab.textContent = label; (bar.firstChild as HTMLElement).style.width = `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`; };
  handle.close = d.close;
  return handle;
}

export function toast(message: string, kind: "info" | "error" | "ok" = "info", ms = 3200) {
  let host = document.querySelector(".toasts") as HTMLElement | null;
  if (!host) { host = h("div", { class: "toasts" }); document.body.appendChild(host); }
  const t = h("div", { class: `toast ${kind}` }, message);
  host.appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 300); }, ms);
}
