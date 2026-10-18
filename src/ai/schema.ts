// Filter catalogue and parameter validation for the assistant (no DOM: unit tested).
// The model sees each filter's real parameter schema; whatever it sends is checked against it, normalized
// (labels → values, [x, y, w, h] → rect, clamped numbers…) and refused with a precise reason otherwise, so
// it can correct itself — the "compiler errors" of the IDE analogy.
import { CATEGORIES, FILTER_LIST, FILTERS, type FilterDef, type ParamDef } from "../shared/filters";
import type { ParamValues, Pt, RectP } from "../shared/types";

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-./()]+/g, "");

/** Filter by id or name, tolerant of case and separators ("Levels", "levels", "Motion Deblurring"). */
export function resolveFilterType(q: unknown): FilterDef | null {
  if (typeof q !== "string" || !q.trim()) return null;
  if (FILTERS[q]) return FILTERS[q];
  const n = norm(q);
  return FILTER_LIST.find((f) => norm(f.id) === n || norm(f.name) === n) ?? null;
}

/** Parameters the assistant may not set (files are opened by the user; buttons and previews are UI only). */
const UI_ONLY = new Set(["action", "psf", "info", "fileinfo", "source", "image"]);
export const settable = (d: ParamDef) => !UI_ONLY.has(d.type);

export function filterCatalog(category?: string, search?: string) {
  const cat = category ? CATEGORIES.find((c) => norm(c.name) === norm(category))?.name : undefined;
  const q = search ? norm(search) : "";
  return FILTER_LIST.filter((f) => (!cat || f.category === cat) && (!q || norm(f.name).includes(q) || norm(f.id).includes(q) || norm(f.description).includes(q) || norm(f.category).includes(q)))
    .map((f) => ({ type: f.id, name: f.name, category: f.category, description: f.description, ...(f.kind !== "filter" ? { kind: f.kind } : {}), ...(f.slow ? { slow: true } : {}), ...(f.temporal ? { temporal: true } : {}) }));
}

export function paramSchema(d: ParamDef): Record<string, unknown> {
  const o: Record<string, unknown> = { key: d.key, label: d.label, type: d.type };
  if ("default" in d && d.default !== undefined) o.default = d.default;
  switch (d.type) {
    case "number": case "int":
      o.min = d.min; o.max = d.max;
      if (d.unit) o.unit = d.unit;
      if (d.type === "number" && d.decimals !== undefined) o.decimals = d.decimals;
      break;
    case "select": o.options = d.options.map(([value, label]) => (value === label ? value : { value, label })); break;
    case "rect": o.format = "{x, y, w, h} in input pixels, or null"; break;
    case "point": o.format = "{x, y} in input pixels, or null"; break;
    case "points": o.format = "[{x, y}, …] in input pixels"; if (d.minPoints) o.minPoints = d.minPoints; if (d.maxPoints) o.maxPoints = d.maxPoints; break;
    case "line": o.format = "[{x, y}, {x, y}] (start, end) in input pixels, or null"; break;
    case "chain": o.format = "id of another chain"; break;
    case "chains": o.format = "array of chain ids"; break;
    case "frame": o.format = d.allowLast ? "frame number (0-based), -1 = last" : "frame number (0-based)"; break;
    case "curve": o.format = "[{x, y}, …] control points, 0–255, increasing x, at least 2"; break;
    case "color": o.format = "#rrggbb"; break;
  }
  if (d.help) o.help = d.help;
  if (d.show) o.note = "shown only for some values of the other parameters";
  if (!settable(d)) o.readOnly = true;
  return o;
}

export function filterSchema(def: FilterDef) {
  return {
    type: def.id, name: def.name, category: def.category, kind: def.kind, description: def.description,
    ...(def.hint ? { hint: def.hint } : {}), ...(def.reference ? { reference: def.reference } : {}),
    ...(def.temporal ? { temporal: true } : {}), ...(def.slow ? { slow: "computationally intensive" } : {}),
    ...(def.overlayOn === "input" ? { coordinates: "geometric parameters are in pixels of this filter's INPUT" } : {}),
    params: def.params.filter((d) => d.type !== "action" && d.type !== "psf" && d.type !== "info" && d.type !== "fileinfo").map(paramSchema),
  };
}

