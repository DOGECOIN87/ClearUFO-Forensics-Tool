// Display histogram, matching the browser's 8-bit preview histogram. It is not a
// histogram of the unclamped float samples or the original file's bit depth.
import { toRGBA8, type Frame } from './frame';

export interface DisplayHistogram {
  hist: Uint32Array; // R, G, B, BT.601 luma; the fifth 256-bin plane is unused
  low: number;
  high: number;
}

export function displayHistogram(frame: Frame): DisplayHistogram {
  const rgba = toRGBA8(frame);
  const hist = new Uint32Array(5 * 256);
  let low = 0, high = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    hist[r]++; hist[256 + g]++; hist[512 + b]++;
    hist[768 + ((r * 299 + g * 587 + b * 114 + 500) / 1000 | 0)]++;
    if (r === 0 || g === 0 || b === 0) low++;
    if (r === 255 || g === 255 || b === 255) high++;
  }
  return { hist, low, high };
}
