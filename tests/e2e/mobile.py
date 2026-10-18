"""Mobile / touch end-to-end checks (Playwright with phone emulation).

Usage:  URL=http://127.0.0.1:5199/ OUTDIR=/tmp/lucid-mobile [BROWSER=chromium|webkit|firefox] python3 tests/e2e/mobile.py /path/to/testmedia

BROWSER=chromium (default) emulates an Android phone and sends real multi-touch input through CDP.
BROWSER=webkit emulates an iPhone (Safari's engine); BROWSER=firefox a touch phone without mobile
viewport emulation (not supported by Firefox). Without CDP, multi-finger gestures are dispatched as
touch Pointer Events, which is what the app's gesture recognizers consume; taps stay native.

Covers the compact layouts (portrait "stack", landscape "side"), touch gestures (tap, double tap,
long press, one finger pan, two finger pinch) and File > Open Project with files that are not
projects (the bug reported from an Android phone).
"""
import asyncio, json, os, random, sys, time
from playwright.async_api import async_playwright

URL = os.environ.get("URL", "http://127.0.0.1:5199/")
OUT = os.environ.get("OUTDIR", "/tmp/lucid-mobile")
MEDIA = sys.argv[1] if len(sys.argv) > 1 else "/home/user/testmedia"
os.makedirs(OUT, exist_ok=True)
BROWSER = os.environ.get("BROWSER", "chromium")
UA = {
    "chromium": "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
    "webkit": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
    "firefox": "Mozilla/5.0 (Android 14; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0",
}[BROWSER]
LAUNCH_ARGS = ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] if BROWSER == "chromium" else []

def phone_context(w, h, dpr, mobile=True):
    """Context options for a phone (or, with mobile=False, a desktop) of the selected engine."""
    o = {"viewport": {"width": w, "height": h}, "device_scale_factor": dpr, "has_touch": mobile, "user_agent": UA if mobile else None}
    if BROWSER != "firefox": o["is_mobile"] = mobile  # Firefox does not support mobile emulation
    return o

# Touch Pointer Events for engines without CDP: one pointer per finger, delivered to the element first
# touched (as with pointer capture).
SYNTH_TOUCH_JS = """([kind, pts]) => {
  const act = (window.__synthTouches ||= new Map());
  const fire = (type, id, t, x, y) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true,
    pointerId: 1000 + id, pointerType: 'touch', isPrimary: id === 0, clientX: x, clientY: y, screenX: x, screenY: y,
    button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, width: 8, height: 8, pressure: type === 'pointerup' ? 0 : 0.5 }));
  if (kind === 'touchEnd') { for (const [id, a] of act) fire('pointerup', id, a.t, a.x, a.y); act.clear(); return; }
  pts.forEach(([x, y], id) => {
    const a = act.get(id);
    if (!a) { const t = document.elementFromPoint(x, y) || document.body; act.set(id, { t, x, y }); fire('pointerdown', id, t, x, y); }
    else { a.x = x; a.y = y; fire('pointermove', id, a.t, x, y); }
  });
}"""

results = []
def check(name, ok, info=""):
    results.append((name, bool(ok), info))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{info}]" if info else ""), flush=True)


