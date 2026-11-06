/** Verify the bytes read from a saved file, not just its length or sample hash. */
export function verifySavedBytes(expected: Uint8Array, actual: Uint8Array): void {
  if (expected.length !== actual.length) throw new Error(`Saved file read-back has ${actual.length} bytes; expected ${expected.length}.`);
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) throw new Error(`Saved file read-back differs at byte ${i}; the export is not verified.`);
  }
}
