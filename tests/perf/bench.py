"""LUCID performance benchmark (headless Chromium against a running dev server or build).

  URL=http://127.0.0.1:5199/ python3 tests/perf/bench.py [--video clip.webm] [--json out.json] [--only filters,sample,video,display]

Measures, inside the real engine worker:
  filters  every processing filter on a 1920x1080 test pattern (median ms per frame of 5, warm JIT, inputs cached)
  sample   the 7-step sample case: per-step cost of the first render (cold cache)
  video    a video file through the loader: decode + conversion per frame, sequential (playback order)
  display  round trip of an already computed 1080p frame: 8-bit conversion, histogram, transfer, canvas draw
Timings are medians of the measured runs; the machine and browser are printed with the results."""
import argparse, asyncio, json, os, statistics, sys, time
from playwright.async_api import async_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--video", default=None)
ap.add_argument("--json", default=None)
ap.add_argument("--only", default="filters,sample,video,display")
ap.add_argument("--size", default="1920x1080")
ap.add_argument("--filters", default="", help="comma separated filter ids (default: all)")
ap.add_argument("--threads", type=int, default=-1, help="processing threads for the run (0 = automatic, 1 = single thread; default: leave as is)")
ap.add_argument("--cache", type=int, default=600, help="engine frame cache limit in MB for the filter run (keep well below the machine's RAM)")
args = ap.parse_args()
URL = os.environ.get("URL", "http://127.0.0.1:5199/")
W, H = (int(v) for v in args.size.split("x"))
ONLY = set(args.only.split(","))

FILTERS_JS = r"""async ({ W, H, only, cache }) => {
  const { FILTER_LIST, defaultParams } = await import("/src/shared/filters.ts");
  const e = window.lucid.engine;
  await e.call("setCacheLimit", cache);
  const tp = FILTER_LIST.find((f) => f.id === "test_pattern");
  const sx = W / 320, sy = H / 180;
  const R = (x, y, w, h) => ({ x: Math.round(x * sx), y: Math.round(y * sy), w: Math.round(w * sx), h: Math.round(h * sy) });
  const special = { crop: { rect: R(40, 20, 200, 120) }, hide_selection: { rect: R(100, 60, 80, 50) }, spotlight: { rect: R(100, 60, 80, 50) },
    magnify: { rect: R(120, 70, 60, 40) }, local_stabilization: { roi: R(100, 50, 120, 80) }, perspective: {}, };
  const skip = new Set(["image_loader", "video_loader", "sequence_loader", "test_pattern", "video_writer", "image_writer", "add_logo"]);
  const loader = { id: "Lb", type: "test_pattern", params: { ...defaultParams(tp), pattern: "plate", width: W, height: H, frames: 6, seed: 3 }, enabled: true };
  const other = { id: "other", name: "Other", filters: [{ id: "Lother", type: "test_pattern", params: { ...defaultParams(tp), pattern: "bars", width: W, height: H, frames: 6 }, enabled: true }] };
  // warm the loader frames (cached for every filter below)
  await e.call("setProject", [{ id: "cl", name: "L", filters: [loader] }, other]);
  for (let i = 0; i < 6; i++) await e.call("render", { chainId: "cl", filterId: null, frame: i, channel: "bench" });
  await e.call("render", { chainId: "other", filterId: null, frame: 2, channel: "bench" });
  const out = {};
  for (const f of FILTER_LIST) {
    if (skip.has(f.id) || (only.length && !only.includes(f.id))) continue;
    const params = { ...defaultParams(f), ...(special[f.id] || {}) };
    const chain = { id: "c_" + f.id, name: f.name, filters: [loader, { id: "F" + f.id, type: f.id, params, enabled: true }] };
    await e.call("setProject", [chain, other]);
    const times = [];
    let err = null;
    for (const fr of [0, 1, 2, 3, 4, 5]) {   // frame 0 warms the JIT; frames 1..5 are measured (median)
      const t0 = performance.now();
      const r = await e.call("render", { chainId: chain.id, filterId: null, frame: fr, channel: "bench" });
      const wall = performance.now() - t0;
      if (!r.ok) { err = r.error; break; }
      times.push({ ms: r.ms, wall, w: r.width, h: r.height });
    }
    const med = (a) => { const v = [...a].sort((x, y) => x - y); return v[v.length >> 1]; };
    out[f.id] = err ? { error: err } : { first: times[0].ms, ms: med(times.slice(1).map((t) => t.ms)), wall: med(times.slice(1).map((t) => t.wall)), out: `${times[0].w}x${times[0].h}`, category: f.category, name: f.name };
    console.log("BENCH " + f.id + " " + (err ? "ERROR " + err : out[f.id].ms.toFixed(1) + " ms (wall " + out[f.id].wall.toFixed(1) + ")"));
  }
  window.lucid.store.syncEngine();
  return out;
}"""

