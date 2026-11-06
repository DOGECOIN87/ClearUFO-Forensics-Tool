import type { CurveParam, LineParam, PointParam, PointsParam, RectParam } from '../shared/filters';

export type GeometryParam = RectParam | PointParam | PointsParam | LineParam | CurveParam;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const point = (v: unknown): v is { x: number; y: number } => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return finite(p.x) && finite(p.y);
};

/** Parse without changing coordinates or silently fixing malformed geometry. */
export function parseGeometry(def: GeometryParam, text: string): { value: unknown; error: null } | { value: null; error: string } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { value: null, error: 'Enter valid JSON.' }; }
  if (def.type === 'point') return value === null || point(value) ? { value, error: null } : { value: null, error: 'Expected null or an object with finite x and y numbers.' };
  if (def.type === 'rect') {
    if (value === null) return { value, error: null };
    if (!point(value)) return { value: null, error: 'Expected null or an object with finite x, y, w and h numbers.' };
    const r = value as { x: number; y: number; w?: unknown; h?: unknown };
    return finite(r.w) && finite(r.h) && r.w >= 0 && r.h >= 0
      ? { value, error: null } : { value: null, error: 'Rectangle width and height must be finite and non-negative.' };
  }
  if (def.type === 'line' && value === null) return { value, error: null };
  if (!Array.isArray(value) || !value.every(point)) return { value: null, error: 'Expected an array of points with finite x and y numbers.' };
  if (def.type === 'line' && value.length !== 2) return { value: null, error: 'A line needs exactly two points.' };
  if (def.type === 'points' && def.maxPoints !== undefined && value.length > def.maxPoints) return { value: null, error: `At most ${def.maxPoints} points are allowed.` };
  if (def.type === 'curve' && (value.length < 2 || value.some(p => p.x < 0 || p.x > 255 || p.y < 0 || p.y > 255))) {
    return { value: null, error: 'A curve needs at least two points, with x and y in 0–255.' };
  }
  return { value, error: null };
}
