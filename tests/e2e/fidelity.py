"""Input fidelity: high-bit-depth evidence is decoded exactly, without canvas.

- 16-bit TIFF (RGB and gray, LZW/deflate) and 16-bit PNG (filtered, compressed, interlaced) load at full
  precision: a 16-bit TIFF export of the loaded frame has exactly the source samples (ffmpeg as reference).
- TIFF image sequences load (browsers cannot decode TIFF), at full precision.
- A 32-bit float TIFF written by LUCID loads back with the same values (no display gamma).
- Copy Frame puts the exact pixels on the clipboard (Chromium).
- With Firefox's "resist fingerprinting" (canvas readback noise), LUCID warns, and PNG/TIFF stay exact.

Usage: URL=http://127.0.0.1:5199/ BROWSER=chromium|firefox|webkit LUCID_TMP=/disk/dir python3 tests/e2e/fidelity.py"""
import asyncio, base64, hashlib, json, os, shutil, subprocess, sys, tempfile, time
import numpy as np
import imageio_ffmpeg
from PIL import Image
from playwright.async_api import async_playwright

URL = os.environ.get("URL", "http://127.0.0.1:5199/")
BROWSER = os.environ.get("BROWSER", "chromium")
FF = imageio_ffmpeg.get_ffmpeg_exe()
TMP = tempfile.mkdtemp(prefix="lucid-fid-", dir=os.environ.get("LUCID_TMP") or None)
results = []
T0 = time.time()

def check(name, ok, info=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{info}]" if info else "") + f"  ({time.time() - T0:.0f}s)", flush=True)

def ff(*args):
    r = subprocess.run([FF, "-v", "error", "-y", *args], capture_output=True)
    if r.returncode: raise RuntimeError(r.stderr.decode()[:300])
    return r.stdout

def raw48(path):
    """16-bit RGB samples (little-endian) decoded by ffmpeg."""
    return ff("-i", path, "-f", "rawvideo", "-pix_fmt", "rgb48le", "-")

def make_inputs():
    src = "testsrc2=size=96x64:rate=1"
    paths = {}
    # 16-bit RGB TIFF, deflate; 16-bit gray TIFF, LZW (values use all 16 bits: noise added)
    ff("-f", "lavfi", "-i", src, "-f", "lavfi", "-i", "nullsrc=s=96x64", "-filter_complex", "[0]format=rgb48le,noise=alls=40:allf=t[v]", "-map", "[v]", "-frames:v", "1", "-compression_algo", "deflate", f"{TMP}/rgb48.tif"); paths["rgb48.tif"] = f"{TMP}/rgb48.tif"
    rng = np.random.default_rng(3)
    g = rng.integers(0, 65536, (64, 96), dtype=np.uint16)
    Image.fromarray(g).save(f"{TMP}/gray16.tif", compression="tiff_lzw"); paths["gray16.tif"] = f"{TMP}/gray16.tif"
    # 16-bit RGB PNG with filters and compression; 16-bit gray PNG (PIL)
    ff("-i", f"{TMP}/rgb48.tif", "-pix_fmt", "rgb48be", "-pred", "mixed", f"{TMP}/rgb48.png"); paths["rgb48.png"] = f"{TMP}/rgb48.png"
    Image.fromarray(g).save(f"{TMP}/gray16.png"); paths["gray16.png"] = f"{TMP}/gray16.png"
    # a 16-bit TIFF sequence of 3 images
    for i in range(3):
        ff("-f", "lavfi", "-i", f"testsrc2=size=96x64:rate=1,format=rgb48le,noise=alls=30:allf=t,lutrgb=r=val+{i * 997}", "-frames:v", "1", "-compression_algo", "lzw", f"{TMP}/seq_{i:04d}.tif")
    ff("-f", "lavfi", "-i", "testsrc2=size=96x64:rate=1", "-frames:v", "1", "-q:v", "3", f"{TMP}/photo.jpg"); paths["photo.jpg"] = f"{TMP}/photo.jpg"
    return paths