SAMPLE_JS = r"""async () => {
  const s = window.lucid.store, e = window.lucid.engine;
  await window.lucid.actions.loadSampleProject();
  await new Promise((r) => setTimeout(r, 300));
  const chain = s.project.chains[0];
  await e.call("clearCache");
  await e.call("setProject", s.project.chains);
  const steps = [];
  let prev = 0;
  for (let k = 0; k < chain.filters.length; k++) {
    const f = chain.filters[k];
    const t0 = performance.now();
    const r = await e.call("render", { chainId: chain.id, filterId: f.id, frame: 0, channel: "bench" });
    const wall = performance.now() - t0;
    steps.push({ step: k, type: f.type, name: f.name || f.type, ms: r.ms, wall, size: `${r.width}x${r.height}`, ok: r.ok });
  }
  const t0 = performance.now();
  await e.call("clearCache"); await e.call("setProject", s.project.chains);
  const r = await e.call("render", { chainId: chain.id, filterId: null, frame: 0, channel: "bench" });
  const total = performance.now() - t0;
  return { steps, total, md5: r.md5 ?? null, size: `${r.width}x${r.height}` };
}"""

VIDEO_JS = r"""async ({ n }) => {
  const s = window.lucid.store, e = window.lucid.engine;
  await new Promise((r) => setTimeout(r, 2500));  // let background start-up work (kernel workers) finish
  const chain = s.project.chains[s.project.chains.length - 1];
  const info = await e.call("streamInfo", chain.id, null, false);
  await e.call("clearCache"); await e.call("setProject", s.project.chains);
  const per = [];
  const t0 = performance.now();
  const count = Math.min(n, info.frameCount);
  for (let i = 0; i < count; i++) {
    const a = performance.now();
    const r = await e.call("render", { chainId: chain.id, filterId: null, frame: i, channel: "bench" });
    per.push({ ms: r.ms, wall: performance.now() - a });
  }
  const total = performance.now() - t0;
  return { frames: count, width: info.width, height: info.height, codec: info.codec, engine: info.engine, total, per };
}"""

DISPLAY_JS = r"""async () => {
  const e = window.lucid.engine;
  const { FILTER_LIST, defaultParams } = await import("/src/shared/filters.ts");
  const tp = FILTER_LIST.find((f) => f.id === "test_pattern");
  const chain = { id: "cd", name: "D", filters: [{ id: "Ld", type: "test_pattern", params: { ...defaultParams(tp), width: 1920, height: 1080, frames: 2 }, enabled: true }] };
  await e.call("setProject", [chain]);
  await e.call("render", { chainId: "cd", filterId: null, frame: 0, channel: "bench" });
  const cv = document.createElement("canvas"); cv.width = 1920; cv.height = 1080;
  const g = cv.getContext("2d");
  const rt = [], rth = [], draw = [];
  for (let k = 0; k < 6; k++) {
    let a = performance.now();
    const r = await e.call("render", { chainId: "cd", filterId: null, frame: 0, channel: "bench" });
    rt.push(performance.now() - a);
    a = performance.now();
    await e.call("render", { chainId: "cd", filterId: null, frame: 0, channel: "bench", want: { hist: true } });
    rth.push(performance.now() - a);
    a = performance.now();
    g.putImageData(new ImageData(new Uint8ClampedArray(r.rgba.buffer ?? r.rgba), 1920, 1080), 0, 0);
    draw.push(performance.now() - a);
  }
  const med = (v) => v.slice(1).sort((x, y) => x - y)[Math.floor((v.length - 1) / 2)];
  return { roundTrip: med(rt), roundTripHist: med(rth), putImageData: med(draw) };
}"""

