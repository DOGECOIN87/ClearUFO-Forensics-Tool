// Form controls styled after the desktop forensic suite (spin boxes, tick sliders, combos).
import { h, svg } from "./dom";
import { I } from "./icons";

export interface SpinOpts { value: number; min: number; max: number; step?: number; decimals?: number; width?: number; onChange: (v: number, final: boolean) => void; disabled?: boolean }

export function spinBox(o: SpinOpts) {
  const dec = o.decimals ?? 0;
  const step = o.step ?? (dec ? 10 ** -Math.min(dec, 2) : 1);
  const input = h("input", { class: "spin-inp", type: "text", inputmode: "decimal", spellcheck: "false" }) as HTMLInputElement;
  const fmt = (v: number) => (dec ? v.toFixed(dec) : String(Math.round(v)));
  let value = o.value;
  input.value = fmt(value);
  const commit = (v: number, final: boolean) => {
    if (!isFinite(v)) { input.value = fmt(value); return; }
    v = Math.max(o.min, Math.min(o.max, v));
    if (!dec) v = Math.round(v);
    value = v;
    input.value = fmt(v);
    o.onChange(v, final);
  };
  input.addEventListener("change", () => commit(parseFloat(input.value), true));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); commit(value + (e.key === "ArrowUp" ? step : -step) * (e.shiftKey ? 10 : 1), true); }
    if (e.key === "Enter") input.blur();
  });
  input.addEventListener("wheel", (e) => { if (document.activeElement !== input) return; e.preventDefault(); commit(value + (e.deltaY < 0 ? step : -step), true); }, { passive: false });
  const up = h("button", { class: "spin-btn", tabindex: "-1", "aria-label": "Increase" }, "▲");
  const dn = h("button", { class: "spin-btn", tabindex: "-1", "aria-label": "Decrease" }, "▼");
  const hold = (dir: number) => {
    let t: ReturnType<typeof setTimeout>;
    const tick = (delay: number) => { commit(value + dir * step, true); t = setTimeout(() => tick(Math.max(30, delay * 0.8)), delay); };
    tick(380);
    const stop = () => { clearTimeout(t); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointerup", stop);
  };
  up.addEventListener("pointerdown", (e) => { e.preventDefault(); hold(1); });
  dn.addEventListener("pointerdown", (e) => { e.preventDefault(); hold(-1); });
  const el = h("div", { class: "spin", style: o.width ? { width: `${o.width}px` } : undefined }, input, h("div", { class: "spin-btns" }, up, dn));
  if (o.disabled) { input.disabled = true; el.classList.add("disabled"); }
  return { el, input, set(v: number) { value = v; if (document.activeElement !== input) input.value = fmt(v); }, get value() { return value; } };
}

export interface SliderOpts { min: number; max: number; value: number; log?: boolean; ticks?: number; step?: number; onInput: (v: number) => void; onChange?: (v: number) => void; labels?: boolean; decimals?: number; /** Map a raw position value to the value used (detents). */ snap?: (v: number) => number }

export function slider(o: SliderOpts) {
  const RES = 1000;
  const toPos = (v: number) => o.log && o.min > 0 ? (Math.log(v / o.min) / Math.log(o.max / o.min)) * RES : ((v - o.min) / (o.max - o.min || 1)) * RES;
  const fromPos = (p: number) => {
    let v = o.log && o.min > 0 ? o.min * Math.pow(o.max / o.min, p / RES) : o.min + (p / RES) * (o.max - o.min);
    if (o.step) v = Math.round(v / o.step) * o.step;
    if (o.snap) v = o.snap(v);
    return Math.max(o.min, Math.min(o.max, v));
  };
  const range = h("input", { class: "slider", type: "range", min: "0", max: String(RES), step: "1" }) as HTMLInputElement;
  range.value = String(toPos(o.value));
  range.addEventListener("input", () => o.onInput(fromPos(+range.value)));
  range.addEventListener("change", () => o.onChange?.(fromPos(+range.value)));
  const ticks = h("div", { class: "slider-ticks" });
  const n = o.ticks ?? 5;
  for (let i = 0; i <= n; i++) ticks.appendChild(h("i", { style: { left: `${(i / n) * 100}%` } }));
  const fmt = (v: number) => (o.decimals !== undefined ? +v.toFixed(o.decimals) : +v.toPrecision(4)).toString();
  const el = h("div", { class: "slider-row" },
    o.labels === false ? null : h("span", { class: "slider-min" }, fmt(o.min)),
    h("div", { class: "slider-wrap" }, range, ticks),
    o.labels === false ? null : h("span", { class: "slider-max" }, fmt(o.max)));
  return { el, range, set(v: number) { range.value = String(toPos(v)); } };
}

export function selectBox(options: [string, string][], value: string, onChange: (v: string) => void, cls = "sel") {
  const s = h("select", { class: cls }) as HTMLSelectElement;
  for (const [v, l] of options) s.appendChild(h("option", { value: v }, l));
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

export function checkBox(label: string, checked: boolean, onChange: (v: boolean) => void) {
  const input = h("input", { type: "checkbox", class: "chk" }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const el = h("label", { class: "chk-row" }, input, h("span", null, label));
  return { el, input, set(v: boolean) { input.checked = v; } };
}

export function btn(label: string, onClick: () => void, cls = "btn") {
  const b = h("button", { class: cls }, label);
  b.addEventListener("click", onClick);
  return b;
}

export function iconBtn(icon: string, title: string, onClick: (e: MouseEvent) => void, cls = "ibtn") {
  const b = h("button", { class: cls, title, "aria-label": title });
  b.appendChild(svg(icon));
  b.addEventListener("click", onClick);
  return b;
}

export function colorSwatch(value: string, onChange: (v: string) => void) {
  const input = h("input", { type: "color", class: "color-inp", value }) as HTMLInputElement;
  const sw = h("span", { class: "color-swatch", style: { background: value } });
  const el = h("label", { class: "color-btn" }, sw, input);
  input.addEventListener("input", () => { sw.style.background = input.value; onChange(input.value); });
  return { el, set(v: string) { input.value = v; sw.style.background = v; } };
}

export { I };