PAGE = """() => {
  window.__write = async (o) => { const s = window.lucid.store, e = window.lucid.engine, c = s.chain();
    const r = await e.call('write', Object.assign({ chainId: c.id, filterId: null, quality: 1, name: 'fx', taskId: 'fx' + Math.random(), verify: true, start: 0, end: 0 }, o));
    const b = new Uint8Array(await (r.blob || r.file).arrayBuffer()); let s2 = ''; for (let i = 0; i < b.length; i += 0x8000) s2 += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return { b64: btoa(s2), verified: r.verified, frames: r.frames }; };
  window.__dlg = () => [...document.querySelectorAll('.dlg')].map((d) => d.innerText).join(' | ');
  return true; }"""

async def load(pg, paths, sequence=False):
    before = await pg.evaluate("window.lucid.store.project.chains.length")
    async with pg.expect_file_chooser() as fc:
        await pg.evaluate(f"(()=>{{ window.lucid.actions.{'openSequence' if sequence else 'openMedia'}(); return null }})()")
    await (await fc.value).set_files(paths)
    await pg.wait_for_function(f"() => {{ const s = window.lucid.store; return s.project.chains.length > {before} && s.lastRender && s.lastRender.chainId === s.ui.chainId && !!s.lastRender.md5 }}", timeout=60000, polling=200)
    return await pg.evaluate("(()=>{ const s = window.lucid.store; const id = s.chain().filters[0].params.source; const i = s.sources.get(id); return { frames: i.frameCount, w: i.width, h: i.height, decoder: i.engine || i.decoder || '', meta: JSON.stringify(i.metadata) } })()")

async def export16(pg, frame=0):
    r = await pg.evaluate(f"window.__write({{ format: 'tiff16', start: {frame}, end: {frame} }})")
    p = f"{TMP}/out_{hashlib.md5(r['b64'].encode()).hexdigest()}.tif"
    open(p, "wb").write(base64.b64decode(r["b64"]))
    return p, r

async def run(p, rfp=False):
    profile = tempfile.mkdtemp(prefix="profile-", dir=TMP)
    kw = {}
    if BROWSER == "chromium": kw["args"] = ["--no-sandbox"]
    if rfp: kw["firefox_user_prefs"] = {"privacy.resistFingerprinting": True}
    ctx = await getattr(p, BROWSER).launch_persistent_context(profile, viewport={"width": 1568, "height": 898}, accept_downloads=True, **kw)
    pg = ctx.pages[0] if ctx.pages else await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await pg.goto(URL, wait_until="networkidle")
    await pg.wait_for_function("() => !!(window.lucid && window.lucid.store)", timeout=30000)
    await pg.evaluate(PAGE)
    return ctx, pg, errors