def med(v): return statistics.median(v) if v else float("nan")

async def main():
    res = {"url": URL, "size": f"{W}x{H}", "cpus": os.cpu_count()}
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        res["browser"] = f"chromium {b.version}"
        ctx = await b.new_context(viewport={"width": 1568, "height": 898})
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: m.text.startswith("BENCH ") and print("   ", m.text[6:], flush=True))
        pg.on("crash", lambda: print("PAGE CRASHED (out of memory? lower --cache)", flush=True))
        await pg.goto(URL, wait_until="load")
        await pg.wait_for_function("() => !!(window.lucid && window.lucid.engine)", timeout=30000)
        res["hardwareConcurrency"] = await pg.evaluate("navigator.hardwareConcurrency")
        if args.threads >= 0:
            res["threads"] = await pg.evaluate("(t) => window.lucid.engine.call('setThreads', t).catch(() => null)", args.threads)
        print(f"{res['browser']} · {res['hardwareConcurrency']} logical CPUs · {URL}", flush=True)

        if "display" in ONLY:
            d = await pg.evaluate(DISPLAY_JS)
            res["display"] = d
            print(f"\nDISPLAY (1920x1080, cached frame): render round trip {d['roundTrip']:.1f} ms · with histogram {d['roundTripHist']:.1f} ms · putImageData {d['putImageData']:.1f} ms", flush=True)

        if "sample" in ONLY:
            sres = await pg.evaluate(SAMPLE_JS)
            res["sample"] = sres
            print(f"\nSAMPLE CASE (cold cache, frame 0): total {sres['total']:.0f} ms · {sres['size']}", flush=True)
            for st in sres["steps"]:
                print(f"  {st['step']}  {st['name']:<26} {st['ms']:8.1f} ms (wall {st['wall']:7.1f})  {st['size']}")

        if "filters" in ONLY:
            only = [x for x in args.filters.split(",") if x]
            t0 = time.time()
            fres = await pg.evaluate(FILTERS_JS, {"W": W, "H": H, "only": only, "cache": args.cache})
            res["filters"] = fres
            ok = {k: v for k, v in fres.items() if "ms" in v}
            print(f"\nFILTERS at {W}x{H} ({len(ok)} filters, {time.time() - t0:.0f}s): slowest first", flush=True)
            for k, v in sorted(ok.items(), key=lambda kv: -kv[1]["ms"]):
                print(f"  {v['ms']:9.1f} ms  (first {v['first']:8.1f})  {k:<24} {v['category']:<14} -> {v['out']}")
            for k, v in fres.items():
                if "error" in v: print(f"  ERROR {k}: {v['error']}")
            tot = sum(v["ms"] for v in ok.values())
            print(f"  sum of all filters: {tot:.0f} ms")

        if "video" in ONLY and args.video:
            async with pg.expect_file_chooser() as fc:
                await pg.evaluate("void window.lucid.actions.openMedia()")
            await (await fc.value).set_files(args.video)
            await pg.wait_for_function("() => { const s = window.lucid.store; return s.project.chains.length > 0 && s.lastRender && s.lastRender.md5 }", timeout=120000, polling=250)
            await pg.wait_for_timeout(500)
            v = await pg.evaluate(VIDEO_JS, {"n": 60})
            res["video"] = v
            per = [x["ms"] for x in v["per"][2:]]
            wall = [x["wall"] for x in v["per"][2:]]
            print(f"\nVIDEO {os.path.basename(args.video)}: {v['width']}x{v['height']} {v['codec']} via {v['engine']}", flush=True)
            print(f"  {v['frames']} frames sequential: {v['total']:.0f} ms total = {v['frames'] * 1000 / v['total']:.1f} fps · per frame median {med(per):.1f} ms in engine, {med(wall):.1f} ms round trip")
        res["pageErrors"] = errors
        await b.close()
    if args.json:
        with open(args.json, "w") as fh: json.dump(res, fh, indent=1)
        print(f"\nsaved {args.json}")

asyncio.run(main())
