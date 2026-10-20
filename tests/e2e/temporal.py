"""Temporal Smoothing on real compressed video, through the real UI and engine in headless Chromium.

Usage: URL=http://localhost:5173/ python3 tests/e2e/temporal.py [media_dir]   (needs vp9_opus.webm from make_media.py)
Optional: OUTDIR=/tmp/lucid-temporal saves screenshots of the settings panel and of Show Protected Areas.

Checks: the filter is added with its documented defaults; frame count, size, frame rate and timestamps are unchanged;
Mean without protection equals Frame Averaging's Moving Window frame for frame; without protection moving content
is smeared (ghosts), with protection nothing is (testsrc2's moving shapes and rainbow band include changes of color
at the same brightness); Show Protected Areas marks the moving parts; every method renders; no page errors.
"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright

URL = os.environ.get("URL", "http://localhost:5173/")
MEDIA = sys.argv[1] if len(sys.argv) > 1 else "/tmp/lucid-testmedia"
OUT = os.environ.get("OUTDIR", "")
results = []

def check(name, ok, info=""):
    results.append(bool(ok)); print(("PASS " if ok else "FAIL ") + name + (f"  [{info}]" if info != "" else ""), flush=True)

# renders one frame of a filter's output; keeps its RGBA in the page under `keep` for the comparisons below
RENDER = """async ([chainId, filterId, frame, keep]) => {
  const r = await window.lucid.engine.call('render', { chainId, filterId, frame, channel: 'ts-' + Math.random(), want: { hash: true } });
  if (!r.ok) return { ok: false, error: r.error };
  if (keep) { window.__px = window.__px || {}; window.__px[keep] = r.rgba; }
  return { ok: true, w: r.width, h: r.height, n: r.info.frameCount, fps: r.info.fps, md5: r.md5, ms: r.ms, pts: r.meta.pts } }"""
# mean absolute difference and share of pixels off by more than 20 levels in some channel
DIFF = """([k1, k2]) => { const a = window.__px[k1], b = window.__px[k2]; let s = 0, n = 0, big = 0;
  for (let p = 0; p < a.length; p += 4) { let m = 0; for (let c = 0; c < 3; c++) { const d = Math.abs(a[p + c] - b[p + c]); s += d; n++; if (d > m) m = d; } if (m > 20) big++; }
  return { mad: +(s / n).toFixed(3), bigPct: +(100 * big / (a.length / 4)).toFixed(3) } }"""
# Show Protected Areas draws the image in gray with the protected pixels in red: share of red pixels, and whether
# every other pixel is gray (G = B and R = G within the 8-bit rounding)
TINT = """(k) => { const a = window.__px[k]; let t = 0, gray = true;
  for (let p = 0; p < a.length; p += 4) { const red = a[p] - a[p + 1]; if (red > 3 && Math.abs(a[p + 1] - a[p + 2]) <= 1) t++; else if (Math.abs(red) > 1 || Math.abs(a[p + 1] - a[p + 2]) > 1) gray = false; }
  return { pct: +(100 * t / (a.length / 4)).toFixed(2), gray } }"""
CHAIN = "(() => { const c = window.lucid.store.chain(); return { id: c.id, loader: c.filters[0].id } })()"
FIND = "(t) => window.lucid.store.chain().filters.find((f) => f.type === t)"

async def pick(pg, files):
    async with pg.expect_file_chooser() as fc:
        await pg.evaluate("(()=>{ window.lucid.actions.openMedia(); return null })()")
    await (await fc.value).set_files(files)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL, wait_until="load")
        await pg.wait_for_function("() => !!(window.lucid && window.lucid.store && window.lucid.actions && window.lucid.engine)", timeout=30000)
        await pg.evaluate("window.lucid.store.setDirty(false); window.lucid.newProject()")
        await pick(pg, [f"{MEDIA}/vp9_opus.webm"])
        await pg.wait_for_function("() => { const r = window.lucid.store.lastRender; return r && r.info && r.info.frameCount === 50 }", timeout=30000)

        # chain A: Video Loader -> Temporal Smoothing (plain moving average to start with)
        c0 = await pg.evaluate(CHAIN)
        await pg.evaluate("([l, c]) => { window.lucid.store.selectFilter(l, c); window.lucid.actions.addFilter('temporal_smoothing', { size: 5, method: 'mean', protect: false }) }", [c0["loader"], c0["id"]])
        ts = await pg.evaluate(FIND, "temporal_smoothing")
        check("added with the documented defaults", ts and ts["params"]["threshold"] == 12 and ts["params"]["showMask"] is False, json.dumps(ts and ts["params"]))
        tsid = ts["id"]
        src = await pg.evaluate(RENDER, [c0["id"], c0["loader"], 25, "in25"])
        out = await pg.evaluate(RENDER, [c0["id"], tsid, 25, "plain25"])
        ends = [await pg.evaluate(RENDER, [c0["id"], tsid, f, None]) for f in (0, 49)]
        check("same frame count, size, frame rate and timestamps", out["ok"] and out["n"] == src["n"] == 50 and (out["w"], out["h"]) == (src["w"], src["h"]) and out["fps"] == src["fps"] and out["pts"] == src["pts"] and all(e["ok"] for e in ends),
              f"{out.get('w')}x{out.get('h')}, {out.get('n')} frames @ {out.get('fps')} fps")

        # chain B (copy): Video Loader -> Frame Averaging (Moving Window), compared frame for frame
        await pg.evaluate("(id) => window.lucid.actions.duplicateChain(id)", c0["id"])
        c1 = await pg.evaluate(CHAIN)
        await pg.evaluate("([l, c]) => { window.lucid.store.selectFilter(l, c); window.lucid.actions.addFilter('frame_averaging', { mode: 'window', window: 5, method: 'mean' }) }", [c1["loader"], c1["id"]])
        fa = (await pg.evaluate(FIND, "frame_averaging"))["id"]
        same = 0
        for f in (2, 10, 25, 37, 49):
            x = await pg.evaluate(RENDER, [c0["id"], tsid, f, None]); y = await pg.evaluate(RENDER, [c1["id"], fa, f, None])
            same += x["md5"] == y["md5"]
        check("Mean without protection == Frame Averaging moving window", same == 5, f"{same}/5 frames identical")

        # ghosts on real motion
        await pg.evaluate("(id) => window.lucid.store.setUi({ chainId: id })", c0["id"])
        plain = await pg.evaluate(DIFF, ["plain25", "in25"])
        await pg.evaluate("(id) => window.lucid.actions.setParam(id, 'protect', true)", tsid)
        await pg.evaluate(RENDER, [c0["id"], tsid, 25, "prot25"])
        prot = await pg.evaluate(DIFF, ["prot25", "in25"])
        check("without protection moving content is smeared", plain["bigPct"] > 2, f"{plain['bigPct']}% of pixels off by >20 levels, MAD {plain['mad']}")
        check("with protection no ghosts, color changes included", prot["bigPct"] < 0.2 and prot["mad"] < plain["mad"] / 4, f"{prot['bigPct']}% of pixels off by >20 levels, MAD {prot['mad']}")
        await pg.evaluate("(id) => window.lucid.actions.setParam(id, 'showMask', true)", tsid)
        await pg.evaluate(RENDER, [c0["id"], tsid, 25, "mask25"])
        tint = await pg.evaluate(TINT, "mask25")
        check("Show Protected Areas: moving parts in red on a gray image", 1 < tint["pct"] < 60 and tint["gray"], f"{tint['pct']}% of the frame marked, rest gray: {tint['gray']}")
        if OUT:
            os.makedirs(OUT, exist_ok=True)
            await pg.evaluate("([id, c]) => window.lucid.store.selectFilter(id, c)", [tsid, c0["id"]])
            await pg.wait_for_timeout(2500); await pg.screenshot(path=f"{OUT}/temporal_mask.png")
        await pg.evaluate("(id) => window.lucid.actions.setParam(id, 'showMask', false)", tsid)
        if OUT:
            await pg.wait_for_timeout(2500); await pg.screenshot(path=f"{OUT}/temporal_settings.png")
        for m in ("gaussian", "median"):
            await pg.evaluate("([id, m]) => window.lucid.actions.setParam(id, 'method', m)", [tsid, m])
            r = await pg.evaluate(RENDER, [c0["id"], tsid, 25, None])
            check(f"method {m} renders", r["ok"], f"{r.get('ms', 0):.0f} ms at {src['w']}x{src['h']}")
        check("no uncaught page errors", not errors, "; ".join(errors)[:300])
        await b.close()
    print(f"\n{sum(results)}/{len(results)} checks passed")
    sys.exit(0 if all(results) else 1)

asyncio.run(main())
