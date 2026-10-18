// Touch helpers. Mobile browsers do not reliably turn finger input into `dblclick` and
// `contextmenu` events (iOS Safari fires neither, Chrome only when double-tap zoom is off),
// so double-tap and long-press are recognized here from Pointer Events and routed to the same
// handlers as the mouse gestures. Mouse input keeps using the native events untouched.

import { toTouchWording } from "../shared/wording";

const DOUBLE_TAP_MS = 380;
const DOUBLE_TAP_SLOP = 30;
const LONG_PRESS_MS = 520;
const MOVE_SLOP = 10;

let lastTap: { key: string; t: number; x: number; y: number } | null = null;
let suppressDblUntil = 0;
let suppressClickUntil = 0;
let lastLongPress = 0;
let lastTouchDown = 0;

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") lastTouchDown = performance.now(); }, true);
  // A long-press menu appears under the finger: swallow the click the release may generate.
  window.addEventListener("click", (e) => { if (performance.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); } }, true);
}

/** True when the primary input is a finger (phones, tablets). */
export function isCoarsePointer(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/** True on touch devices or while a compact (small screen) layout is active. */
export function isTouchUi(): boolean {
  const layout = typeof document !== "undefined" ? document.documentElement.dataset.layout : undefined;
  return isCoarsePointer() || (!!layout && layout !== "desktop");
}

/**
 * Pointer capture that never throws: browsers raise NotFoundError / InvalidStateError when the pointer is
 * already released (very short taps) or unknown, and an exception must not abort the gesture.
 */
export function capturePointer(el: Element, pointerId: number) {
  try { el.setPointerCapture(pointerId); } catch { /* capture is an optimization only */ }
}

/** Hint or message text with mouse wording ("click", "right click"…) rewritten for touch screens. */
export function touchText(text: string): string { return isTouchUi() ? toTouchWording(text) : text; }

/**
 * True shortly after a finger/pen touched the screen. Browsers emulate mouse events after a tap
 * (mouseover/mouseenter before the click), so hover behaviors must ignore them.
 */
export function recentTouch(ms = 1000): boolean { return performance.now() - lastTouchDown < ms; }

/** Suppresses clicks for `ms` milliseconds. */
export function suppressNextClick(ms = 700) { suppressClickUntil = performance.now() + ms; }

/**
 * Swallows the click that a finger release may generate after a long press opened a menu
 * under it: clicks are ignored until the finger is lifted (plus a short grace period).
 */
function armClickGuard() {
  suppressClickUntil = Number.POSITIVE_INFINITY;
  const end = () => {
    suppressClickUntil = performance.now() + 450;
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
  };
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
}

/**
 * Calls `fn` on double click (mouse) or double tap (touch / pen). `key` identifies the logical
 * target, so the gesture survives re-rendering of the element between the two taps.
 */
export function onDoubleActivate(el: HTMLElement, key: string, fn: (ev: MouseEvent) => void) {
  el.addEventListener("dblclick", (ev) => { if (performance.now() < suppressDblUntil) return; fn(ev); });
  el.addEventListener("pointerup", (ev) => {
    if (ev.pointerType === "mouse" || ev.button > 0) return;
    const now = performance.now();
    if (now - lastLongPress < 600) return;
    if (lastTap && lastTap.key === key && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < DOUBLE_TAP_SLOP) {
      lastTap = null;
      suppressDblUntil = now + 600;
      fn(ev);
    } else lastTap = { key, t: now, x: ev.clientX, y: ev.clientY };
  });
}

/**
 * Context menu from a right click (mouse), the platform long-press `contextmenu` event (Android)
 * or a recognized long press (iOS and every other touch browser). `fn` receives client coordinates.
 */
export function onContextMenu(el: HTMLElement, fn: (x: number, y: number) => void) {
  let timer = 0, fired = false;
  let detach: (() => void) | null = null;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = 0; } detach?.(); detach = null; };
  el.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    cancel();
    if (fired || performance.now() - lastLongPress < 800) return; // already opened by the long press
    fn(ev.clientX, ev.clientY);
  });
  el.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse") return;
    cancel();
    fired = false;
    const sx = ev.clientX, sy = ev.clientY, pid = ev.pointerId;
    // Listen on the window: the element may be re-rendered while the finger is down.
    const move = (e: PointerEvent) => { if (e.pointerId === pid && Math.hypot(e.clientX - sx, e.clientY - sy) > MOVE_SLOP) cancel(); };
    const up = (e: PointerEvent) => { if (e.pointerId === pid) cancel(); };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    detach = () => { window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", up, true); window.removeEventListener("pointercancel", up, true); };
    timer = window.setTimeout(() => {
      timer = 0; detach?.(); detach = null;
      fired = true; lastLongPress = performance.now();
      armClickGuard();
      try { navigator.vibrate?.(12); } catch { /* not allowed */ }
      fn(sx, sy);
    }, LONG_PRESS_MS);
  });
}

/** Records a long press handled elsewhere (e.g. the Viewer) so platform duplicates are ignored. */
export function noteLongPress() { lastLongPress = performance.now(); armClickGuard(); }

/** Time of the last recognized long press (ms, performance clock). */
export function lastLongPressTime() { return lastLongPress; }
