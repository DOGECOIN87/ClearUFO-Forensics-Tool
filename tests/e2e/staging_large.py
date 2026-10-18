"""Large staged export: an uncompressed 1080p AVI larger than the in-memory export limit, written through
the Write Video dialog in a browser without a save dialog (default: Firefox). The file is staged on disk
in the browser's storage, verified by the application, downloaded, and checked frame by frame with ffmpeg.
The browser's memory is sampled during the export: it must stay far below the size of the file.

Usage: URL=http://127.0.0.1:5199/ BROWSER=firefox LUCID_TMP=/disk/dir FRAMES=300 python3 tests/e2e/staging_large.py
Keep LUCID_TMP and TMPDIR on a real disk: the source, the staged file and the download each take ~1.9 GB."""
import asyncio, glob, json, os, shutil, subprocess, sys, tempfile, threading, time
import imageio_ffmpeg
from playwright.async_api import async_playwright

URL = os.environ.get("URL", "http://127.0.0.1:5199/")
BROWSER = os.environ.get("BROWSER", "firefox")
FRAMES = int(os.environ.get("FRAMES", "300"))
FF = imageio_ffmpeg.get_ffmpeg_exe()
TMP = tempfile.mkdtemp(prefix="lucid-large-", dir=os.environ.get("LUCID_TMP") or None)
results = []
T0 = time.time()

def check(name, ok, info=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{info}]" if info else "") + f"  ({time.time() - T0:.0f}s)", flush=True)

def browser_pss_mb(profile):
    """Proportional memory (shared pages divided among their users) of every process of this browser."""
    total = 0
    for pid in os.listdir("/proc"):
        if not pid.isdigit(): continue
        try:
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().decode(errors="replace")
            if profile not in cmd and f"ms-playwright/{BROWSER}" not in cmd: continue
            for line in open(f"/proc/{pid}/smaps_rollup"):
                if line.startswith("Pss:"): total += int(line.split()[1])
        except OSError: pass
    return total / 1024