export interface ValidateCtx { chains: { id: string; name: string }[] }
export interface Validated { params: ParamValues; warnings: string[]; errors: string[] }

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && isFinite(n) ? n : null;
};

function pt(v: unknown): Pt | null {
  if (Array.isArray(v) && v.length === 2) { const x = num(v[0]), y = num(v[1]); return x !== null && y !== null ? { x, y } : null; }
  if (v && typeof v === "object") { const o = v as any; const x = num(o.x), y = num(o.y); return x !== null && y !== null ? { x, y } : null; }
  return null;
}

function rect(v: unknown): RectP | null {
  let x, y, w, h;
  if (Array.isArray(v) && v.length === 4) [x, y, w, h] = v.map(num);
  else if (v && typeof v === "object") { const o = v as any; x = num(o.x ?? o.left); y = num(o.y ?? o.top); w = num(o.w ?? o.width); h = num(o.h ?? o.height); }
  if ([x, y, w, h].some((q) => q === null || q === undefined)) return null;
  if (w! <= 0 || h! <= 0) return null;
  return { x: x!, y: y!, w: w!, h: h! };
}

/** Validate and normalize parameters sent by the model for a filter. */
export function validateParams(def: FilterDef, input: unknown, ctx: ValidateCtx): Validated {
  const params: ParamValues = {}, warnings: string[] = [], errors: string[] = [];
  if (input === undefined || input === null) return { params, warnings, errors };
  if (typeof input !== "object" || Array.isArray(input)) return { params, warnings, errors: ["params must be an object of parameter keys and values"] };
  const byKey = new Map(def.params.map((d) => [d.key, d]));
  const byLabel = new Map(def.params.map((d) => [norm(d.label), d]));
  const chainId = (v: unknown) => {
    if (typeof v !== "string") return null;
    return ctx.chains.find((c) => c.id === v)?.id ?? ctx.chains.find((c) => norm(c.name) === norm(v))?.id ?? null;
  };
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const d = byKey.get(k) ?? byLabel.get(norm(k));
    if (!d) {
      const keys = def.params.filter(settable).map((p) => p.key);
      errors.push(`unknown parameter "${k}" for ${def.name}${keys.length ? `; valid: ${keys.join(", ")}` : " (it has no settable parameters)"}`);
      continue;
    }
    const key = d.key;
    if (!settable(d)) { errors.push(`"${key}" cannot be set by the assistant${d.type === "source" || d.type === "image" ? " (files are opened by the user: use open_media)" : ""}`); continue; }
    switch (d.type) {
      case "number": case "int": {
        let n = num(v);
        if (n === null) { errors.push(`${key} must be a number (${d.min}–${d.max})`); break; }
        if (d.type === "int") n = Math.round(n);
        if (n < d.min || n > d.max) { const c = Math.min(d.max, Math.max(d.min, n)); warnings.push(`${key} ${n} is outside ${d.min}–${d.max}: set to ${c}`); n = c; }
        params[key] = n;
        break;
      }
      case "select": {
        const s = String(v);
        const opt = d.options.find(([val]) => val === s) ?? d.options.find(([val, label]) => norm(val) === norm(s) || norm(label) === norm(s));
        if (!opt) errors.push(`${key} must be one of: ${d.options.map(([val]) => val).join(", ")}`);
        else params[key] = opt[0];
        break;
      }
      case "bool": {
        if (typeof v === "boolean") params[key] = v;
        else if (v === "true" || v === 1 || v === "1") params[key] = true;
        else if (v === "false" || v === 0 || v === "0") params[key] = false;
        else errors.push(`${key} must be true or false`);
        break;
      }
      case "color": {
        const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v).trim());
        if (!m) { errors.push(`${key} must be a color like #ff8800`); break; }
        params[key] = `#${m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1]}`.toLowerCase();
        break;
      }
      case "text": params[key] = String(v ?? ""); break;
      case "rect": {
        if (v === null) { params[key] = null; break; }
        const r = rect(v);
        if (!r) errors.push(`${key} must be {x, y, w, h} with w and h > 0, or null`); else params[key] = r;
        break;
      }
      case "point": {
        if (v === null) { params[key] = null; break; }
        const p = pt(v);
        if (!p) errors.push(`${key} must be {x, y} or null`); else params[key] = p;
        break;
      }
      case "points": {
        if (!Array.isArray(v)) { errors.push(`${key} must be an array of {x, y}`); break; }
        const ps = v.map(pt);
        if (ps.some((p) => !p)) { errors.push(`${key}: every point must be {x, y}`); break; }
        if (d.minPoints && ps.length && ps.length < d.minPoints) { errors.push(`${key} needs at least ${d.minPoints} points`); break; }
        if (d.maxPoints && ps.length > d.maxPoints) { errors.push(`${key} takes at most ${d.maxPoints} points`); break; }
        params[key] = ps as Pt[];
        break;
      }
      case "line": {
        if (v === null) { params[key] = null; break; }
        let a: Pt | null = null, b: Pt | null = null;
        if (Array.isArray(v) && v.length === 2) { a = pt(v[0]); b = pt(v[1]); }
        else if (v && typeof v === "object") { const o = v as any; a = pt({ x: o.x1, y: o.y1 }); b = pt({ x: o.x2, y: o.y2 }); }
        if (!a || !b) errors.push(`${key} must be [{x, y}, {x, y}] or null`); else params[key] = [a, b];
        break;
      }
      case "chain": {
        const id = chainId(v);
        if (!id) errors.push(`${key} must be the id of an existing chain (${ctx.chains.map((c) => `${c.id} = "${c.name}"`).join(", ") || "none"})`);
        else params[key] = id;
        break;
      }
      case "chains": {
        const arr = Array.isArray(v) ? v : [v];
        const ids = arr.map(chainId);
        if (ids.some((i) => !i)) errors.push(`${key} must list ids of existing chains`); else params[key] = ids as string[];
        break;
      }
      case "frame": {
        const n = num(v);
        const min = d.allowLast ? -1 : 0;
        if (n === null || Math.round(n) < min) errors.push(`${key} must be a frame number${d.allowLast ? " (-1 = last)" : ""}`);
        else params[key] = Math.round(n);
        break;
      }
      case "curve": {
        if (!Array.isArray(v) || v.length < 2) { errors.push(`${key} needs at least 2 points {x, y}`); break; }
        const ps = v.map(pt);
        if (ps.some((p) => !p)) { errors.push(`${key}: every point must be {x, y}`); break; }
        const c = (ps as Pt[]).map((p) => ({ x: Math.min(255, Math.max(0, p.x)), y: Math.min(255, Math.max(0, p.y)) })).sort((a, b) => a.x - b.x);
        params[key] = c;
        break;
      }
      default: params[key] = v as never;
    }
  }
  return { params, warnings, errors };
}

/** Parameters for display to the model: settable ones, long arrays summarized. */
export function compactParams(def: FilterDef | undefined, params: ParamValues, sourceName?: (id: string) => string): Record<string, unknown> {
  if (!def) return { ...params };
  const out: Record<string, unknown> = {};
  for (const d of def.params) {
    if (d.type === "action" || d.type === "psf" || d.type === "info" || d.type === "fileinfo") continue;
    const v = params[d.key];
    if (d.type === "source" || d.type === "image") { out[d.key] = v ? (sourceName?.(String(v)) ?? v) : null; continue; }
    if (Array.isArray(v) && v.length > 12) out[d.key] = `[${v.length} items]`;
    else out[d.key] = v === undefined ? null : v;
  }
  return out;
}
