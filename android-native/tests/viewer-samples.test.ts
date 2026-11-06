import { describe, expect, it } from 'vitest';
import { original16BitSample } from '@/lib/viewer/samples';
import { encodePNG } from '@/lib/codecs/image';
import { decodeStill } from '@/lib/codecs/still';
import { verifySavedBytes } from '@/lib/codecs/verify';

describe('source-depth readout', () => {
  it('recovers every 16-bit integer after the decoder’s Float32 storage', () => {
    for (let i = 0; i <= 65535; i++) expect(original16BitSample(Math.fround(i / 257))).toBe(i);
  });
  it('recovers unfiltered samples from a 16-bit PNG', () => {
    const samples = new Uint16Array([1, 257, 65534, 32768, 0, 65535]);
    const decoded = decodeStill(encodePNG(2, 1, samples));
    expect(decoded.depth).toBe(16);
    expect([0, 1, 2, 4, 5, 6].map(i => original16BitSample(decoded.frame.d[i]))).toEqual(Array.from(samples));
  });
  it('rejects values outside the source domain', () => {
    expect(() => original16BitSample(NaN)).toThrow();
    expect(() => original16BitSample(-1)).toThrow();
    expect(() => original16BitSample(256)).toThrow();
  });
});
describe('saved export verification', () => {
  it('checks both bytes and length', () => {
    const expected = new Uint8Array([0, 100, 255]);
    expect(() => verifySavedBytes(expected, new Uint8Array([0, 100, 255]))).not.toThrow();
    expect(() => verifySavedBytes(expected, new Uint8Array([0, 100, 254]))).toThrow(/byte 2/);
    expect(() => verifySavedBytes(expected, new Uint8Array([0, 100]))).toThrow(/2 bytes; expected 3/);
  });
});
