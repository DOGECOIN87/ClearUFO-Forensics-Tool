"""Lossless output suite: every export is checked bit for bit with independent decoders (ffmpeg,
Python zipfile/zlib, a NumPy TIFF reader) against the frames the application computes.
Usage: URL=http://127.0.0.1:5199/ [BROWSER=chromium|firefox|webkit] python3 tests/e2e/lossless.py [media_dir]
Requires: pip install playwright imageio-ffmpeg numpy"""
import asyncio, base64, hashlib, io, json, os, re, shutil, struct, subprocess, sys, tempfile, time, zipfile, zlib
import numpy as np
import imageio_ffmpeg
from playwright.async_api import async_playwright

URL = os.environ.get("URL", "http://127.0.0.1:5199/")
MEDIA = sys.argv[1] if len(sys.argv) > 1 else "/tmp/lucid-testmedia"
BROWSER = os.environ.get("BROWSER", "chromium")
FF = imageio_ffmpeg.get_ffmpeg_exe()
# exported files land here; removed at the end (set LUCID_TMP to keep large files off a RAM-backed /tmp)
TMP = tempfile.mkdtemp(prefix="lucid-lossless-", dir=os.environ.get("LUCID_TMP") or None)
results = []

T0 = time.time()
def check(name, ok, info=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{info}]" if info else "") + f"  ({time.time() - T0:.0f}s)", flush=True)

def ffmpeg_frames(path, pix="rgb24", extra=()):
    """MD5 of every decoded frame (ffmpeg framemd5) in the given pixel format."""
    r = subprocess.run([FF, "-v", "error", *extra, "-i", path, "-map", "0:v:0", "-f", "framemd5", "-pix_fmt", pix, "-"], capture_output=True, text=True)
    return [l.split(",")[-1].strip() for l in r.stdout.splitlines() if l and not l.startswith("#")], r.stderr.strip()

def ffmpeg_frames_bytes(data, ext):
    path = f"{TMP}/tmp_{hashlib.md5(data).hexdigest()}.{ext}"; open(path, "wb").write(data)
    return ffmpeg_frames(path)

def ffmpeg_raw_bytes(data, pix):
    path = f"{TMP}/raw_{hashlib.md5(data).hexdigest()}.bin"; open(path, "wb").write(data)
    return ffmpeg_raw(path, pix)[0]

def ffmpeg_raw(path, pix):
    r = subprocess.run([FF, "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", pix, "-"], capture_output=True)
    return r.stdout, r.stderr.decode().strip()

def tiff_float(data):
    """Minimal independent reader for the float TIFF: header, IFD, strip offset, SampleFormat."""
    assert data[:4] == b"II*\x00"
    ifd = struct.unpack_from("<I", data, 4)[0]; n = struct.unpack_from("<H", data, ifd)[0]; tags = {}
    for i in range(n):
        tag, typ, cnt, val = struct.unpack_from("<HHII", data, ifd + 2 + i * 12)
        if typ == 3 and cnt == 1: val &= 0xFFFF
        if typ == 3 and cnt == 3: val = struct.unpack_from("<3H", data, val)
        tags[tag] = val
    w, h = tags[256], tags[257]
    assert tags[259] == 1, "compression must be none"
    return w, h, tags, np.frombuffer(data, "<f4", count=w * h * 3, offset=tags[273])

def png_blocks_stored(data):
    """True when every deflate block in the PNG's IDAT stream is stored (BTYPE 00)."""
    p, z = 8, b""
    while p < len(data):
        ln = struct.unpack_from(">I", data, p)[0]; cid = data[p + 4:p + 8]
        if cid == b"IDAT": z += data[p + 8:p + 8 + ln]
        p += 12 + ln
    q, last = 2, 0
    while not last:
        hd = z[q]; last = hd & 1
        if (hd >> 1) & 3: return False
        ln = z[q + 1] | (z[q + 2] << 8); q += 5 + ln
    return q + 4 == len(z)

