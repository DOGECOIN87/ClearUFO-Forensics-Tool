// Minimal DOM helpers.
type Attrs = Record<string, any>;
type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

export function svg(markup: string, cls = "icon"): HTMLElement {
  const s = document.createElement("span");
  s.className = cls;
  s.innerHTML = markup;
  return s;
}

export function clear(el: Element) { while (el.firstChild) el.removeChild(el.firstChild); }

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export function fmtTime(t: number): string {
  if (!isFinite(t)) t = 0;
  const neg = t < 0;
  t = Math.abs(t);
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = Math.floor(t % 60), ms = Math.round((t - Math.floor(t)) * 1000) % 1000;
  return `${neg ? "-" : ""}${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

export function parseTime(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) { const v = parseFloat(s); return isFinite(v) ? v : null; }
  return (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3];
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(2)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function uid(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function download(data: BlobPart | Blob, name: string, mime = "application/octet-stream") {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name, style: { display: "none" } });
  document.body.appendChild(a);
  a.click();
  // the browser may still be opening the download (a save dialog, a large file): keep the link a while
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 40000);
}

export function pickFiles(accept: string, multiple = false, directory = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, style: { display: "none" } }) as HTMLInputElement;
    input.multiple = multiple;
    if (directory) (input as any).webkitdirectory = true;
    input.addEventListener("change", () => { resolve(Array.from(input.files ?? [])); input.remove(); });
    input.addEventListener("cancel", () => { resolve([]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

export class Emitter<E extends Record<string, any[]>> {
  private handlers: { [K in keyof E]?: Set<(...a: E[K]) => void> } = {};
  on<K extends keyof E>(ev: K, fn: (...a: E[K]) => void): () => void {
    (this.handlers[ev] ??= new Set()).add(fn);
    return () => this.handlers[ev]!.delete(fn);
  }
  emit<K extends keyof E>(ev: K, ...a: E[K]) { this.handlers[ev]?.forEach((fn) => { try { fn(...a); } catch (e) { console.error(e); } }); }
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T & { flush(): void } {
  let t: ReturnType<typeof setTimeout> | null = null;
  let last: any[] | null = null;
  const d = ((...a: any[]) => { last = a; if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(...last!); }, ms); }) as T & { flush(): void };
  d.flush = () => { if (t) { clearTimeout(t); t = null; fn(...last!); } };
  return d;
}