async def main():
    paths = make_inputs()
    async with async_playwright() as p:
        ctx, pg, errors = await run(p)
        print(f"{BROWSER}: {await pg.evaluate('navigator.userAgent')}", flush=True)
        await pg.wait_for_timeout(2500)
        pix = await pg.evaluate("window.lucid.actions.pixelCheck()")
        print(f"INFO pixel readback: {json.dumps(pix)}", flush=True)
        check("normal window: canvas readback exact, no warning", pix["engineCanvas"] and pix["pageCanvas"] and "Pixels Altered" not in await pg.evaluate("window.__dlg()"))

        # 1. 16-bit TIFF and PNG at full precision
        for name in ["rgb48.tif", "gray16.tif", "rgb48.png", "gray16.png"]:
            info = await load(pg, [paths[name]])
            out, r = await export16(pg)
            ref, got = raw48(paths[name]), raw48(out)
            frac = float(np.mean(np.frombuffer(got, "<u2") % 257 != 0))
            check(f"{name}: loaded at full 16-bit precision (TIFF 16-bit export = source samples)", got == ref and len(ref) == 96 * 64 * 6 and frac > 0.5 and r["verified"]["ok"], f"{info['decoder']}; {frac:.0%} of samples between 8-bit levels")

        # 2. TIFF sequence (browsers cannot decode TIFF), full precision
        seq = [f"{TMP}/seq_{i:04d}.tif" for i in range(3)]
        info = await load(pg, seq, sequence=True)
        ok = info["frames"] == 3
        for i in range(3):
            out, _ = await export16(pg, i)
            ok = ok and raw48(out) == raw48(seq[i])
        check("16-bit TIFF sequence loads, every image at full precision", ok, f"{info['frames']} frames")

        # 3. 32-bit float TIFF written by LUCID loads back unchanged (no display gamma)
        await pg.evaluate("window.lucid.actions.addFilter('gaussian_filter', { sigma: 1.3 })")
        await pg.wait_for_function("() => { const s = window.lucid.store; return s.chain().filters.length === 2 && s.lastRender && s.lastRender.md5 }", timeout=30000)
        r = await pg.evaluate("window.__write({ format: 'tiff32f' })")
        open(f"{TMP}/float.tif", "wb").write(base64.b64decode(r["b64"]))
        a16, _ = await export16(pg)
        await load(pg, [f"{TMP}/float.tif"])
        b16, _ = await export16(pg)
        r2 = await pg.evaluate("window.__write({ format: 'tiff32f' })")
        fa = np.frombuffer(base64.b64decode(r["b64"])[-96 * 64 * 12:], "<f4"); fb = np.frombuffer(base64.b64decode(r2["b64"])[-96 * 64 * 12:], "<f4")
        rel = float(np.max(np.abs(fa - fb) / np.maximum(np.abs(fa), 1e-6)))
        check("float TIFF loads back with the same values (no display gamma)", raw48(a16) == raw48(b16) and rel < 1e-6, f"max relative difference {rel:.1e}")

        await load(pg, [paths["photo.jpg"]])
        jpeg_md5 = await pg.evaluate("window.lucid.store.lastRender.md5")

        # 4. Copy Frame: exact pixels on the clipboard (Chromium exposes the clipboard to tests)
        if BROWSER == "chromium" and not URL.startswith("file:"):  # clipboard permissions cannot be granted to file:// pages
            await ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=URL.rstrip("/"))
            await pg.bring_to_front()
            await pg.evaluate("window.lucid.actions.copyFrame()")
            b64 = await pg.evaluate("""(async()=>{ const items = await navigator.clipboard.read(); const b = await items[0].getType('image/png'); const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); })()""")
            open(f"{TMP}/clip.png", "wb").write(base64.b64decode(b64))
            md5 = hashlib.md5(ff("-i", f"{TMP}/clip.png", "-f", "rawvideo", "-pix_fmt", "rgb24", "-")).hexdigest()
            cur = await pg.evaluate("window.lucid.store.lastRender.md5")
            check("Copy Frame: the clipboard image has exactly the frame's pixels", md5 == cur, md5)
        check("no uncaught page errors", not errors, "; ".join(errors)[:200])
        await ctx.close()

        # 5. Firefox "resist fingerprinting": canvas readback is perturbed; LUCID warns, PNG/TIFF stay exact
        if BROWSER == "firefox":
            ctx, pg, errors = await run(p, rfp=True)
            await pg.wait_for_function("() => window.__dlg().includes('Pixels Altered')", timeout=15000)
            pix = await pg.evaluate("window.lucid.actions.pixelCheck()")
            check("resist fingerprinting: canvas noise detected and the user warned", not (pix["engineCanvas"] and pix["pageCanvas"]), json.dumps(pix))
            await pg.evaluate("[...document.querySelectorAll('.dlg-footer button')].pop().click()")
            for name in ["rgb48.png", "rgb48.tif"]:
                await load(pg, [paths[name]])
                out, _ = await export16(pg)
                check(f"resist fingerprinting: {name} still decoded exactly", raw48(out) == raw48(paths[name]))
            await load(pg, [paths["photo.jpg"]])
            m = await pg.evaluate("window.lucid.store.lastRender.md5")
            check("resist fingerprinting: a JPEG (browser decoder, read through a VideoFrame) has the same pixels as in a normal window", m == jpeg_md5 and pix["videoFrame"], m)
            await ctx.close()
    print(f"\n{sum(results)}/{len(results)} checks passed")
    sys.exit(0 if all(results) else 1)

try: asyncio.run(main())
finally: shutil.rmtree(TMP, ignore_errors=True)
