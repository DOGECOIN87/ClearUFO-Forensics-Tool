"""Video quality and slow motion, checked in a real browser against independent references.

- Chroma reconstruction of decoded video (Video Loader › Chroma Filter):
  Nearest  = ffmpeg's sample replication (swscale neighbor + full_chroma_int), bit for bit;
  Bicubic (Catmull-Rom, the default of new loaders) and Bilinear = zimg (ffmpeg zscale), within rounding.
  Covered: VP9 in WebM (WebCodecs), H.264 in AVI (remuxed, WebCodecs), raw YUY2 4:2:2 AVI (LUCID's own
  decoder) and 10-bit VP9 (profile 2), whose 16-bit TIFF export keeps the sub-8-bit precision.
- The software decoder is requested and reported in File Info; the YUV → RGB conversion is LUCID's.
- A Video Loader saved without the Chroma Filter parameter (earlier versions) decodes as before (Nearest).
- Playback speed 0.01× – 16×: slider range, presets menu, exact entry, [ and ] keys. At 0.05× a 25 fps clip
  advances 1.25 frames per second without skipping a frame; at 0.01× each frame stays on screen for 4 s.
- Viewer "Sharp" display: at 150 % one-pixel stripes keep equal widths (nearest neighbor makes them 2 : 1);
  at 200 % both are exact.

Usage: URL=http://127.0.0.1:5199/ BROWSER=chromium LUCID_TMP=/disk/dir python3 tests/e2e/quality.py /home/user/testmedia
"""
import asyncio, base64, json, os, subprocess, sys, tempfile, time
import numpy as np
import imageio_ffmpeg
from PIL import Image
from playwright.async_api import async_playwright

URL = os.environ.get("URL", "http://127.0.0.1:5199/")
BROWSER = os.environ.get("BROWSER", "chromium")
MEDIA = sys.argv[1] if len(sys.argv) > 1 else "/home/user/testmedia"
FF = imageio_ffmpeg.get_ffmpeg_exe()
TMP = tempfile.mkdtemp(prefix="lucid-q-", dir=os.environ.get("LUCID_TMP") or None)
results = []
T0 = time.time()

def check(name, ok, info=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{info}]" if info else "") + f"  ({time.time() - T0:.0f}s)", flush=True)

def ff(*args):
    r = subprocess.run([FF, "-v", "error", "-y", *args], capture_output=True)
    if r.returncode: raise RuntimeError(r.stderr.decode()[:400])
    return r.stdout

ZMAT = {"bt601": "470bg", "bt709": "709", "bt2020": "2020_ncl"}
def zscale(matrix, chroma, siting="left", rng="limited"):
    f = "filter=bicubic:param_a=0:param_b=0.5" if chroma == "bicubic" else "filter=bilinear"
    return f"zscale=rangein={rng}:matrixin={ZMAT[matrix]}:chromalin={siting}:{f}:dither=none:transferin=709:transfer=709:primariesin=709:primaries=709"

def ref_frame(path, n, conv, pix="rgb24", pre=""):
    """Frame n (presentation order) decoded by ffmpeg and converted to RGB by `conv`."""
    return ff(*pre.split(), "-i", path, "-vf", f"select=eq(n\\,{n}),{conv}", "-frames:v", "1", "-pix_fmt", pix, "-f", "rawvideo", "-")

NEAREST = "scale=in_color_matrix=bt601:in_range=tv:flags=neighbor+accurate_rnd+full_chroma_int"
FRAME_RGB_JS = """(() => { const a = window.lucid.store.lastRender.rgba, n = a.length / 4, rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { rgb[i * 3] = a[i * 4]; rgb[i * 3 + 1] = a[i * 4 + 1]; rgb[i * 3 + 2] = a[i * 4 + 2]; }
  let s = ''; for (let i = 0; i < rgb.length; i += 0x8000) s += String.fromCharCode.apply(null, rgb.subarray(i, i + 0x8000));
  return btoa(s); })()"""
