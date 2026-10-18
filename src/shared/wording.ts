// Mouse wording of hints and messages rewritten for touch screens.
// Pure function (no DOM) so it can be unit tested; the UI calls it through touchText() in ui/touch.ts.

const SENTENCES: [RegExp, string][] = [
  [/Mouse wheel on the Viewer zooms around the cursor\./g, "Pinch the Viewer to zoom."],
  [/Move over the Viewer to show the crosshair; click to lock it/g, "Drag on the Viewer to move the crosshair; tap to lock or unlock it"],
];

function inflect(base: string, ending: string): string {
  if (!ending) return base;
  if (ending === "s") return base.endsWith("ss") ? `${base}es` : `${base}s`;
  return base.endsWith("tap") ? `${base}p${ending}` : `${base}${ending}`; // tapped, tapping, long-pressed
}

/**
 * "click" → "tap", "double click" / "double-click" → "double-tap", "right click" → "long-press".
 * Capitalization and the -s / -ed / -ing endings are preserved; words such as "clockwise" are untouched.
 */
export function toTouchWording(text: string): string {
  let out = text;
  for (const [re, rep] of SENTENCES) out = out.replace(re, rep);
  return out.replace(/\b(?:(double|right)[- ])?click(s|ed|ing)?\b/gi, (m: string, pre: string | undefined, end: string | undefined) => {
    const base = !pre ? "tap" : pre.toLowerCase() === "double" ? "double-tap" : "long-press";
    const word = inflect(base, (end ?? "").toLowerCase());
    return m[0] === m[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word;
  });
}