async def main():
    async with async_playwright() as p:
        b = await getattr(p, BROWSER).launch(args=LAUNCH_ARGS)
        print(f"{BROWSER} {b.version}", flush=True)
        ctx = await b.new_context(**phone_context(412, 915, 2.625))
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        cdp = await ctx.new_cdp_session(pg) if BROWSER == "chromium" else None

        async def touch(kind, pts):
            if cdp:
                await cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i, "radiusX": 4, "radiusY": 4, "force": 1} for i, (x, y) in enumerate(pts)]})
            else:
                await pg.evaluate(SYNTH_TOUCH_JS, [kind, [list(q) for q in pts]])

        async def long_press(x, y, ms=800):
            await touch("touchStart", [(x, y)]); await pg.wait_for_timeout(ms); await touch("touchEnd", [])

        async def drag(pts_from, pts_to, steps=12):
            await touch("touchStart", pts_from)
            for k in range(1, steps + 1):
                t = k / steps
                await touch("touchMove", [(a[0] + (b_[0] - a[0]) * t, a[1] + (b_[1] - a[1]) * t) for a, b_ in zip(pts_from, pts_to)])
                await pg.wait_for_timeout(16)
            await touch("touchEnd", [])

        async def tap_el(sel, idx=0):
            box = await pg.locator(sel).nth(idx).bounding_box()
            await pg.touchscreen.tap(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            return box

        async def tab(name):
            await tap_el(f'[data-trellis-part="tab"]:has-text("{name}")')
            await pg.wait_for_timeout(250)

        async def selected_tab():
            return await pg.evaluate("""() => [...document.querySelectorAll('[data-trellis-part="tab"][data-selected]')].map(t => t.textContent.trim())""")

        async def shot(name):
            await pg.screenshot(path=f"{OUT}/{name}.png")

        async def pick(trigger_js, files):
            async with pg.expect_file_chooser() as fc:
                await pg.evaluate(f"(() => {{ {trigger_js}; return null }})()")
            chooser = await fc.value
            await chooser.set_files(files)

        async def dialog_text():
            return await pg.evaluate("() => [...document.querySelectorAll('.dlg')].map(d => d.innerText).join('\\n---\\n')")

        async def toasts():
            return await pg.evaluate("() => [...document.querySelectorAll('.toast')].map(t => t.innerText)")

        async def close_dialogs():
            await pg.evaluate("() => document.querySelectorAll('.dlg-overlay').forEach(o => o.remove())")

        # ---------------------------------------------------------------- 1. layout on a phone
        await pg.goto(URL, wait_until="networkidle"); await pg.wait_for_timeout(1200)
        info = await pg.evaluate("""() => ({ layout: document.documentElement.dataset.layout, coarse: matchMedia('(pointer: coarse)').matches,
            sw: document.documentElement.scrollWidth, iw: innerWidth,
            panels: ['filters','tools','viewer','settings','history','player'].map(t => lucid.workspace.views({type: t}).length),
            frameOnly: document.querySelectorAll('[data-trellis-part="panel"][data-frame-only]').length })""")
        check("phone portrait uses the stacked layout", info["layout"] == "stack", json.dumps(info))
        check("all six panels exist, none collapsed to an icon tile", info["panels"] == [1] * 6 and info["frameOnly"] == 0)
        check("no horizontal page overflow", info["sw"] <= info["iw"])
        await shot("01_phone_empty")

        # ---------------------------------------------------------------- 2. Open Project with a WebM video (the reported bug)
        webm = os.path.join(MEDIA, "clip.webm")
        if not os.path.exists(webm):
            webm = next(os.path.join(MEDIA, f) for f in sorted(os.listdir(MEDIA)) if f.endswith(".webm"))
        await pick("lucid.actions.openProject()", webm)
        await pg.wait_for_timeout(3500)
        d, ts = await dialog_text(), await toasts()
        chains = await pg.evaluate("() => lucid.store.project.chains.length")
        check("WebM in Open Project: no JSON parser error", "JSON" not in d and "Unexpected token" not in d, d[:120])
        check("WebM in Open Project: explained and loaded as media", any("not a project file" in t for t in ts) and chains >= 1, f"toasts={ts} chains={chains}")
        await shot("02_open_project_webm")
        await close_dialogs()

        # ---------------------------------------------------------------- 3. unknown binary -> offer to load as media
        junk = os.path.join(OUT, "evidence.bin")
        with open(junk, "wb") as f:
            random.seed(7); f.write(bytes(random.getrandbits(8) for _ in range(4096)))
        await pick("lucid.actions.openProject()", junk)
        await pg.wait_for_timeout(800)
        d = await dialog_text()
        check("unknown binary: asks before loading as media", "Load as Media" in d, d[:160].replace("\n", " | "))
        await shot("03_open_project_binary")
        await close_dialogs()

        # ---------------------------------------------------------------- 4. truncated project
        trunc = os.path.join(OUT, "damaged.lfp")
        with open(trunc, "w") as f: f.write('{"app":"LUCID","schema":1,"name":"x","chains":[{"id":"c1","name":"A","filters":[')
        await pick("lucid.actions.openProject()", trunc)
        await pg.wait_for_timeout(800)
        d = await dialog_text()
        check("damaged project: clear message", "damaged" in d or "truncated" in d, d[:160].replace("\n", " | "))
        await close_dialogs()

        # ---------------------------------------------------------------- 5. Save Project downloads the file (Android has no
        # save picker; desktop headless Chromium does, so it is removed here), and the downloaded file opens again
        await pg.evaluate("() => { lucid.store.dirty = false }")
        await pg.evaluate("(() => { lucid.actions.loadSampleProject(); return null })()")
        await pg.wait_for_timeout(1500)
        await close_dialogs()
        await pg.evaluate("() => { try { delete window.showSaveFilePicker } catch (e) {} if (window.showSaveFilePicker) window.showSaveFilePicker = undefined; lucid.store.fileHandle = null }")
        good = os.path.join(OUT, "case.lfp")
        async with pg.expect_download(timeout=15000) as dl:
            await pg.evaluate("(() => { lucid.actions.saveProject(); return null })()")
        saved = await dl.value
        await saved.save_as(good)
        dirty = await pg.evaluate("() => lucid.store.dirty")
        check("Save Project without a save picker downloads a .lfp file", saved.suggested_filename.endswith(".lfp") and os.path.getsize(good) > 200 and not dirty,
              f"{saved.suggested_filename} {os.path.getsize(good)} bytes dirty={dirty}")
        await pg.evaluate("() => { lucid.store.dirty = false }")
        await pick("lucid.actions.openProject()", good)
        await pg.wait_for_timeout(1500)
        d = await dialog_text()
        n = await pg.evaluate("() => lucid.store.project.chains.length")
        check("valid project opens", n >= 3, f"chains={n} dialogs={d[:100]!r}")
        await close_dialogs()
        await pg.wait_for_timeout(2500)
        await shot("04_phone_sample_case")

        # ---------------------------------------------------------------- 6. Filters: tap + Add button
        await tab("Filters")
        await pg.fill(".quick-search", "unsharp")
        await pg.wait_for_timeout(300)
        await tap_el('.flt-item:has-text("Unsharp")')
        await pg.wait_for_timeout(250)
        has_btn = await pg.locator(".flt-add").count()
        check("touch: selected filter shows an Add button", has_btn == 1)
        await shot("05_filters_add_button")
        before = await pg.evaluate("() => lucid.store.chain().filters.length")
        await tap_el(".flt-add")
        await pg.wait_for_timeout(600)
        after = await pg.evaluate("() => lucid.store.chain().filters.length")
        sel = await pg.evaluate("() => lucid.store.selectedFilter()?.type")
        st = await selected_tab()
        check("Add button adds the filter", after == before + 1 and sel == "unsharp_mask", f"{before}->{after} sel={sel}")
        check("compact layout switches to the Settings tab", "Settings" in st, str(st))
        await pg.wait_for_timeout(1500)
        await shot("06_settings_after_add")

        # ---------------------------------------------------------------- 7. double tap adds
        await tab("Filters")
        await pg.fill(".quick-search", "median")
        await pg.wait_for_timeout(300)
        box = await pg.locator('.flt-item:has-text("Median")').first.bounding_box()
        before = await pg.evaluate("() => lucid.store.chain().filters.length")
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        await pg.touchscreen.tap(cx, cy); await pg.wait_for_timeout(120); await pg.touchscreen.tap(cx, cy)
        await pg.wait_for_timeout(700)
        after = await pg.evaluate("() => lucid.store.chain().filters.length")
        check("double tap on a filter adds it (once)", after == before + 1, f"{before}->{after}")
        # filter hints use touch wording ("tap", not "click")
        prev = await pg.evaluate("() => lucid.store.selectedFilter()?.id ?? null")
        await pg.evaluate("() => lucid.actions.addFilter('curves')")
        await pg.wait_for_timeout(600)
        txt = await pg.evaluate("() => (document.querySelector('.fs-panel') || {}).innerText || ''")
        check("filter hints use touch wording", "tap to add points" in txt and "click" not in txt.lower(), " ".join(txt.split())[-110:])
        await pg.evaluate("""(prev) => { const f = lucid.store.selectedFilter(), c = lucid.store.chain();
            if (f && f.type === 'curves') lucid.store.mutate(pr => { const ch = pr.chains.find(x => x.id === c.id); ch.filters = ch.filters.filter(x => x.id !== f.id); });
            if (prev) lucid.store.selectFilter(prev, c.id); }""", prev)
        await pg.wait_for_timeout(300)

        # ---------------------------------------------------------------- 8. History: long press menu, double tap configure
        await tab("History")
        rows = pg.locator(".tree-filter")
        check("history lists the filters", await rows.count() >= 2)
        rb = await rows.nth(1).bounding_box()
        await long_press(rb["x"] + 60, rb["y"] + rb["height"] / 2)
        await pg.wait_for_timeout(200)
        menu = await pg.evaluate("() => [...document.querySelectorAll('.menu-popup .menu-item')].map(m => m.innerText.split('\\n')[0]).slice(0, 6)")
        check("long press on a history row opens its context menu", len(menu) > 2, str(menu))
        await shot("07_history_long_press")
        await pg.evaluate("() => document.querySelectorAll('.menu-popup').forEach(m => m.remove())")
        await pg.touchscreen.tap(rb["x"] + 60, rb["y"] + rb["height"] / 2); await pg.wait_for_timeout(100)
        await pg.touchscreen.tap(rb["x"] + 60, rb["y"] + rb["height"] / 2)
        await pg.wait_for_timeout(500)
        check("double tap on a history row opens its settings", "Settings" in await selected_tab(), str(await selected_tab()))

        # ---------------------------------------------------------------- 9. Viewer: pinch, pan, double tap, long press
        # select the loader (no on-image parameters) so one finger gestures drive the tools,
        # not the overlay editing of the selected filter
        await pg.evaluate("() => { const c = lucid.store.chain(); lucid.store.selectFilter(c.filters[0].id, c.id); lucid.store.setUi({ tool: 'pointer', showInput: false }) }")
        # wait for the image (a render requested earlier may still be running on slow machines)
        await pg.wait_for_function("() => lucid.mainViewer && lucid.mainViewer.current && lucid.mainViewer.viewport()", timeout=90000)
        await pg.wait_for_timeout(500)
        sb = await pg.locator(".viewer-stage").first.bounding_box()
        mx, my = sb["x"] + sb["width"] / 2, sb["y"] + sb["height"] / 2
        z0 = await pg.evaluate("() => lucid.mainViewer.zoom")
        await drag([(mx - 30, my), (mx + 30, my)], [(mx - 110, my), (mx + 110, my)])
        await pg.wait_for_timeout(300)
        z1 = await pg.evaluate("() => lucid.mainViewer.zoom")
        check("pinch zooms the image", z1 > z0 * 2.5, f"{z0:.3f} -> {z1:.3f}")
        vp0 = await pg.evaluate("() => lucid.mainViewer.viewport()")
        await drag([(mx, my)], [(mx + 80, my + 40)])
        await pg.wait_for_timeout(200)
        vp1 = await pg.evaluate("() => lucid.mainViewer.viewport()")
        check("one finger drag pans", abs(vp1["x"] - vp0["x"]) > 5, f"x {vp0['x']:.1f} -> {vp1['x']:.1f}")
        await shot("08_viewer_pinched")
        await pg.touchscreen.tap(mx, my); await pg.wait_for_timeout(110); await pg.touchscreen.tap(mx, my)
        await pg.wait_for_timeout(300)
        check("double tap returns to fit", await pg.evaluate("() => lucid.mainViewer.isFit"))
        await long_press(mx, my)
        await pg.wait_for_timeout(200)
        menu = await pg.evaluate("() => [...document.querySelectorAll('.menu-popup .menu-item')].map(m => m.innerText.split('\\n')[0]).slice(0, 4)")
        check("long press on the viewer opens the viewer menu", "Fit Window" in menu, str(menu))
        await pg.evaluate("() => document.querySelectorAll('.menu-popup').forEach(m => m.remove())")
        # a tap with the selector tool must not leave a selection, a drag must create one
        await pg.evaluate("() => lucid.store.setUi({ tool: 'selector', selection: null })")
        await drag([(mx - 60, my - 40)], [(mx + 40, my + 30)])
        await pg.wait_for_timeout(200)
        sel = await pg.evaluate("() => lucid.store.ui.selection")
        check("selector tool: finger drag draws a selection", bool(sel) and sel["w"] > 5, str(sel))
        # crosshair tool: a finger has no hover, so a drag moves the crosshair and a tap locks it
        await pg.evaluate("() => lucid.store.setUi({ tool: 'crosshair', crosshair: null })")
        await drag([(mx - 50, my)], [(mx + 50, my + 20)])
        await pg.wait_for_timeout(200)
        st = await pg.evaluate("() => ({ locked: lucid.store.ui.crosshair, hover: lucid.mainViewer.hover })")
        check("crosshair tool: a finger drag moves the crosshair without locking it", st["locked"] is None and bool(st["hover"]), str(st))
        await pg.wait_for_timeout(450)
        await pg.touchscreen.tap(mx + 50, my + 20)
        await pg.wait_for_timeout(450)
        lk = await pg.evaluate("() => lucid.store.ui.crosshair")
        await drag([(mx + 50, my + 20)], [(mx - 40, my - 30)])
        await pg.wait_for_timeout(200)
        lk2 = await pg.evaluate("() => lucid.store.ui.crosshair")
        check("crosshair tool: a tap locks it and a drag moves the locked crosshair", bool(lk) and bool(lk2) and lk2["x"] < lk["x"] - 5, f"{lk} -> {lk2}")
        await pg.evaluate("() => lucid.store.setUi({ crosshair: null })")
        await pg.evaluate("() => lucid.store.setUi({ tool: 'pointer' })")

        # ---------------------------------------------------------------- 10. menus by touch (submenu opens on tap)
        await tap_el('.menubar-item:has-text("View")')
        await pg.wait_for_timeout(200)
        await tap_el('.menu-popup .menu-item:has-text("Layout")')
        await pg.wait_for_timeout(200)
        subs = await pg.evaluate("() => document.querySelectorAll('.menu-popup').length")
        check("tapping a submenu parent opens the submenu", subs >= 2, f"popups={subs}")
        await shot("09_menu_layout_submenu")
        await tap_el('.menu-popup .menu-item:has-text("Desktop")')
        await pg.wait_for_timeout(500)
        check("View > Layout > Desktop forces the desktop layout", await pg.evaluate("() => document.documentElement.dataset.layout") == "desktop")
        await pg.evaluate("() => { lucid.store.savePrefs({ layout: 'auto' }); lucid.applyLayoutMode() }")
        await pg.wait_for_timeout(400)
        check("Automatic returns to the compact layout", await pg.evaluate("() => document.documentElement.dataset.layout") == "stack")

        # ---------------------------------------------------------------- 11. rotation keeps panel state
        await pg.evaluate("() => { document.querySelector('.filters-panel').dataset.probe = 'kept'; document.querySelector('.history').dataset.probe = 'kept' }")
        await pg.set_viewport_size({"width": 915, "height": 412})
        await pg.wait_for_timeout(900)
        st = await pg.evaluate("""() => ({ layout: document.documentElement.dataset.layout,
            filters: [...document.querySelectorAll('.filters-panel')].map(e => e.dataset.probe || ''),
            history: [...document.querySelectorAll('.history')].map(e => e.dataset.probe || ''),
            viewers: document.querySelectorAll('.viewer').length,
            frameOnly: document.querySelectorAll('[data-trellis-part="panel"][data-frame-only]').length })""")
        check("landscape phone uses the side layout", st["layout"] == "side", json.dumps(st))
        check("panels stay mounted across layout switches (no duplicates)", st["filters"] == ["kept"] and st["history"] == ["kept"] and st["viewers"] == 1)
        await pg.wait_for_timeout(1200)
        await shot("10_phone_landscape")
        await pg.set_viewport_size({"width": 412, "height": 915})
        await pg.wait_for_timeout(900)
        check("back to portrait", await pg.evaluate("() => document.documentElement.dataset.layout") == "stack")

        check("no page errors", not errors, "; ".join(errors[:3]))
        await ctx.close()

        # ---------------------------------------------------------------- 12. tablet + desktop
        for (w, h, dpr, mob, want, name) in [(880, 1180, 2, True, "stack", "11_tablet_portrait"), (1180, 820, 2, True, "desktop", "12_tablet_landscape"), (1568, 898, 1, False, "desktop", "13_desktop")]:
            c2 = await b.new_context(**phone_context(w, h, dpr, mob))
            p2 = await c2.new_page()
            errs = []
            p2.on("pageerror", lambda e: errs.append(str(e)))
            await p2.goto(URL, wait_until="networkidle"); await p2.wait_for_timeout(1000)
            await p2.evaluate("(() => { lucid.actions.loadSampleProject(); return null })()")
            await p2.wait_for_timeout(3500)
            lay = await p2.evaluate("() => document.documentElement.dataset.layout")
            fo = await p2.evaluate("() => document.querySelectorAll('[data-trellis-part=\"panel\"][data-frame-only]').length")
            check(f"{w}x{h} uses the {want} layout", lay == want and fo == 0 and not errs, f"layout={lay} frameOnly={fo} errors={errs[:2]}")
            await p2.screenshot(path=f"{OUT}/{name}.png")
            await c2.close()
        await b.close()

    ok = sum(1 for r in results if r[1])
    print(f"\n{ok}/{len(results)} mobile checks passed")
    sys.exit(0 if ok == len(results) else 1)

asyncio.run(main())
