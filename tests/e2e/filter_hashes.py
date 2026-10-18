"""Reproducibility check: MD5 of the output of every processing filter on a lossless PNG input.

Usage:
  URL=http://127.0.0.1:5199/ BROWSER=chromium|firefox|webkit OUTDIR=/tmp/lucid-hashes \
      python3 tests/e2e/filter_hashes.py /path/to/testmedia [other_run.json ...]

Writes OUTDIR/filter_hashes_<browser>.json. JSON files of other runs (another browser, or the same browser
before a code change) given as extra arguments are compared filter by filter. The input (repro.png from
make_media.py) has no color management chunks, so it decodes to identical pixels everywhere: any
difference comes from the processing itself.
"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright

URL = os.environ.get("URL", "http://127.0.0.1:5199/")
BROWSER = os.environ.get("BROWSER", "chromium")
OUT = os.environ.get("OUTDIR", "/tmp/lucid-hashes")
MEDIA = sys.argv[1] if len(sys.argv) > 1 else "/home/user/testmedia"
OTHERS = sys.argv[2:]
os.makedirs(OUT, exist_ok=True)

# Annotation filters draw text, outlines, borders or grid lines with the browser's 2D canvas, whose
# antialiasing and fonts differ between engines. Every other filter must give identical pixels everywhere.
CANVAS_ANNOTATIONS = {"add_grid", "add_shape", "add_text", "add_timestamp", "magnify", "measure_1d", "measure_2d", "multiview", "spotlight"}

INPUT_MD5_JS = """async () => { const s = window.lucid.store, c = s.project.chains[0];
  const r = await window.lucid.engine.call('render', { chainId: c.id, filterId: c.filters[0].id, frame: 0, channel: 'hash', want: { hash: true } });
  return r.md5 }"""


async def main():
    async with async_playwright() as p:
        b = await getattr(p, BROWSER).launch(args=["--no-sandbox"] if BROWSER == "chromium" else [])
        version = b.version
        pg = await b.new_page(viewport={"width": 1568, "height": 898})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL, wait_until="networkidle"); await pg.wait_for_timeout(1000)
        async with pg.expect_file_chooser() as fc:
            await pg.evaluate("(() => { window.lucid.actions.openMedia(); return null })()")
        await (await fc.value).set_files([os.path.join(MEDIA, "repro.png")])
        await pg.wait_for_function("() => window.lucid.store.lastRender && window.lucid.store.lastRender.width === 320", timeout=60000)
        inp = await pg.evaluate(INPUT_MD5_JS)
        await pg.evaluate("() => { window.__allFiltersOpts = { fromChain0: true, hash: true, frame: 0 } }")
        res = await pg.evaluate(open(os.path.join(os.path.dirname(__file__), "all_filters.js")).read())
        await b.close()

    run = {"browser": BROWSER, "version": version, "input": inp, "filters": res}
    path = os.path.join(OUT, f"filter_hashes_{BROWSER}.json")
    json.dump(run, open(path, "w"), indent=1)
    # Motion Detection legitimately reports a still image (single frame input) as motionless
    errs = {k: v for k, v in res.items() if v.startswith("ERR") and "No motion detected" not in v}
    print(f"{BROWSER} {version}: {len(res)} filters, {len(errs)} errors, input MD5 {inp} -> {path}")
    for k, v in errs.items(): print("  ERROR", k, v[:120])
    if errors: print("  page errors:", "; ".join(errors)[:300])

    ok = not errs and not errors
    for o in OTHERS:
        other = json.load(open(o))
        same_input = other["input"] == inp
        diff = sorted(k for k in res if other["filters"].get(k) != res[k])
        same_browser = other["browser"] == BROWSER
        unexpected = diff if same_browser else [k for k in diff if k not in CANVAS_ANNOTATIONS]
        print(f"vs {other['browser']} {other['version']} ({o}): input {'identical' if same_input else 'DIFFERENT'}, "
              f"{len(res) - len(diff)}/{len(res)} filters identical")
        if diff: print("  differ:", ", ".join(diff) + ("" if same_browser else "  (canvas annotations may differ between engines)"))
        if unexpected: print("  UNEXPECTED differences:", ", ".join(unexpected))
        ok = ok and same_input and not unexpected
    sys.exit(0 if ok else 1)

asyncio.run(main())
