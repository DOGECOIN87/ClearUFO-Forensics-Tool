"""End-to-end suite: drives the real UI/engine in headless Chromium and asserts results.
Usage: URL=http://localhost:5173/ python3 tests/e2e/run_all.py [media_dir]
Requires: pip install playwright imageio-ffmpeg pillow && playwright install chromium"""
import asyncio, base64, json, os, subprocess, sys, time
import imageio_ffmpeg
from playwright.async_api import async_playwright

URL = os.environ.get("URL", "http://localhost:5173/")
MEDIA = sys.argv[1] if len(sys.argv) > 1 else "/tmp/lucid-testmedia"
FF = imageio_ffmpeg.get_ffmpeg_exe()
results = []
T0 = time.time()
def check(name, ok, info=""):
    results.append(ok)
    t = f"  ({time.time() - T0:.0f}s)" if os.environ.get("TIMING") else ""
    print(("PASS " if ok else "FAIL ") + name + (f"  [{info}]" if info else "") + t, flush=True)

# The sample case's source is drawn with canvas text, whose rasterization differs between browser engines
# (and fonts), so the golden MD5 is per engine; it was recorded on the reference test machine.
GOLDEN = {"chromium": "1c75aed07a38a5f6e85bc57898e705e2"}

# Frame pixels as base64 RGB bytes (a JSON array of numbers is slow and memory hungry in some engines).
FRAME_RGB_JS = """(() => { const a = window.lucid.store.lastRender.rgba, n = a.length / 4, rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { rgb[i * 3] = a[i * 4]; rgb[i * 3 + 1] = a[i * 4 + 1]; rgb[i * 3 + 2] = a[i * 4 + 2]; }
  let s = ''; for (let i = 0; i < rgb.length; i += 0x8000) s += String.fromCharCode.apply(null, rgb.subarray(i, i + 0x8000));
  return btoa(s); })()"""

async def pick(pg, files, trigger="window.lucid.actions.openMedia()"):
    async with pg.expect_file_chooser() as fc:
        await pg.evaluate("(()=>{ " + trigger + "; return null })()")
    await (await fc.value).set_files(files)

