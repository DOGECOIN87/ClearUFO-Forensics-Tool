import { describe, expect, it } from 'vitest';
import { histReference, toU8Reference } from '../../../src/engine/wasm/px';
import { displayHistogram } from '@/lib/engine/histogram';

describe('display histogram conformance', () => {
  it('matches the browser after float-to-display conversion, including ties and clipping', () => {
    const d = new Float32Array([
      -1, 0.5, 1.5, 255, 254.5, 255.5, NaN, 0,
      Infinity, -Infinity, 42.5, 128, 123.4, 45.6, 78.9, 1,
    ]);
    const rgba = new Uint8ClampedArray(d.length);
    toU8Reference(d, rgba);
    expect(displayHistogram({ w: 4, h: 1, d })).toEqual(histReference(rgba));
  });
  it('matches for an empty frame', () => {
    expect(displayHistogram({ w: 0, h: 0, d: new Float32Array() })).toEqual(histReference(new Uint8ClampedArray()));
  });
});
