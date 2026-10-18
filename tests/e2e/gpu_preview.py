"""WebGPU preview (display only) against the exact engine results.

Usage:
  URL=http://127.0.0.1:5199/ python3 tests/e2e/gpu_preview.py

Needs the dev server (imports src modules) and a WebGPU adapter: Chromium starts with --enable-unsafe-webgpu
(SwiftShader software adapter on machines without a GPU).
  1. Shaders: every supported filter on the GPU vs the engine's exact 8-bit output of the same input:
     at most a few levels apart (32-bit GPU math vs 64-bit engine math; large blurs use a true Gaussian).
  2. Viewer: a parameter change shows the GPU preview at once (badge), the exact render replaces it.
  3. The exact path is untouched: frame hashes with and without the preview are identical.
"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright

URL = os.environ.get("URL", "http://127.0.0.1:5199/")
fails = 0
def check(name, cond, info=""):
    global fails
    print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""), flush=True)
    if not cond: fails += 1

SHADERS_JS = r"""async () => {
  const { FILTER_LIST, defaultParams } = await import("/src/shared/filters.ts");
  const { getGpu } = await import("/src/gpu/preview.ts");
  const gpu = await getGpu();
  if (!gpu) return { gpu: false };
  const e = window.lucid.engine;
  const tp = FILTER_LIST.find((f) => f.id === "test_pattern");
  const W = 640, H = 360;
  const L = { id: "L", type: "test_pattern", params: { ...defaultParams(tp), pattern: "chart", width: W, height: H, frames: 1 }, enabled: true };
  const cases = [
    ["levels", { inBlack: 20, inWhite: 230, gamma: 1.4, outBlack: 5, outWhite: 250 }, 1],
    ["levels", { channel: "g", inBlack: 40, gamma: 0.7 }, 1],
    ["curves", { curve: [{ x: 0, y: 0 }, { x: 64, y: 40 }, { x: 190, y: 220 }, { x: 255, y: 255 }] }, 1],
    ["brightness_contrast", { brightness: 18, contrast: 35 }, 1],
    ["exposure", { exposure: 0.6, gamma: 1.3, offset: 4 }, 1],
    ["negative", {}, 0],
    ["threshold", { level: 120 }, 0],
    ["threshold", { level: 90, mode: "rgb" }, 0],
    ["grayscale", {}, 1], ["grayscale", { method: "lightness" }, 1], ["grayscale", { method: "max" }, 0],
    ["enable_channels", { r: true, g: false, b: true }, 0],
    ["color_switch", { r: "b", g: "r", b: "full" }, 0],
    ["white_balance", { mode: "manual", r: 1.2, g: 0.9, b: 1.05 }, 1],
    ["hue_saturation", { hue: 35, saturation: 40, lightness: -10 }, 2],
    ["gaussian_filter", { sigma: 1.5 }, 2],
    ["unsharp_mask", { radius: 2, amount: 1.5, threshold: 3 }, 3],
    ["high_pass_sharpening", { radius: 2.5, amount: 1.2 }, 3],
  ];
  const out = [];
  for (const [type, extra, tol] of cases) {
    const f = FILTER_LIST.find((x) => x.id === type);
    const params = { ...defaultParams(f), ...extra };
    await e.call("setProject", [{ id: "g", name: "G", filters: [L, { id: "F", type, params, enabled: true }] }]);
    const exact = await e.call("render", { chainId: "g", filterId: "F", frame: 0, channel: "gpu-test" });
    const inp = await e.call("inputFrame", { chainId: "g", filterId: "F", frame: 0 });
    gpu.setInput("k" + Math.random(), inp.w, inp.h, inp.floats);
    const t0 = performance.now();
    const px = await gpu.run(type, params);
    const ms = performance.now() - t0;
    let max = 0, over = 0;
    for (let i = 0; i < px.length; i++) { const d = Math.abs(px[i] - exact.rgba[i]); if (d > max) max = d; if (d > tol) over++; }
    out.push({ type, extra, tol, max, over, n: px.length, ms: Math.round(ms) });
  }
  window.lucid.store.syncEngine();
  return { gpu: true, label: gpu.label, out };
}"""

VIEWER_JS = r"""async () => {
  const s = window.lucid.store, a = window.lucid.actions, e = window.lucid.engine;
  const { FILTER_LIST, defaultParams } = await import("/src/shared/filters.ts");
  const badge = () => { const b = document.querySelector(".gpu-badge"); return !!b && !b.hidden; };
  const md5 = async () => { const c = s.project.chains[0]; const r = await e.call("render", { chainId: c.id, filterId: null, frame: 0, channel: "hash", want: { hash: true } }); return r.md5; };
  // An unsharp mask at 1080p, plus a second chain whose non-local means keeps the engine busy while the parameter
  // changes: the exact frame then arrives late for certain, whatever the speed of the (possibly software) GPU.
  const tp = FILTER_LIST.find((f) => f.id === "test_pattern"), um = FILTER_LIST.find((f) => f.id === "unsharp_mask"), nl = FILTER_LIST.find((f) => f.id === "nl_means");
  s.setDirty(false); window.lucid.newProject();
  await new Promise((r) => setTimeout(r, 300));
  const chain = { id: "cv", name: "Viewer test", filters: [
    { id: "L1", type: "test_pattern", params: { ...defaultParams(tp), pattern: "plate", width: 1920, height: 1080, frames: 1 }, enabled: true },
    { id: "U1", type: "unsharp_mask", params: { ...defaultParams(um), radius: 2, amount: 1.2 }, enabled: true }] };
  const busy = { id: "cb", name: "Busy", filters: [
    { id: "L2", type: "test_pattern", params: { ...defaultParams(tp), pattern: "chart", width: 1920, height: 1080, frames: 1 }, enabled: true },
    { id: "N2", type: "nl_means", params: { ...defaultParams(nl), search: 7 }, enabled: true }] };
  s.project.chains = [chain, busy]; s.syncEngine(); s.setUi({ chainId: "cv", selected: { cv: "U1" } });
  window.lucid.openViewer("cv");
  const t0 = performance.now();
  while (!(s.lastRender && s.lastRender.filterId === "U1") && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 100));
  const before = await md5();
  await new Promise((r) => setTimeout(r, 2500));  // the viewer uploads the filter input to the GPU after the exact render
  await e.call("render", { chainId: "cb", filterId: "L2", frame: 0, channel: "busy" });   // its input, cached
  await e.call("setThreads", 1);
  void e.call("render", { chainId: "cb", filterId: null, frame: 0, channel: "busy" });     // seconds of work, one thread
  await new Promise((r) => setTimeout(r, 150));
  // parameter change: the preview must appear before the exact frame arrives
  let sawBadge = false, badgeAt = null;
  const t1 = performance.now();
  a.setParam("U1", "amount", 2.4);
  while (performance.now() - t1 < 60000) {
    if (badge() && !sawBadge) { sawBadge = true; badgeAt = Math.round(performance.now() - t1); }
    if (sawBadge && !badge()) break;
    await new Promise((r) => setTimeout(r, 15));
  }
  const replacedAt = Math.round(performance.now() - t1);
  await e.call("setThreads", 0);
  await new Promise((r) => setTimeout(r, 300));
  const after = await md5();
  a.setParam("U1", "amount", 1.2);
  await new Promise((r) => setTimeout(r, 200));
  while (badge() && performance.now() - t1 < 90000) await new Promise((r) => setTimeout(r, 50));
  const back = await md5();
  return { sawBadge, badgeAt, replacedAt, badgeGone: !badge(), before, after, back };
}"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox", "--enable-unsafe-webgpu"])
        pg = await b.new_page(viewport={"width": 1568, "height": 898})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL, wait_until="load")
        await pg.wait_for_function("() => !!(window.lucid && window.lucid.engine)", timeout=30000)
        await pg.wait_for_timeout(800)
        r = await pg.evaluate(SHADERS_JS)
        check("WebGPU adapter available", r.get("gpu"), r.get("label", ""))
        if r.get("gpu"):
            for c in r["out"]:
                check(f"GPU {c['type']} {json.dumps(c['extra'])} within {c['tol']} level(s) of the exact result", c["over"] == 0, f"max diff {c['max']}, {c['over']} samples over, {c['ms']} ms")
            v = await pg.evaluate(VIEWER_JS)
            check("parameter change shows the GPU preview before the exact frame", v["sawBadge"], f"badge after {v['badgeAt']} ms")
            check("the exact render replaces the preview", v["badgeGone"], f"replaced after {v['replacedAt']} ms")
            check("exact frame hashes unaffected by the preview (new parameters differ, reverting restores the hash)", v["before"] != v["after"] and v["back"] == v["before"], json.dumps({k: v[k] for k in ("before", "after", "back")}))
        check("no page errors", not errors, "; ".join(errors)[:300])
        await b.close()
    print(f"\n{'ALL PASS' if not fails else str(fails) + ' FAILED'}")
    sys.exit(1 if fails else 0)

asyncio.run(main())
