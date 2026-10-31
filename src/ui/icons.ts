// UI icons: VS Code Codicons (16 px grid, monochrome, currentColor), so LUCID reads like an IDE.
// Forensic tools Codicons has no glyph for (selection, ruler, polygon, crosshair) are drawn on the same grid with
// the same 1 px line weight. Codicons © Microsoft Corporation, CC BY 4.0 — regenerate with `npm run icons`.
import { CODICONS as C } from "./codicons";

/** A glyph on the Codicon grid: 16 × 16 units, 1 unit strokes (1 px at the native 16 px size), rounded ends. */
const G = (body: string) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const I = {
  // ---- main toolbar
  newProject: C["new-file"],
  open: C["folder-opened"],
  save: C["save"],
  writeVideo: C["device-camera-video"],
  info: C["info"],
  dvr: C["file-binary"],
  report: C["output"],
  undo: C["discard"],
  redo: C["redo"],
  settings: C["settings-gear"],

  // ---- tools
  pointer: C["cursor"],
  zoom: C["zoom-in"],
  histogram: C["graph"],
  fileInfo: C["info"],
  clock: C["clockface"],
  // dashed selection rectangle
  selector: G(`<path d="M2.5 5.5v-2h2M6.75 3.5h2.5M11.5 3.5h2v2M13.5 7.5v1M13.5 10.5v2h-2M9.25 12.5h-2.5M4.5 12.5h-2v-2M2.5 8.5v-1"/>`),
  // diagonal ruler with ticks
  ruler: G(`<path d="M1.5 11.5l10-10 3 3-10 10z"/><path d="M3.5 9.5l1 1M5.5 7.5l1.5 1.5M7.5 5.5l1 1M9.5 3.5l1.5 1.5"/>`),
  // polygon with vertex handles
  polygon: G(`<path d="M4 13 2 6.5 8 2.5l6 4-2 6.5z"/><g fill="currentColor" stroke="none"><circle cx="4" cy="13" r="1.25"/><circle cx="2" cy="6.5" r="1.25"/><circle cx="8" cy="2.5" r="1.25"/><circle cx="14" cy="6.5" r="1.25"/><circle cx="12" cy="13" r="1.25"/></g>`),
  curve: C["graph-line"],
  // reticle (lines on pixel centers, like Codicons' own crosses)
  crosshair: G(`<circle cx="7.5" cy="7.5" r="4.5"/><path d="M7.5 1v4M7.5 10v4M1 7.5h4M10 7.5h4"/>`),

  // ---- player
  playGear: C["settings"],
  play: C["play"],
  pause: C["debug-pause"],
  stop: C["debug-stop"],
  first: C["x-first-frame"],
  last: C["x-last-frame"],
  prev: C["debug-reverse-continue"],
  next: C["debug-continue"],
  snapshot: C["device-camera"],
  folder: C["export"],
  bookmark: C["bookmark"],
  reset: C["debug-restart"],
  speaker: C["unmute"],
  mute: C["mute"],
  loopIcon: C["sync"],

  // ---- misc
  close: C["close"],
  link: C["link"],
  loader: C["file-media"],
  caretDown: C["chevron-down"],
  caretRight: C["chevron-right"],
  check: C["check"],
  swap: C["arrow-swap"],
  help: C["question"],
  resetList: C["debug-restart"],
  arrowLeft: C["arrow-left"],
  arrowRight: C["arrow-right"],
  pencil: C["edit"],
  trash: C["trash"],
  plus: C["add"],
  minus: C["remove"],
  fullscreen: C["screen-full"],
  windowMin: C["chrome-minimize"],
  windowMax: C["chrome-maximize"],
  menu: C["ellipsis"],
  // ---- AI assistant
  ai: C["sparkle"],
  send: C["send"],
  image: C["file-media"],
  loading: C["loading"],
};

export type IconName = keyof typeof I;

/** Brand mark: the ClearUFO badge (black and white saucer in a ringed circle, after the channel logo).
 *  From 44 px up it carries the CLEARUFO banner and starfield; smaller sizes keep only the saucer so it stays legible. */
export function logoSvg(size = 32): string {
  const big = size >= 44;
  const cy = big ? 0 : 5; // centre the saucer when there is no banner
  const stars = big ? `<g fill="none" stroke="#000" stroke-width="0.7"><circle cx="16" cy="14" r="1.3"/><circle cx="44" cy="10" r="1"/><circle cx="51" cy="20" r="1.2"/><circle cx="12" cy="31" r="0.9"/><circle cx="52" cy="35" r="1"/></g><g fill="#000"><circle cx="22" cy="10" r="0.5"/><circle cx="38" cy="8" r="0.45"/><circle cx="10" cy="22" r="0.45"/><circle cx="55" cy="27" r="0.5"/><circle cx="47" cy="40" r="0.45"/></g>` : "";
  const banner = big ? `<path d="M7 40.5h50l-1.6 11.5H8.6z" fill="#000"/><path d="M8.6 41.6h46.8" stroke="#fff" stroke-width="0.5"/><text x="32" y="50.4" text-anchor="middle" font-family="Impact, Haettenschweiler, 'Arial Narrow Bold', 'Arial Black', sans-serif" font-weight="900" font-size="10.4" textLength="42" lengthAdjust="spacingAndGlyphs" fill="#fff" stroke="#fff" stroke-width="0.2">CLEARUFO</text>` : "";
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true"><circle cx="32" cy="32" r="31.5" fill="#000"/><circle cx="32" cy="32" r="29" fill="#fff"/><circle cx="32" cy="32" r="26.6" fill="none" stroke="#000" stroke-width="${big ? 1.4 : 2.2}"/>${stars}<g transform="translate(0 ${cy})"><path d="M25 31h14l5 13H20z" fill="#c9c9c9"/><path d="M28 32l-2.5 11M32 32v11.5M36 32l2.5 11" stroke="#fff" stroke-width="1"/><path d="M21.5 25.5a10.5 9.5 0 0 1 21 0z" fill="#000"/><ellipse cx="27.6" cy="20.6" rx="2.4" ry="1.3" transform="rotate(-28 27.6 20.6)" fill="#fff"/><ellipse cx="32" cy="28" rx="23" ry="5.6" fill="#000"/><path d="M12.5 26.6q19.5-4.4 39 0" fill="none" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/><ellipse cx="32" cy="32" rx="9.5" ry="2.1" fill="#3a3a3a"/></g>${banner}</svg>`;
}