PAGE_HELPERS = """() => {
  window.__b64 = async (blob) => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  window.__write = async (o) => { const s = window.lucid.store, e = window.lucid.engine, c = s.chain();
    const r = await e.call('write', Object.assign({ chainId: c.id, filterId: null, quality: 0.9, name: 'lt', taskId: 'lt' + Math.random(), verify: true }, o));
    window.__last = r; return { bytes: r.bytes, frames: r.frames, verified: r.verified, hashes: r.hashes, name: r.name, saved: r.savedToDisk, size: r.blob ? r.blob.size : -1, w: r.width, h: r.height, codec: r.codec }; };
  window.__dlgText = () => [...document.querySelectorAll('.dlg')].map((d) => d.innerText).join(' | ');
  window.__clickBtn = (label) => { const b = [...document.querySelectorAll('.dlg-footer button')].reverse().find((x) => x.textContent.trim() === label); if (b) b.click(); return !!b; };
  return true; }"""

async def fetch(pg, expr="window.__last.blob"):
    return base64.b64decode(await pg.evaluate(f"(async () => window.__b64({expr}))()"))

async def fetch_file(pg, expr, name):
    """Large files: a download streams to disk (a huge base64 string through the driver is very slow)."""
    async with pg.expect_download(timeout=120000) as dl:
        await pg.evaluate(f"(()=>{{ const a = document.createElement('a'); a.href = URL.createObjectURL({expr}); a.download = '{name}'; document.body.appendChild(a); a.click(); a.remove(); return null }})()")
    return open(await (await dl.value).path(), "rb").read()

async def load(pg, path, timeout=60000):
    before = await pg.evaluate("window.lucid.store.project.chains.length")
    async with pg.expect_file_chooser() as fc:
        await pg.evaluate("(()=>{ window.lucid.actions.openMedia(); return null })()")
    await (await fc.value).set_files([path])
    await pg.wait_for_function(f"() => {{ const s = window.lucid.store; return s.project.chains.length > {before} && s.lastRender && s.lastRender.chainId === s.ui.chainId && !!s.lastRender.md5 }}", timeout=timeout, polling=200)

async def frame_hashes(pg):
    return await pg.evaluate("(async()=>{ const s=window.lucid.store; return await window.lucid.engine.call('hashFrames', s.ui.chainId, 'hf'+Math.random()) })()")

