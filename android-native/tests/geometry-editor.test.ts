import { describe, expect, it } from 'vitest';
import { FILTERS } from '@/lib/shared/filters';
import { parseGeometry, type GeometryParam } from '@/lib/viewer/geometry';

const param = (filter: string, key: string) => FILTERS[filter].params.find(p => p.key === key)! as GeometryParam;
describe('geometry parameter input', () => {
  it('accepts exact coordinates without rounding and rejects malformed rectangles', () => {
    const def = param('add_shape', 'rect');
    expect(parseGeometry(def, '{"x":1.25,"y":-2,"w":40,"h":3}').value).toEqual({ x: 1.25, y: -2, w: 40, h: 3 });
    expect(parseGeometry(def, '{"x":1,"y":2,"w":-1,"h":3}').error).toBeTruthy();
    expect(parseGeometry(def, 'null').error).toBeNull();
  });
  it('validates lines, point counts and curve range', () => {
    expect(parseGeometry(param('add_shape', 'line'), '[{"x":0,"y":0}]').error).toBeTruthy();
    expect(parseGeometry(param('curves', 'curve'), '[{"x":0,"y":0},{"x":256,"y":255}]').error).toBeTruthy();
    expect(parseGeometry(param('curves', 'curve'), '[{"x":0,"y":0},{"x":255,"y":255}]').error).toBeNull();
    expect(parseGeometry(param('correct_perspective', 'points'), JSON.stringify(Array(5).fill({ x: 1, y: 2 }))).error).toBeTruthy();
    expect(parseGeometry(param('add_shape', 'line'), 'not JSON').error).toBeTruthy();
  });
});