async def main():
    src = f"{TMP}/vga{FRAMES}.avi"
    subprocess.run([FF, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=30", "-frames:v", str(FRAMES), "-c:v", "rawvideo", "-pix_fmt", "bgr24", src], check=True)
    async with async_playwright() as p:
        profile = tempfile.mkdtemp(prefix="profile-", dir=TMP)
        ctx = await getattr(p, BROWSER).launch_persistent_context(profile, viewport={"width": 1568, "height": 898}, accept_downloads=True)
        pg = ctx.pages[0] if ctx.pages else await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL, wait_until="networkidle")
        await pg.wait_for_function("() => !!(window.lucid && window.lucid.store)", timeout=30000)
        print(f"{BROWSER}: {await pg.evaluate('navigator.userAgent')}", flush=True)
        # small frame cache (the sandbox has little memory); no save dialog
        await pg.evaluate("(()=>{ const s = window.lucid.store; s.savePrefs({ cacheMB: 128, saveToDisk: false }); return window.lucid.engine.call('setCacheLimit', 128) })()")
        async with pg.expect_file_chooser() as fc:
            await pg.evaluate("(()=>{ window.lucid.actions.openMedia(); return null })()")
        await (await fc.value).set_files([src])
        await pg.wait_for_function("() => { const s = window.lucid.store; return s.project.chains.length > 0 && s.lastRender && !!s.lastRender.md5 }", timeout=120000, polling=250)
        await pg.evaluate("window.lucid.actions.addFilter('resize', { mode: 'size', width: 1920, height: 1080, keepAspect: false, interp: 'bilinear' })")
        await pg.wait_for_function("() => { const r = window.lucid.store.lastRender; return r && r.width === 1920 && r.height === 1080 && r.md5 }", timeout=60000, polling=250)
        st = await pg.evaluate("(async()=>{ const s = await window.lucid.actions.staging.status(); return { ok: s.ok, api: s.api || null, room: s.room, limit: window.lucid.actions.memoryExportLimit() } })()")
        print(f"staging: {json.dumps(st)}", flush=True)
        # keep what the engine returns for the write (frame hashes, verification)
        await pg.evaluate("""(()=>{ const e = window.lucid.engine, orig = e.call.bind(e);
          e.call = async (m, ...a) => { const r = await orig(m, ...a); if (m === 'write') window.__w = { hashes: r.hashes, bytes: r.bytes, verified: r.verified, staged: r.staged || null, blob: !!r.blob, name: r.name }; return r; }; })()""")
        await pg.evaluate("void window.lucid.actions.writeVideo()")
        await pg.wait_for_selector(".dlg .export-note", timeout=10000)
        note = await pg.evaluate("[...document.querySelectorAll('.dlg')].pop().querySelector('.export-note').innerText")
        print("dialog: " + note.replace("\n", " | "), flush=True)
        await pg.evaluate("""(()=>{ window.__toasts = []; new MutationObserver(() => { const t = (document.querySelector('.toasts')||{}).innerText; if (t) window.__toasts.push(t); }).observe(document.body, { childList: true, subtree: true, characterData: true }); })()""")
        base = browser_pss_mb(profile)
        peak, stop = [base], [False]
        def sample():
            while not stop[0]: peak[0] = max(peak[0], browser_pss_mb(profile)); time.sleep(0.5)
        th = threading.Thread(target=sample, daemon=True); th.start()
        t_write = time.time()
        async with pg.expect_download(timeout=1800000) as dl:
            await pg.evaluate("[...document.querySelectorAll('.dlg-footer button')].reverse().find(b => b.textContent.trim() === 'Write').click()")
            # no "Large Export" warning may appear: the file is staged on disk, not assembled in memory
            await pg.wait_for_timeout(1500)
            warned = await pg.evaluate("[...document.querySelectorAll('.dlg')].some(d => d.innerText.includes('Large Export'))")
        d = await dl.value
        secs = time.time() - t_write
        path = await d.path()  # the download itself (no extra copy)
        stop[0] = True; th.join()
        w = await pg.evaluate("window.__w")
        size = os.path.getsize(path)
        print(f"written and downloaded {size / 2**30:.2f} GiB in {secs:.0f}s; browser memory {base:.0f} MB before, {peak[0]:.0f} MB at the peak (PSS)", flush=True)
        check("no in-memory warning; the export is staged on disk", not warned and "browser's storage" in note and w["staged"] and not w["blob"], st.get("api"))
        check("export larger than the in-memory limit of this browser", size > st["limit"], f"{size / 2**30:.2f} GiB > {st['limit'] / 2**30:.2f} GiB")
        check("verified in the browser: every frame read back from the staged file is bit-identical", w["verified"] and w["verified"]["ok"], w["verified"] and w["verified"]["message"])
        check("downloaded file is complete", size == w["bytes"], f"{size} bytes")
        check("browser memory grew far less than the file size", peak[0] - base < size / 2**20 / 3, f"+{peak[0] - base:.0f} MB for a {size / 2**20:.0f} MB file")
        r = subprocess.run([FF, "-v", "error", "-i", path, "-map", "0:v:0", "-f", "framemd5", "-pix_fmt", "rgb24", "-"], capture_output=True, text=True)
        m = [l.split(",")[-1].strip() for l in r.stdout.splitlines() if l and not l.startswith("#")]
        check(f"ffmpeg decodes all {FRAMES} 1920×1080 frames, identical to what the application wrote", m == w["hashes"] and len(m) == FRAMES and not r.stderr.strip(), f"{len(m)} frames {r.stderr.strip()[:100]}")
        toast = await pg.evaluate("(window.__toasts || []).filter(t => t.includes('Written')).pop() || ''")
        check("the user is told the file was staged on disk and verified", "staged on disk" in toast and "Verified" in toast, toast.splitlines()[-1][:160] if toast else "")
        await pg.evaluate("(async()=>{ const st = window.lucid.actions.staging; await st.free(st.list().map(i => i.entry)); })()")
        check("no uncaught page errors", not errors, "; ".join(errors)[:200])
        await ctx.close()
    print(f"\n{sum(results)}/{len(results)} checks passed")
    sys.exit(0 if all(results) else 1)

try: asyncio.run(main())
finally: shutil.rmtree(TMP, ignore_errors=True)