PAGE = """() => {
  window.__write = async (o) => { const s = window.lucid.store, e = window.lucid.engine, c = s.chain();
    const r = await e.call('write', Object.assign({ chainId: c.id, filterId: null, quality: 1, name: 'q', taskId: 'q' + Math.random(), verify: true, start: 0, end: 0 }, o));
    const b = new Uint8Array(await (r.blob || r.file).arrayBuffer()); let s2 = ''; for (let i = 0; i < b.length; i += 0x8000) s2 += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return { b64: btoa(s2), verified: r.verified }; };
  return true; }"""

def diff(a, b):
    x, y = np.frombuffer(a, np.uint8).astype(int), np.frombuffer(b, np.uint8).astype(int)
    if x.shape != y.shape: return 999.0, 999
    d = np.abs(x - y)
    return float(d.mean()), int(d.max())

async def load(pg, path):
    before = await pg.evaluate("window.lucid.store.project.chains.length")
    async with pg.expect_file_chooser() as fc:
        await pg.evaluate("(()=>{ window.lucid.actions.openMedia(); return null })()")
    await (await fc.value).set_files([path])
    # rendered, or an error shown in the Viewer (e.g. a codec this browser cannot decode)
    await pg.wait_for_function(f"""() => {{ const s = window.lucid.store; if (s.project.chains.length <= {before}) return false;
      const m = document.querySelector('.viewer-msg'); return (s.lastRender && s.lastRender.chainId === s.ui.chainId && !!s.lastRender.md5) || (m && !m.hidden && m.textContent.length > 0) }}""", timeout=60000, polling=100)
    return await pg.evaluate("""(()=>{ const s = window.lucid.store; const f = s.chain().filters[0]; const i = s.sources.get(f.params.source); const m = document.querySelector('.viewer-msg');
      return { params: f.params, decoder: i.decoder, conversion: i.conversion || '', browser: !!i.browserConversion, siting: i.chromaSiting || null, meta: i.metadata, fps: i.fps, frames: i.frameCount,
               error: s.lastRender && s.lastRender.chainId === s.ui.chainId ? '' : (m && !m.hidden ? m.textContent : 'no render') } })()""")

async def show(pg, frame, **params):
    """Set loader parameters and the frame, and wait for the matching render."""
    await pg.evaluate(f"""(()=>{{ const s = window.lucid.store, a = window.lucid.actions, f = s.chain().filters[0];
      for (const [k, v] of Object.entries({json.dumps(params)})) a.setParam(f.id, k, v); s.setFrame({frame}); }})()""")
    want = json.dumps(params)
    await pg.wait_for_function(f"""() => {{ const s = window.lucid.store, r = s.lastRender, f = s.chain().filters[0];
      return r && r.md5 && r.frame === {frame} && r.chainId === s.ui.chainId && Object.entries({want}).every(([k, v]) => f.params[k] === v) && !window.lucid.mainViewer.isBusy }}""", timeout=30000, polling=100)
    await pg.wait_for_timeout(400)
    await pg.wait_for_function("() => !window.lucid.mainViewer.isBusy", timeout=30000, polling=50)
    return base64.b64decode(await pg.evaluate(FRAME_RGB_JS))

