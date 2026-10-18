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

/** Brand mark: rounded square with stylized initials (configurable in brand.ts). */
export function logoSvg(letters: string, size = 32): string {
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2fb3ff"/><stop offset="1" stop-color="#0a6fd6"/></linearGradient></defs><rect x="2" y="2" width="60" height="60" rx="13" fill="url(#lg)"/><text x="32" y="44" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="31" fill="#fff" font-style="italic" letter-spacing="-2">${letters}</text></svg>`;
}
