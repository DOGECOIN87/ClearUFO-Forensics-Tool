import { describe, expect, it } from 'vitest';
import { imageBounds, imagePixel, pinchPan } from '@/lib/viewer/coordinates';

describe('viewer coordinate mapping', () => {
  const v = { width: 200, height: 200, imageWidth: 100, imageHeight: 50, zoom: 1, panX: 0, panY: 0 };
  it('maps the aspect-fit image and excludes letterboxing and the outer edge', () => {
    expect(imageBounds(v)).toEqual({ left: 0, top: 50, width: 200, height: 100, scale: 2 });
    expect(imagePixel(v, 0, 50)).toEqual({ x: 0, y: 0 });
    expect(imagePixel(v, 199.9, 149.9)).toEqual({ x: 99, y: 49 });
    expect(imagePixel(v, 10, 49)).toBeNull();
    expect(imagePixel(v, 200, 100)).toBeNull();
  });
  it('keeps the pinch anchor under the fingers through zoom and translation', () => {
    const next = { ...v, zoom: 2, ...pinchPan(v, 40, 70, 60, 80, 2) };
    expect(imagePixel(next, 60, 80)).toEqual(imagePixel(v, 40, 70));
  });
  it('handles empty layouts without selecting a pixel', () => {
    expect(imagePixel({ ...v, width: 0 }, 0, 0)).toBeNull();
  });
});