async def main():
    if not os.path.exists(f"{MEDIA}/vp9_opus.webm"):
        subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "make_media.py"), MEDIA], check=True)
    async with async_playwright() as p:
        browser = os.environ.get("BROWSER", "chromium")   # chromium | firefox | webkit
        b = await getattr(p, browser).launch(args=["--no-sandbox"] if browser == "chromium" else [])
        print(f"{browser} {b.version}", flush=True)
        pg = await b.new_page(viewport={"width": 1568, "height": 898})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL, wait_until="networkidle"); await pg.wait_for_timeout(1500)

        # 1. sample case: full forensic chain renders deterministically
        # The first render averages registered frames: wait for it instead of sleeping a fixed time (slow machines).
        await pg.evaluate("void window.lucid.actions.loadSampleProject()")
        try: await pg.wait_for_function("() => { const r = window.lucid.store.lastRender; return !!(r && r.md5) }", timeout=60000, polling=200)
        except Exception: pass
        r = await pg.evaluate("(()=>{const r=window.lucid.store.lastRender; return r && {w:r.width,h:r.height,md5:r.md5}})()")
        check("sample case renders 7-step chain", bool(r) and r["w"] == 620 and r["h"] == 350, json.dumps(r))
        golden = GOLDEN.get(browser)
        if golden: check("processing is deterministic (golden MD5)", bool(r) and r["md5"] == golden, r and r["md5"])
        else: print(f"INFO no golden MD5 recorded for {browser}: {r and r['md5']}")

        # 2. every filter renders without error
        res = await pg.evaluate(open(os.path.join(os.path.dirname(__file__), "all_filters.js")).read())
        errs = {k: v for k, v in res.items() if v.startswith("ERR")}
        check(f"all {len(res)} processing filters render", not errs, json.dumps(errs)[:300])

        # 3. formats
        await pg.evaluate("window.lucid.store.setDirty(false); window.lucid.newProject()")
        for name, expect in [("vp9_opus.webm", (640, 360, 50)), ("av1.mp4", (640, 360, 50)), ("mjpeg_nodht.avi", (640, 360, 50)), ("yuy2.avi", (320, 240, 25)), ("bgr24.avi", (320, 240, 25)), ("photo_exif.jpg", (800, 600, 1)), ("multipage.tif", (320, 240, 3))]:
            await pick(pg, [f"{MEDIA}/{name}"]); await pg.wait_for_timeout(3500)
            r = await pg.evaluate("(()=>{const r=window.lucid.store.lastRender; return r && [r.width,r.height,r.info.frameCount]})()")
            check(f"load {name}", r == list(expect), str(r))
        # frame accuracy: frame 48 of the VP9 clip is frame 48 (testsrc2 timecode) — compare to ffmpeg's decode
        await pg.evaluate("window.lucid.store.setUi({chainId: window.lucid.store.project.chains[0].id})"); await pg.wait_for_timeout(1500)
        # this check compares with ffmpeg's sample replication, so use the loader's Nearest chroma (Bicubic and
        # Bilinear are compared with zimg in tests/e2e/quality.py)
        await pg.evaluate("(()=>{ const s = window.lucid.store; window.lucid.actions.setParam(s.project.chains[0].filters[0].id, 'chroma', 'nearest'); })()"); await pg.wait_for_timeout(1000)
        await pg.evaluate("window.lucid.store.setFrame(48)"); await pg.wait_for_timeout(2500)
        rgb = base64.b64decode(await pg.evaluate(FRAME_RGB_JS))
        matrix = await pg.evaluate("(()=>{const s=window.lucid.store; return s.sources.get(s.chain().filters[0].params.source).colorMatrix || 'auto'})()")
        mads = {}
        for n in range(45, 50):
            ref = subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-i", f"{MEDIA}/vp9_opus.webm", "-vf", f"select=eq(n\\,{n}),scale=in_color_matrix=bt601:flags=neighbor+accurate_rnd+full_chroma_int", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], capture_output=True).stdout
            if len(ref) != len(rgb): continue
            mads[n] = sum(abs(a - b) for a, b in zip(rgb, ref)) / len(ref)
        best = min(mads, key=mads.get)
        check("frame-accurate seek (frame 48 is the closest ffmpeg frame among 45-49)", best == 48, ", ".join(f"{k}:{v:.3f}" for k, v in mads.items()))
        # Some browsers (e.g. Firefox) only hand out RGB frames converted by the browser: then bit-exactness is not
        # possible, and the app must say so (File Info, report) instead of claiming its own conversion.
        cc = await pg.evaluate("(()=>{const s=window.lucid.store; const i=s.sources.get(s.chain().filters[0].params.source); return {b: !!i.browserConversion, t: i.conversion || ''}})()")
        check("the app states who converted YUV to RGB", cc["t"].startswith("Browser" if cc["b"] else "LUCID"), cc["t"][:100])
        if cc["b"]: print(f"INFO YUV to RGB done by the browser in {browser} (bit-exactness not possible): MAD {mads.get(48, 99):.3f}")
        else: check("bit-exact YUV to RGB vs ffmpeg reference (BT.601, limited, Nearest chroma)", mads.get(48, 99) < 0.05, f"MAD {mads.get(48, 99):.3f}")

        # 4. Convert DVR: lossless remux verified by decoding with ffmpeg
        await pick(pg, [f"{MEDIA}/{n}" for n in ["bframes.264", "stream.265", "dahua_sample.dav", "hik_sample.mp4"]], "(async()=>{ const {pickFiles} = await import('/src/ui/dom.ts'); window.__f = await pickFiles('*/*', true); })()")
        await pg.wait_for_timeout(800)
        conv = await pg.evaluate("(async()=>{ const e=window.lucid.engine, out={}; for (const f of window.__f) { await e.call('scanDvr','c_'+f.name,f,{codec:'auto',fps:0,container:'auto'}); const c=await e.call('convertedFile','c_'+f.name); const b=new Uint8Array(c.buffer); let s=''; for (let i=0;i<b.length;i+=0x8000) s+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000)); out[f.name]=btoa(s);} return out; })()")
        refs = {"bframes.264": "bframes.264", "stream.265": "stream.265", "dahua_sample.dav": "nob.264", "hik_sample.mp4": "ps_h264.mpg"}
        def framemd5(path):
            o = subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:v:0", "-f", "framemd5", "-"], capture_output=True, text=True).stdout
            return [l.split(",")[-1].strip() for l in o.splitlines() if l and not l.startswith("#")]
        for name, b64 in conv.items():
            path = f"/tmp/lucid_conv_{name}.mp4"; open(path, "wb").write(base64.b64decode(b64))
            a, bb = framemd5(path), framemd5(f"{MEDIA}/{refs[name]}")
            check(f"Convert DVR lossless: {name}", a == bb and len(a) > 0, f"{len(a)} frames")

        # 5. writers produce valid files
        w = await pg.evaluate("(async()=>{ const s=window.lucid.store,e=window.lucid.engine; const c=s.project.chains[0]; const out=[]; for (const fmt of ['png','png16','tiff16','tiff32f','bmp','avi-raw','tiff','avi-mjpeg']) { const r=await e.call('write',{chainId:c.id,filterId:null,format:fmt,quality:0.9,start:0,end:fmt.startsWith('png')||fmt==='bmp'?0:4,name:'t',taskId:'t'+fmt,verify:true}); out.push([fmt,r.bytes,r.frames,r.blob?r.blob.size:-1,r.verified?r.verified.ok:null]); } return out; })()")
        check("writers (uncompressed PNG/TIFF/BMP/AVI, TIFF ZIP, AVI MJPEG)", all(x[1] > 1000 and x[3] == x[1] for x in w), json.dumps(w))
        check("lossless writes verified bit-identical on read-back", all(x[4] is True for x in w if x[0] != "avi-mjpeg"), json.dumps(w))
        check("no uncaught page errors", not errors, "; ".join(errors)[:300])
        await b.close()
    print(f"\n{sum(results)}/{len(results)} checks passed")
    sys.exit(0 if all(results) else 1)

asyncio.run(main())
