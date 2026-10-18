// Touch wording of hints ("click" → "tap"…), used on phones and tablets.
import { toTouchWording as t } from "../src/shared/wording";
import { FILTER_LIST } from "../src/shared/filters";

let fail = 0;
const ok = (name: string, got: string, want: string) => { const pass = got === want; console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!pass) fail++; };

ok("click", t("Hint: click to add points, drag to move them, double click to remove."), "Hint: tap to add points, drag to move them, double-tap to remove.");
ok("capitalized", t("Click on the Viewer to add vertices."), "Tap on the Viewer to add vertices.");
ok("double-click with hyphen", t("double-click a filter"), "double-tap a filter");
ok("Double click capitalized", t("Double click to configure"), "Double-tap to configure");
ok("right click", t("Right click for more"), "Long-press for more");
ok("endings", t("clicking, clicked, clicks, double-clicking, right-clicked"), "tapping, tapped, taps, double-tapping, long-pressed");
ok("clockwise is not a click", t("the four corners in clockwise order"), "the four corners in clockwise order");
ok("mouse wheel sentence", t("Click or drag on the navigator to move the view. Mouse wheel on the Viewer zooms around the cursor."), "Tap or drag on the navigator to move the view. Pinch the Viewer to zoom.");
ok("crosshair sentence", t("Move over the Viewer to show the crosshair; click to lock it (useful to compare positions across frames)."), "Drag on the Viewer to move the crosshair; tap to lock or unlock it (useful to compare positions across frames).");
ok("no change without mouse words", t("Drag the handles to crop."), "Drag the handles to crop.");

// Every filter hint reads naturally on a touch screen: no mouse vocabulary is left.
const leftovers = FILTER_LIST.filter((f) => f.hint && /\b(click|mouse|wheel|hover)\b/i.test(t(f.hint))).map((f) => f.id);
ok("filter hints contain no mouse words after rewriting", leftovers.join(","), "");

if (fail) { console.error(`wording: ${fail} failed`); process.exit(1); }
console.log("wording: all tests passed");