async def main():
    async with async_playwright() as p:
        # fake cameras: Chromium flags, Firefox preferences; Playwright's WebKit has mock capture devices
        args = ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] if BROWSER == "chromium" else []
        ff_prefs = {"media.navigator.streams.fake": True, "media.navigator.permission.disabled": True} if BROWSER == "firefox" else None
        # a normal (persistent) profile: private contexts get a tiny storage quota, unlike real users
        profile = tempfile.mkdtemp(prefix="profile-", dir=TMP)
        ctx = await getattr(p, BROWSER).launch_persistent_context(profile, args=args, viewport={"width": 1568, "height": 898}, accept_downloads=True, **({"firefox_user_prefs": ff_prefs} if ff_prefs else {}))
        b = ctx
        try: await ctx.grant_permissions(["camera"])
        except Exception as e: print(f"INFO camera permission not granted: {str(e)[:80]}")
        pg = ctx.pages[0] if ctx.pages else await ctx.new_page()
        print(f"{BROWSER} {await pg.evaluate('navigator.userAgent')}", flush=True)
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL, wait_until="networkidle")
        await pg.wait_for_function("() => !!(window.lucid && window.lucid.store)", timeout=30000)
        await pg.evaluate(PAGE_HELPERS)
        prefs = await pg.evaluate("(()=>{ const p = window.lucid.store.prefs; return { losslessOnly: p.losslessOnly, verifyExports: p.verifyExports, saveToDisk: p.saveToDisk, videoFormat: p.videoFormat, imageFormat: p.imageFormat } })()")
        check("defaults: lossless only, verification on, AVI uncompressed / TIFF 16-bit", prefs == {"losslessOnly": True, "verifyExports": True, "saveToDisk": True, "videoFormat": "avi-raw", "imageFormat": "tiff16"}, json.dumps(prefs))

        # 1. identity: uncompressed source → uncompressed AVI reproduces every source frame exactly
        src = f"{MEDIA}/bgr24.avi"
        await load(pg, src)
        r = await pg.evaluate("window.__write({ format: 'avi-raw', start: 0, end: 24 })")
        avi = await fetch(pg); open(f"{TMP}/identity.avi", "wb").write(avi)
        src_md5, _ = ffmpeg_frames(src)
        out_md5, warn = ffmpeg_frames(f"{TMP}/identity.avi")
        check("AVI export of an uncompressed source is bit-identical to the source (ffmpeg)", out_md5 == src_md5 and len(out_md5) == 25, f"{len(out_md5)} frames{', ffmpeg: ' + warn if warn else ''}")
        app = await frame_hashes(pg)
        check("written frames equal the application's frame hashes", r["hashes"] == app and out_md5 == app, f"{len(app)} frames")
        check("engine verification: read back bit-identical", r["verified"] and r["verified"]["ok"], r["verified"] and r["verified"]["message"])
        check("AVI size: header + 25 × 230,400-byte frames", r["size"] == r["bytes"] == len(avi) and 25 * 230400 < len(avi) < 25 * 230400 + 64 * 1024, f"{len(avi)} bytes")

        # 2. processing with fractional results: 8-bit, 16-bit and 32-bit float exports agree
        await pg.evaluate("window.lucid.actions.addFilter('gaussian_filter', { sigma: 1.37 })")
        await pg.wait_for_function("() => { const s = window.lucid.store, r = s.lastRender; return r && r.filterId && r.md5 && s.chain().filters.length === 2 }", timeout=30000, polling=200)
        k = 5
        app = await frame_hashes(pg)
        out = {}
        for fmt in ["png", "tiff", "bmp", "png16", "tiff16", "tiff32f"]:
            r = await pg.evaluate(f"window.__write({{ format: '{fmt}', start: {k}, end: {k} }})")
            out[fmt] = (r, await fetch(pg))
            open(f"{TMP}/f.{fmt}", "wb").write(out[fmt][1])
        check("single images verified (PNG/TIFF/BMP 8-bit, PNG/TIFF 16-bit, TIFF float)", all(v[0]["verified"] and v[0]["verified"]["ok"] for v in out.values()), json.dumps({f: v[0]["verified"]["ok"] for f, v in out.items()}))
        for fmt in ["png", "tiff", "bmp"]:
            m, warn = ffmpeg_frames(f"{TMP}/f.{fmt}")
            check(f"{fmt.upper()} 8-bit decodes (ffmpeg) to the application's frame", m == [app[k]], warn or m[:1])
        check("PNG uses stored (uncompressed) deflate blocks only", png_blocks_stored(out["png"][1]) and png_blocks_stored(out["png16"][1]))
        raw16t, w1 = ffmpeg_raw(f"{TMP}/f.tiff16", "rgb48le")
        raw16p, w2 = ffmpeg_raw(f"{TMP}/f.png16", "rgb48le")
        check("TIFF 16-bit and PNG 16-bit decode (ffmpeg) to identical samples", raw16t == raw16p and len(raw16t) == 320 * 240 * 6, w1 or w2)
        check("16-bit samples match the written hash", hashlib.md5(raw16t).hexdigest() == out["tiff16"][0]["hashes"][0])
        v16 = np.frombuffer(raw16t, "<u2").astype(np.int64)
        w, h, tags, vf = tiff_float(out["tiff32f"][1])
        # every sample whose processed value lies between two 8-bit levels must keep that fraction in 16-bit
        between = np.abs(vf.astype(np.float64) * 255 - np.round(vf.astype(np.float64) * 255)) * 257 >= 0.5
        frac16, fracf = float(np.mean(v16 % 257 != 0)), float(np.mean(between))
        check("16-bit keeps the fractional values the processing computed", fracf > 0.05 and abs(frac16 - fracf) < 0.002, f"{frac16:.1%} of 16-bit samples between 8-bit levels, {fracf:.1%} in the float data")
        check("TIFF float: 32-bit IEEE samples (SampleFormat 3), no compression", tags[339] == (3, 3, 3) and tags[258] == (32, 32, 32) and w == 320 and h == 240, str(tags.get(339)))
        exp16 = np.where(vf * 255 >= 255, 65535, np.where(vf <= 0, 0, np.round(np.clip(vf.astype(np.float64) * 255, 0, 255) * 257))).astype(np.int64)
        diff = np.abs(exp16 - v16)
        check("TIFF float and TIFF 16-bit agree (float × 255 × 257 = 16-bit)", int(diff.max()) <= 1 and float(np.mean(diff > 0)) < 1e-3, f"max diff {int(diff.max())}, {int((diff > 0).sum())} samples off by 1")
        raw8, _ = ffmpeg_raw(f"{TMP}/f.png", "rgb24")
        v8 = np.frombuffer(raw8, np.uint8).astype(np.int64)
        check("8-bit is the 16-bit value rounded (same processing, lower precision)", int(np.abs(np.round(v16 / 257) - v8).max()) <= 1)
        fl, wf = ffmpeg_raw(f"{TMP}/f.tiff32f", "gbrpf32le")
        if fl and not wf:
            g = np.frombuffer(fl, "<f4").reshape(3, h, w)  # planar G, B, R
            rgb = np.stack([g[2], g[0], g[1]], -1).reshape(-1)
            check("TIFF float decodes (ffmpeg) to the same floats", np.array_equal(rgb, vf))
        else: print(f"INFO ffmpeg cannot decode float TIFF here: {wf[:120]}")

        # 3. image sequence: 16-bit TIFF frames in a stored ZIP
        r = await pg.evaluate("window.__write({ format: 'tiff16', start: 0, end: 4, name: 'seq' })")
        z = zipfile.ZipFile(io.BytesIO(await fetch(pg)))
        names = [i.filename for i in z.infolist()]
        check("sequence: ZIP with 5 numbered TIFF files, all stored (no compression)", names == [f"seq_{i:04d}.tif" for i in range(5)] and all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist()) and z.testzip() is None, ", ".join(names))
        ok = True
        for i, nm in enumerate(names):
            open(f"{TMP}/{nm}", "wb").write(z.read(nm))
            raw, _ = ffmpeg_raw(f"{TMP}/{nm}", "rgb48le")
            ok = ok and hashlib.md5(raw).hexdigest() == r["hashes"][i]
        check("sequence frames decode (ffmpeg) to the written 16-bit samples", ok and r["verified"]["ok"], r["verified"]["message"])

        # 4. OpenDML in the browser: small segments force several RIFF segments
        r = await pg.evaluate("window.__write({ format: 'avi-raw', start: 0, end: 24, segmentBytes: 1000000 })")
        odml = await fetch(pg); open(f"{TMP}/odml.avi", "wb").write(odml)
        segs = len(re.findall(rb"RIFF....AVIX", odml, re.S))
        m, warn = ffmpeg_frames(f"{TMP}/odml.avi")
        check("OpenDML AVI (several RIFF segments) decodes (ffmpeg) to the processed frames", segs >= 5 and m == app and not warn, f"{segs} AVIX segments{', ' + warn if warn else ''}")
        check("OpenDML AVI verified by the application's reader", r["verified"]["ok"], r["verified"]["message"])
        await load(pg, f"{TMP}/odml.avi")
        info = await pg.evaluate("(()=>{ const s=window.lucid.store; const c=s.chain(); const src=c.filters[0]; const id=src.params.source; const i=s.sources.get(id); return i && { frames: i.frameCount, meta: JSON.stringify(i.metadata) + JSON.stringify(i.warnings) } })()")
        check("the exported OpenDML AVI loads back with all 25 frames", info and info["frames"] == 25, json.dumps(info)[:160])
        check("re-loaded frames are identical to the exported ones", await frame_hashes(pg) == app)
        await pg.evaluate("(()=>{ const s=window.lucid.store; s.setUi({ chainId: s.project.chains[0].id }); })()")
        await pg.wait_for_timeout(500)

        # 5. writing straight to a file (File System Access; OPFS stands in for the save dialog)
        # OPFS is not available everywhere (e.g. file:// pages): probe it
        fs_ok = await pg.evaluate("(async()=>{ try { if (typeof FileSystemFileHandle === 'undefined' || !('createWritable' in FileSystemFileHandle.prototype)) return false; await navigator.storage.getDirectory(); return true } catch (e) { return false } })()")
        if fs_ok:
            res = await pg.evaluate("""(async()=>{ const root = await navigator.storage.getDirectory(); const fh = await root.getFileHandle('lucid-direct.avi', { create: true });
              const r = await window.__write({ format: 'avi-raw', start: 0, end: 24, handle: fh }); window.__direct = await fh.getFile(); return r; })()""")
            direct = await fetch(pg, "window.__direct")
            await pg.evaluate("window.__write({ format: 'avi-raw', start: 0, end: 24 })")
            mem = await fetch(pg)
            check("direct-to-disk export: same bytes as the in-memory export, verified", res["saved"] and res["size"] == -1 and direct == mem and res["verified"]["ok"] and res["name"] == "lucid-direct.avi", f"{len(direct)} bytes")
        else: print(f"INFO {BROWSER}: no writable file handles here (OPFS unavailable), direct-to-disk path not exercised")

        # 6. Write Video dialog: lossless formats only, size estimate, download verified
        await pg.evaluate("window.lucid.store.savePrefs({ saveToDisk: false })")
        await pg.evaluate("void window.lucid.actions.writeVideo()")
        await pg.wait_for_selector(".dlg .export-note", timeout=10000)
        d = await pg.evaluate("""(()=>{ const dlg=[...document.querySelectorAll('.dlg')].pop(); const row=[...dlg.querySelectorAll('.form-row')].find(r=>r.textContent.startsWith('Format:')); const sel=row.querySelector('select');
          const q=[...dlg.querySelectorAll('.form-row')].find(r=>r.textContent.startsWith('Quality')); return { value: sel.value, options: [...sel.options].map(o=>o.textContent), qualityHidden: !q || q.hidden, note: dlg.querySelector('.export-note').innerText } })()""")
        check("Write Video lists only uncompressed formats, AVI first", d["value"] == "avi-raw" and not any("lossy" in o.lower() for o in d["options"]) and len(d["options"]) == 6, "; ".join(d["options"]))
        check("no Quality control and an exact size in the dialog", d["qualityHidden"] and "No compression" in d["note"] and "Size:" in d["note"], d["note"][:160])
        async with pg.expect_download(timeout=60000) as dl:
            await pg.evaluate("window.__clickBtn('Write')")
        path = await (await dl.value).path()
        m, _ = ffmpeg_frames(path)
        await pg.wait_for_function("() => (document.querySelector('.toasts')||{}).innerText?.includes('Verified')", timeout=30000)
        check("dialog export downloads a verified uncompressed AVI identical to the frames", m == app, f"{len(m)} frames")
        await pg.evaluate("window.lucid.store.savePrefs({ losslessOnly: false })")
        await pg.evaluate("void window.lucid.actions.writeVideo()")
        await pg.wait_for_selector(".dlg .export-note", timeout=10000)
        opts = await pg.evaluate("(()=>{ const dlg=[...document.querySelectorAll('.dlg')].pop(); return [...dlg.querySelector('select').options].map(o=>o.textContent) })()")
        await pg.evaluate("window.__clickBtn('Cancel')")
        check("lossy formats appear (marked lossy) only when allowed in Settings", sum("(lossy)" in o for o in opts) == 3, "; ".join(opts))
        await pg.evaluate("window.lucid.store.savePrefs({ losslessOnly: true })")

        # 6b. "Choose where to save": the dialog's save picker hands a file to the engine, which writes it directly
        if fs_ok:
            await pg.evaluate("""(()=>{ window.__picked = null; window.showSaveFilePicker = async (o) => { window.__picked = o.suggestedName; const root = await navigator.storage.getDirectory(); return root.getFileHandle(o.suggestedName, { create: true }); };
              window.lucid.store.savePrefs({ saveToDisk: true }); })()""")
            await pg.evaluate("void window.lucid.actions.writeImages()")
            await pg.wait_for_selector(".dlg .export-note", timeout=10000)
            note = await pg.evaluate("[...document.querySelectorAll('.dlg')].pop().querySelector('.export-note').innerText")
            await pg.evaluate("window.__clickBtn('Write')")
            await pg.wait_for_function("() => /to disk/.test((document.querySelector('.toasts')||{}).innerText || '')", timeout=30000)
            toast = await pg.evaluate("(document.querySelector('.toasts')||{}).innerText")
            picked = await pg.evaluate("window.__picked")
            data = await fetch(pg, "await (await (await navigator.storage.getDirectory()).getFileHandle(window.__picked)).getFile()")
            open(f"{TMP}/picked.tif", "wb").write(data)
            raw, _ = ffmpeg_raw(f"{TMP}/picked.tif", "rgb48le")
            ref = await pg.evaluate("window.__write({ format: 'tiff16', start: window.lucid.store.frameOf(), end: window.lucid.store.frameOf() })")
            check("save picker: TIFF 16-bit written straight to the chosen file and verified", picked and picked.endswith(".tif") and "written straight to disk" in note and "Verified" in toast and hashlib.md5(raw).hexdigest() == ref["hashes"][0], f"{picked}; {toast.splitlines()[-1][:140]}")
            await pg.evaluate("window.lucid.store.savePrefs({ saveToDisk: false })")

        # 6c. staging: without a save dialog, exports are written to disk in the browser's storage (OPFS) and
        # downloaded from there; the staging file is locked while this tab may use it, swept when orphaned
        st = await pg.evaluate("(async()=>{ const s = await window.lucid.actions.staging.status(); return { ok: s.ok, api: s.api || null, reason: s.reason || null, room: s.room } })()")
        print(f"INFO staging: {json.dumps(st)}", flush=True)
        if st["ok"]:
            await pg.evaluate("(()=>{ window.lucid.actions.staging.minBytes = 0; window.lucid.store.savePrefs({ saveToDisk: false }); window.__stagedToasts = 0; })()")
            await pg.evaluate("void window.lucid.actions.writeVideo()")
            await pg.wait_for_selector(".dlg .export-note", timeout=10000)
            note = await pg.evaluate("[...document.querySelectorAll('.dlg')].pop().querySelector('.export-note').innerText")
            async with pg.expect_download(timeout=60000) as dl:
                await pg.evaluate("window.__clickBtn('Write')")
            d = await dl.value
            staged_dl = open(await d.path(), "rb").read(); open(f"{TMP}/staged.avi", "wb").write(staged_dl)
            await pg.wait_for_function("() => /staged on disk/.test((document.querySelector('.toasts')||{}).innerText || '')", timeout=30000)
            toast = await pg.evaluate("(document.querySelector('.toasts')||{}).innerText")
            m, warn = ffmpeg_frames(f"{TMP}/staged.avi")
            check("staged export: note, verified, downloaded AVI identical to the frames (ffmpeg)", "browser's storage" in note and "Verified" in toast and m == app and d.suggested_filename.endswith(".avi"), f"{st['api']}; {d.suggested_filename}; {len(m)} frames; {note.splitlines()[-1][:90]}")
            info = await pg.evaluate("""(async()=>{ const st = window.lucid.actions.staging; const it = st.list()[0];
              const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('lucid-staging');
              const names = []; for await (const k of dir.keys()) names.push(k);
              const f = await (await dir.getFileHandle(it.entry)).getFile();
              const q = await navigator.locks.query();
              return { entry: it.entry, name: it.name, bytes: it.bytes, size: f.size, names, locked: q.held.some(l => l.name === 'lucid-staged:' + it.entry) } })()""")
            check("staging file kept in the browser's storage, same size, locked by this tab", info["size"] == info["bytes"] == len(staged_dl) and info["locked"] and info["names"] == [info["entry"]], f"{info['entry']} {info['size']} bytes")
            # orphans of closed tabs: removed when older than an hour, recent ones and locked ones kept
            old, recent = await pg.evaluate("""(async()=>{ const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('lucid-staging');
              const mk = async (n) => { const w = await (await dir.getFileHandle(n, { create: true })).createWritable(); await w.write(new Uint8Array(10)); await w.close(); return n; };
              return [await mk((Date.now() - 2 * 3600e3).toString(36) + '-old1-orphan.avi'), await mk(Date.now().toString(36) + '-new1-recent.avi')]; })()""")
            removed = await pg.evaluate("window.lucid.actions.staging.sweep()")
            names = await pg.evaluate("(async()=>{ const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('lucid-staging'); const a = []; for await (const k of dir.keys()) a.push(k); return a.sort() })()")
            check("sweep removes old orphans only (keeps recent and locked files)", removed == 1 and old not in names and recent in names and info["entry"] in names, f"removed {removed}; left {names}")
            # Settings shows the staged download; Free removes it and releases the lock
            await pg.evaluate("void window.lucid.actions.preferences()")
            await pg.wait_for_function("() => /Staged downloads: 1 file/.test((document.querySelector('.staging-info')||{}).innerText || '')", timeout=10000)
            await pg.evaluate("window.__clickBtn('Cancel')")
            freed = await pg.evaluate(f"window.lucid.actions.staging.free(['{info['entry']}'])")
            after = await pg.evaluate(f"""(async()=>{{ const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('lucid-staging'); const a = []; for await (const k of dir.keys()) a.push(k);
              const q = await navigator.locks.query(); return {{ names: a, locked: q.held.some(l => l.name === 'lucid-staged:{info['entry']}'), list: window.lucid.actions.staging.list().length }} }})()""")
            check("Free removes the staging file and releases its lock", freed == info["bytes"] and info["entry"] not in after["names"] and not after["locked"] and after["list"] == 0, json.dumps(after))
            await pg.evaluate(f"(async()=>{{ const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('lucid-staging'); await dir.removeEntry('{recent}'); }})()")
            # a staged image sequence (ZIP) too
            async with pg.expect_download(timeout=60000) as dl:
                r = await pg.evaluate("""(async()=>{ const s = window.lucid.store; const st = window.lucid.actions.staging; const entry = await st.reserve('seq.zip', 'export');
                  const r = await window.lucid.engine.call('write', { chainId: s.chain().id, filterId: null, format: 'tiff16', quality: 1, start: 0, end: 4, name: 'seq', taskId: 'stz', verify: true, stage: entry });
                  st.done(entry, r.file, r.bytes); st.download(entry); return { verified: r.verified, bytes: r.bytes, staged: r.staged === entry, blob: !!r.blob, saved: r.savedToDisk, hashes: r.hashes }; })()""")
            z = zipfile.ZipFile(io.BytesIO(open(await (await dl.value).path(), "rb").read()))
            same = all(hashlib.md5(ffmpeg_raw_bytes(z.read(nm), "rgb48le")).hexdigest() == r["hashes"][i] for i, nm in enumerate(sorted(z.namelist())))
            check("staged 16-bit TIFF sequence: stored ZIP, verified, frames identical (ffmpeg)", r["staged"] and not r["blob"] and not r["saved"] and r["verified"]["ok"] and z.testzip() is None and same and len(z.namelist()) == 5, r["verified"]["message"])
            await pg.evaluate("(async()=>{ const st = window.lucid.actions.staging; await st.free(st.list().map(i => i.entry)); })()")
        else: print(f"INFO {BROWSER}: no browser storage for staging here ({st['reason']}); exports are assembled in memory")

        # 7. lossy guard: a writer filter set to a lossy format refuses to write
        await pg.evaluate("window.lucid.actions.addFilter('video_writer', { format: 'mp4' })")
        await pg.wait_for_timeout(400)
        await pg.evaluate("(()=>{ const s=window.lucid.store; const f=s.chain().filters.at(-1); void window.lucid.actions.filterAction('write', f.id); })()")
        await pg.wait_for_function("() => window.__dlgText().includes('Lossy Format Disabled')", timeout=10000)
        check("lossy writer format refused while Lossless exports only is on", True)
        await pg.evaluate("window.__clickBtn('OK') || document.querySelector('.dlg-x').click()")
        panel = await pg.evaluate("document.body.innerText.includes('lossy formats are disabled')")
        check("Filter Settings warns about the lossy format", panel)
        await pg.evaluate("(()=>{ const s=window.lucid.store; const f=s.chain().filters.at(-1); return window.lucid.actions.removeFilter(f.id) })()")
        await pg.wait_for_timeout(400)

        # 8. snapshot: uncompressed PNG of the full-resolution frame
        async with pg.expect_download(timeout=30000) as dl:
            await pg.evaluate("void window.lucid.actions.snapshot()")
        snap = open(await (await dl.value).path(), "rb").read()
        open(f"{TMP}/snap.png", "wb").write(snap)
        cur = await pg.evaluate("window.lucid.store.lastRender.md5")
        m, _ = ffmpeg_frames(f"{TMP}/snap.png")
        check("snapshot: uncompressed PNG, pixels identical to the frame", png_blocks_stored(snap) and m == [cur])

        # 9. report: every image full resolution, lossless PNG
        await pg.evaluate("void window.lucid.actions.generateReport()")
        await pg.wait_for_function("() => window.__dlgText().includes('Report Ready')", timeout=120000)
        async with pg.expect_download(timeout=30000) as dl:
            await pg.evaluate("[...document.querySelectorAll('.dlg button')].find(b => b.textContent.includes('Save Report')).click()")
        html = open(await (await dl.value).path(), encoding="utf-8").read()
        await pg.evaluate("document.querySelector('.dlg-x') && document.querySelector('.dlg-x').click()")
        imgs = re.findall(r'src="data:image/(\w+);base64,([^"]+)"', html)
        pngs = [base64.b64decode(b64) for t, b64 in imgs if t == "png"]
        sizes = [struct.unpack(">II", d[16:24]) for d in pngs]
        check("report images: all uncompressed PNG at full resolution", imgs and len(pngs) == len(imgs) and all(s == (320, 240) for s in sizes) and all(png_blocks_stored(d) for d in pngs), f"{len(imgs)} images, sizes {sorted(set(sizes))}")
        m, _ = ffmpeg_frames_bytes(pngs[-1], "png")
        check("report final image has exactly the frame's pixels", m == [app[0]] or m == [cur], m[:1])

        # 10. lossless capture from a (fake) camera; staged on disk where the browser's storage allows it
        cam = await pg.evaluate("(async()=>{ try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach(t => t.stop()); return 'ok' } catch (e) { return e.name + ': ' + e.message } })()")
        if cam != "ok": print(f"INFO {BROWSER}: no camera for the capture test ({cam})")
        else:
            def log(m): print(f"  … {m}  ({time.time() - T0:.0f}s)", flush=True)
            n_before = await pg.evaluate("window.lucid.store.project.chains.length")
            await pg.evaluate("void window.lucid.actions.captureVideo()")
            await pg.wait_for_function("() => window.__dlgText().includes('Video Input')", timeout=10000)
            log("Video Input dialog open")
            await pg.evaluate("window.__clickBtn('Camera')")
            await pg.wait_for_function("() => { const v = document.querySelector('.dlg video'); return v && v.videoWidth > 0 }", timeout=15000)
            log("camera preview running")
            await pg.evaluate("window.__clickBtn('Start Recording')")
            await pg.wait_for_timeout(2500)
            log("status: " + str(await asyncio.wait_for(pg.evaluate("(document.querySelector('.capture-status')||{}).textContent"), 10)))
            note = await pg.evaluate("(document.querySelector('.dlg .export-note')||{}).innerText || ''")
            async with pg.expect_download(timeout=60000) as dl:
                await asyncio.wait_for(pg.evaluate("window.__clickBtn('Stop and Load')"), 10)
            cap_dl = open(await (await dl.value).path(), "rb").read()
            await pg.wait_for_function(f"() => window.lucid.store.project.chains.length > {n_before} && !!window.lucid.store.lastRender?.md5", timeout=60000, polling=250)
            log(f"recording downloaded ({len(cap_dl)} bytes) and loaded")
            toast = await pg.evaluate("(document.querySelector('.toasts')||{}).innerText || ''")
            info = await pg.evaluate("(()=>{ const s=window.lucid.store; const c=s.chain(); const id=c.filters[0].params.source; const i=s.sources.get(id); window.__cap = s.files.get(id)[0]; return { name: i.name, frames: i.frameCount, codec: i.codec, w: i.width, h: i.height, size: window.__cap.size } })()")
            log(f"source {json.dumps(info)}")
            cap = await fetch_file(pg, "window.__cap", "capture.avi"); open(f"{TMP}/capture.avi", "wb").write(cap)
            log(f"fetched {len(cap)} bytes")
            m, warn = ffmpeg_frames(f"{TMP}/capture.avi")
            log(f"ffmpeg decoded {len(m)} frames")
            appc = await frame_hashes(pg)
            log(f"application hashed {len(appc)} frames")
            check("lossless capture: uncompressed AVI loaded as a new chain", info["name"].startswith("Capture ") and info["name"].endswith(".avi") and info["frames"] >= 20 and "Captured" in toast and "losslessly" in toast, f"{json.dumps(info)}; {toast[:120]}")
            check("captured AVI decodes (ffmpeg) to exactly the frames shown by the application", m == appc and len(m) == info["frames"] and not warn, f"{len(m)} frames {warn[:80]}")
            staged_cap = "browser's storage" in note
            check(f"recording {'staged on disk in the browser storage' if staged_cap else 'kept in memory'} and downloaded: the download is the loaded file", cap_dl == cap and (("browser's storage" in note and "staged on disk" in toast) if staged_cap else ("in memory" in note and "downloaded" in toast)), f"{note.splitlines()[-1][:100]}")
            if staged_cap:
                rec = await pg.evaluate("(()=>{ const l = window.lucid.actions.staging.list(); return l.map(i => ({ kind: i.kind, bytes: i.bytes })) })()")
                check("the staged recording is listed (in use by the project, not removable)", rec and rec[0]["kind"] == "recording" and rec[0]["bytes"] == len(cap), json.dumps(rec))

        check("no uncaught page errors", not errors, "; ".join(errors)[:300])
        await b.close()
    print(f"\n{sum(results)}/{len(results)} checks passed")
    sys.exit(0 if all(results) else 1)

try: asyncio.run(main())
finally:
    shutil.rmtree(TMP, ignore_errors=True)
