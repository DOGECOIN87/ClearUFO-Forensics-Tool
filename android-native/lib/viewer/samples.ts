/** Recover an integer 16-bit sample from an unmodified decoded 0–255 Float32 sample.
 * PNG/TIFF decoders divide by 257 before storing Float32. Every 16-bit integer is
 * recoverable after that storage; do not use on processed or interpolated frames. */
export function original16BitSample(sample: number): number {
  if (!Number.isFinite(sample) || sample < 0 || sample > 255) throw new Error('Invalid unmodified 16-bit source sample');
  return Math.round(sample * 257);
}