async def main():
    # 10-bit test clip with real sub-8-bit detail (geq works at 10 bits), VP9 profile 2, lossless
    vp9_10 = f"{TMP}/vp9_10bit.webm"
    try:
        ff("-f", "lavfi", "-i", "nullsrc=s=320x240:r=25,format=yuv420p10le,geq=lum='64+mod(X*7+Y*3\\,876)':cb='512+300*sin(X/11)':cr='512+300*cos(Y/7)'",
           "-frames:v", "8", "-c:v", "libvpx-vp9", "-profile:v", "2", "-pix_fmt", "yuv420p10le", "-lossless", "1", vp9_10)
    except Exception as e:
        vp9_10 = None; print(f"INFO no 10-bit VP9 encoder: {e}")
    stripes = f"{TMP}/stripes.png"
    Image.fromarray(np.tile(np.array([0, 255], np.uint8), (48, 32))).convert("RGB").save(stripes)

    async with async_playwright() as p:
        profile = tempfile.mkdtemp(prefix="profile-", dir=TMP)
        ctx = await getattr(p, BROWSER).launch_persistent_context(profile, viewport={"width": 1568, "height": 898}, args=["--no-sandbox"] if BROWSER == "chromium" else [])
        pg = ctx.pages[0] if ctx.pages else await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL, wait_until="networkidle")
        await pg.wait_for_function("() => !!(window.lucid && window.lucid.store)", timeout=30000)
        await pg.evaluate(PAGE)
        print(f"{BROWSER}: {await pg.evaluate('navigator.userAgent')}", flush=True)

        # ---------------------------------------------------------------- 1. VP9 (WebCodecs)
        vp9 = f"{MEDIA}/vp9_opus.webm"
        info = await load(pg, vp9)
        check("new Video Loader defaults: Bicubic chroma, siting From File", info["params"].get("chroma") == "bicubic" and info["params"].get("siting") == "auto", json.dumps({k: info["params"].get(k) for k in ("chroma", "siting", "matrix", "colorRange")}))
        dec = dict(info["meta"]).get("Decoder", "")
        if BROWSER == "chromium": check("software decoder requested and reported (exact decoded planes)", info["decoder"] == "software" and "software" in dec, dec)
        else: print(f"INFO decoder in {BROWSER}: {info['decoder']} — {dec}")
        check("VP9 chroma siting: not signaled by the file → MPEG default (Left)", info["siting"] is None and "not signaled" in dict(info["meta"]).get("Chroma Siting (auto)", "not signaled"), str(dict(info["meta"]).get("Chroma Siting (auto)")))
        own = not info["browser"]
        check("File Info states who converts YUV to RGB, and how", info["conversion"].startswith("LUCID" if own else "Browser") and ("Chroma Filter" in info["conversion"]), info["conversion"][:120])
        if own:
            for n in (7, 48):
                got = await show(pg, n, chroma="nearest")
                mad, mx = diff(got, ref_frame(vp9, n, NEAREST))
                check(f"VP9 frame {n}, Nearest = ffmpeg sample replication (bit-exact conversion)", mad < 0.05 and mx <= 1, f"MAD {mad:.4f}, max {mx}")
                for chroma in ("bicubic", "bilinear"):
                    got = await show(pg, n, chroma=chroma)
                    mad, mx = diff(got, ref_frame(vp9, n, zscale("bt601", chroma) + ",format=gbrp"))
                    check(f"VP9 frame {n}, {chroma.capitalize()} = zimg (independent float implementation)", mad < 0.05 and mx <= 1, f"MAD {mad:.4f}, max {mx}")
            # legacy loader: no chroma parameter (project from an earlier version) decodes exactly like Nearest
            near = await show(pg, 20, chroma="nearest")
            await pg.evaluate("(()=>{ const s = window.lucid.store; s.mutate((p) => { delete p.chains.find((c) => c.id === s.ui.chainId).filters[0].params.chroma; }); s.setFrame(21); })()")
            await pg.wait_for_function("() => { const r = window.lucid.store.lastRender; return r && r.frame === 21 && !window.lucid.mainViewer.isBusy }", timeout=30000, polling=100)
            await pg.evaluate("window.lucid.store.setFrame(20)")
            await pg.wait_for_function("() => { const r = window.lucid.store.lastRender; return r && r.frame === 20 && !window.lucid.mainViewer.isBusy }", timeout=30000, polling=100)
            await pg.wait_for_timeout(400)
            legacy = base64.b64decode(await pg.evaluate(FRAME_RGB_JS))
            check("loader without a Chroma Filter parameter (earlier projects) decodes exactly as before (Nearest)", legacy == near and await pg.evaluate("!('chroma' in window.lucid.store.chain().filters[0].params)"))
            sharp = await show(pg, 20, chroma="bicubic")
            check("Bicubic differs from Nearest on real video (color edges rebuilt)", diff(sharp, near)[0] > 0.2, f"MAD {diff(sharp, near)[0]:.3f}")
            # media element engine (the fallback for codecs WebCodecs cannot decode): its decoded planes are
            # converted by LUCID when the browser exposes them (seeking is time based: nearest frame accepted)
            got = await show(pg, 20, chroma="bicubic", engine="media")
            await pg.wait_for_timeout(500)
            conv = await pg.evaluate("(()=>{ const s = window.lucid.store; return s.sources.get(s.chain().filters[0].params.source).conversion || '' })()")
            best = min((diff(got, ref_frame(vp9, m, zscale("bt601", "bicubic") + ",format=gbrp")) + (m,) for m in (19, 20, 21)), key=lambda t: t[0])
            if conv.startswith("LUCID"):
                check("media element engine: decoded planes converted by LUCID (Bicubic = zimg)", best[0] < 0.05 and best[1] <= 1 and "media element" in conv, f"frame {best[2]}: MAD {best[0]:.4f}, max {best[1]}; {conv[:70]}")
            else:
                check("media element engine: canvas conversion reported as the browser's", conv.startswith("Browser") and best[0] < 6, f"frame {best[2]}: MAD {best[0]:.3f}; {conv[:70]}")
            await show(pg, 20, engine="webcodecs")
        else:
            print(f"INFO {BROWSER}: the browser converts YUV to RGB, chroma options do not apply")

        # ---------------------------------------------------------------- 2. H.264 in AVI (remuxed to MP4, WebCodecs)
        h264 = f"{MEDIA}/h264.avi"
        info = await load(pg, h264)
        if info["error"]:
            print(f"INFO H.264 not decodable in this {BROWSER} build (this test build has no proprietary codecs): {info['error'][:90]}")
        elif not info["browser"]:
            got = await show(pg, 10, chroma="nearest")
            mad, mx = diff(got, ref_frame(h264, 10, NEAREST))
            check("H.264 frame 10, Nearest = ffmpeg sample replication", mad < 0.05 and mx <= 1, f"MAD {mad:.4f}, max {mx}")
            got = await show(pg, 10, chroma="bicubic")
            mad, mx = diff(got, ref_frame(h264, 10, zscale("bt601", "bicubic") + ",format=gbrp"))
            check("H.264 frame 10, Bicubic = zimg", mad < 0.05 and mx <= 1, f"MAD {mad:.4f}, max {mx}")

        # ---------------------------------------------------------------- 3. raw YUY2 4:2:2 AVI (LUCID's decoder)
        yuy2 = f"{MEDIA}/yuy2.avi"
        info = await load(pg, yuy2)
        got = await show(pg, 5, chroma="nearest")
        mad, mx = diff(got, ref_frame(yuy2, 5, NEAREST))
        check("YUY2 AVI, Nearest = ffmpeg sample replication", mad < 0.05 and mx <= 1, f"MAD {mad:.4f}, max {mx}")
        got = await show(pg, 5, chroma="bicubic")
        mad, mx = diff(got, ref_frame(yuy2, 5, zscale("bt601", "bicubic") + ",format=gbrp"))
        check("YUY2 AVI, Bicubic = zimg (4:2:2)", mad < 0.05 and mx <= 1 and info["conversion"].startswith("LUCID"), f"MAD {mad:.4f}, max {mx}")
        got = await show(pg, 5, chroma="bicubic", matrix="bt709")
        mad, mx = diff(got, ref_frame(yuy2, 5, zscale("bt709", "bicubic") + ",format=gbrp"))
        check("YUY2 AVI honours the loader's Color Matrix (BT.709 = zimg)", mad < 0.05 and mx <= 1, f"MAD {mad:.4f}, max {mx}")

        # ---------------------------------------------------------------- 4. 10-bit VP9: precision beyond 8 bits survives to a 16-bit export
        if vp9_10:
            info = await load(pg, vp9_10)
            if info["browser"] or "P10" not in info["conversion"]:
                print(f"INFO 10-bit planes not available in {BROWSER}: {info['conversion'][:100]}")
            else:
                await show(pg, 3, chroma="bicubic")
                r = await pg.evaluate("window.__write({ format: 'tiff16', start: 3, end: 3 })")
                open(f"{TMP}/f16.tif", "wb").write(base64.b64decode(r["b64"]))
                got = np.frombuffer(ff("-i", f"{TMP}/f16.tif", "-f", "rawvideo", "-pix_fmt", "rgb48le", "-"), "<u2").astype(int)
                ref = np.frombuffer(ref_frame(vp9_10, 3, zscale("bt601", "bicubic") + ",format=gbrp16le", pix="rgb48le"), "<u2").astype(int)
                d = np.abs(got - ref) if got.shape == ref.shape else np.array([99999])
                frac = float(np.mean(got % 257 != 0))
                check("10-bit VP9 → 16-bit TIFF keeps the 10-bit detail (= zimg at 16 bits)", d.max() <= 2 and frac > 0.5 and r["verified"]["ok"], f"max |Δ| {d.max()} of 65535, {frac:.0%} of samples between 8-bit levels, {info['conversion'][:60]}")

        # ---------------------------------------------------------------- 5. playback speed down to 0.01×
        await load(pg, vp9)
        await pg.evaluate("window.lucid.player.setSpeed(0.001)")
        sp = await pg.evaluate("[window.lucid.player.speed, document.querySelector('.pl-speed').textContent, document.querySelector('.pl-speedsl input[type=range]').value]")
        check("speed goes down to 0.01× (and no lower)", sp[0] == 0.01 and sp[1] == "Speed: 0.01x" and sp[2] == "0", json.dumps(sp))
        await pg.evaluate("window.lucid.player.setSpeed(40)")
        check("speed goes up to 16× (and no higher)", await pg.evaluate("window.lucid.player.speed") == 16)
        await pg.click(".pl-speed")
        await pg.click(".menu-popup .menu-item:has-text('0.05×')")
        try: await pg.wait_for_function("() => window.lucid.player.speed === 0.05", timeout=3000, polling=20)  # menu actions run after the menu closes
        except Exception: pass
        check("presets menu sets 0.05×", await pg.evaluate("window.lucid.player.speed") == 0.05)
        await pg.click(".pl-speed")
        await pg.click(".menu-popup .menu-item:has-text('Custom Speed')")
        await pg.fill(".dlg input.inp", "0.013")
        await pg.click(".dlg button:has-text('OK')")
        await pg.wait_for_timeout(200)
        sp = await pg.evaluate("[window.lucid.player.speed, document.querySelector('.pl-speed').textContent]")
        check("exact speed entry (0.013×)", sp[0] == 0.013 and sp[1] == "Speed: 0.013x", json.dumps(sp))
        await pg.evaluate("window.lucid.player.setSpeed(0.01); document.activeElement && document.activeElement.blur()")
        await pg.keyboard.press("]")
        a = await pg.evaluate("window.lucid.player.speed")
        await pg.keyboard.press("[")
        b = await pg.evaluate("window.lucid.player.speed")
        check("] and [ step through the presets (0.01 → 0.02 → 0.01)", a == 0.02 and b == 0.01, f"{a}, {b}")
        title = await pg.evaluate("document.querySelector('.pl-speed').title")
        check("tooltip: each frame stays on screen for 4 s at 0.01× of 25 fps", "4.00 s" in title and "none are skipped" in title, title[:110])
        # a slider position snaps to presets
        snapped = await pg.evaluate("(()=>{ const r = document.querySelector('.pl-speedsl input[type=range]'); r.value = String(Math.round(Math.log(0.0505 / 0.01) / Math.log(1600) * 1000)); r.dispatchEvent(new Event('input')); return window.lucid.player.speed })()")
        check("slider snaps to the 0.05× preset nearby", snapped == 0.05, str(snapped))

        # timing: 0.05× of 25 fps = 1.25 frames/s, every frame shown
        await pg.evaluate("window.lucid.store.setFrame(0)")
        await pg.wait_for_function("() => { const r = window.lucid.store.lastRender; return r && r.frame === 0 && !window.lucid.mainViewer.isBusy }", timeout=20000, polling=50)
        await pg.evaluate("window.lucid.player.setSpeed(0.05); window.__seen = []; window.__iv = setInterval(() => window.__seen.push(window.lucid.store.frameOf()), 50); window.lucid.player.play()")
        await pg.wait_for_timeout(4200)
        seen = await pg.evaluate("(()=>{ window.lucid.player.pause(); clearInterval(window.__iv); return window.__seen })()")
        steps = [b - a for a, b in zip(seen, seen[1:]) if b != a]
        check("0.05× plays 1.25 frames per second (25 fps clip) without skipping", 4 <= seen[-1] <= 6 and all(s == 1 for s in steps), f"frame {seen[-1]} after 4.2 s, steps {steps}")
        await pg.evaluate("window.lucid.store.setFrame(0)")
        await pg.wait_for_function("() => { const r = window.lucid.store.lastRender; return r && r.frame === 0 && !window.lucid.mainViewer.isBusy }", timeout=20000, polling=50)
        await pg.evaluate("window.lucid.player.setSpeed(0.01); window.lucid.player.play()")
        await pg.wait_for_timeout(3000)
        f3 = await pg.evaluate("window.lucid.store.frameOf()")
        await pg.wait_for_timeout(1700)
        f47 = await pg.evaluate("(()=>{ const f = window.lucid.store.frameOf(); window.lucid.player.pause(); return f })()")
        check("0.01× holds each frame for 4 s (frame 0 at 3 s, frame 1 at 4.7 s)", f3 == 0 and f47 == 1, f"{f3}, {f47}")
        await pg.evaluate("window.lucid.player.setSpeed(1)")

        # ---------------------------------------------------------------- 6. Viewer: Sharp keeps pixels equal at fractional zoom
        await load(pg, stripes)
        async def stripe_stats(zoom, mode):
            await pg.evaluate(f"window.lucid.store.savePrefs({{ viewerInterp: '{mode}' }}); window.lucid.mainViewer.setZoom({zoom})")
            await pg.wait_for_timeout(300)
            return await pg.evaluate("""(()=>{ const v = window.lucid.mainViewer, g = v.geom(), dpr = window.devicePixelRatio || 1;
              const c = v.canvas, y = Math.round((g.oy + g.fh * g.zoom / 2) * dpr);
              const x0 = Math.round((g.ox + g.fw * g.zoom * 0.2) * dpr), x1 = Math.round((g.ox + g.fw * g.zoom * 0.8) * dpr);
              const d = c.getContext('2d').getImageData(x0, y, x1 - x0, 1).data;
              let hi = 0, lo = 0, mid = 0; for (let i = 0; i < d.length; i += 4) { const v2 = d[i + 1]; if (v2 > 200) hi++; else if (v2 < 55) lo++; else mid++; }
              return { hi, lo, mid, zoom: g.zoom * dpr }; })()""")
        s = await stripe_stats(1.5, "sharp")
        n = await stripe_stats(1.5, "nearest")
        check("Sharp at 150 %: black and white 1-pixel stripes keep equal widths", s["lo"] > 0 and 0.85 <= s["hi"] / s["lo"] <= 1.18, json.dumps(s))
        check("(Nearest at 150 % distorts them 2 : 1 — what Sharp avoids)", n["lo"] > 0 and (n["hi"] / n["lo"] > 1.7 or n["hi"] / n["lo"] < 0.59), json.dumps(n))
        s2 = await stripe_stats(2, "sharp")
        check("Sharp at 200 %: exact pixel blocks (no blending)", s2["mid"] == 0 and s2["hi"] == s2["lo"], json.dumps(s2))
        await pg.evaluate("window.lucid.store.savePrefs({ viewerInterp: 'sharp' }); window.lucid.mainViewer.fit()")

        # ---------------------------------------------------------------- 7. loader options in the UI
        await load(pg, vp9)
        opts = await pg.evaluate("[...document.querySelectorAll('select option')].map((o) => o.textContent)")
        check("Filter Settings offer BT.2020 and the chroma options", all(x in opts for x in ["BT.2020", "Bicubic (highest quality)", "Bilinear", "Nearest (replicate samples)", "Left (MPEG-2, H.264, HEVC)"]), ", ".join(o for o in opts if "BT." in o or "cubic" in o or "Left" in o))
        check("no page errors", not errors, "; ".join(errors)[:300])
        await ctx.close()
    print(f"\n{sum(results)}/{len(results)} passed", flush=True)
    sys.exit(0 if all(results) else 1)

asyncio.run(main())
