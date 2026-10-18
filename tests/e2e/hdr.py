"""HDR video (Video Loader › HDR Video), checked in a real browser.

An SDR picture (gray ramp + color patches) is converted to HDR with the inverse of the standard chain
(BT.1886 → BT.2087 primaries → PQ, or HLG inverse OOTF + OETF at 1000 cd/m², SDR white = 203 cd/m²), written as
10-bit 4:2:0 BT.2020 limited-range YUV and encoded losslessly as VP9 profile 2 with HLG / PQ color metadata.
Loaded into LUCID:
- a new Video Loader tone maps by default and File Info says so (plus a Quality Check entry);
- the tone-mapped frame reproduces the SDR original below the BT.2390 knee (where nothing must change) and
  compresses the highlights above it monotonically, without clipping;
- "Signal values as decoded" returns the raw HDR code values (= the washed-out picture), and a loader saved
  without the HDR parameter (earlier projects) decodes exactly like that.

Usage: URL=http://127.0.0.1:5199/ LUCID_TMP=/disk/dir python3 tests/e2e/hdr.py
"""
import asyncio, base64, json, os, subprocess, sys, tempfile
import numpy as np
import imageio_ffmpeg
from playwright.async_api import async_playwright

URL = os.environ.get("URL", "http://127.0.0.1:5199/")
TMP = os.environ.get("LUCID_TMP") or tempfile.mkdtemp(prefix="lucid-hdr-")
os.makedirs(TMP, exist_ok=True)
FF = imageio_ffmpeg.get_ffmpeg_exe()
W, H = 640, 360
results = []

def check(name, ok, info=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'} {name}{f'  [{info}]' if info else ''}", flush=True)

# ------------------------------------------------------------------------------------------------ test picture
def sdr_picture():
    img = np.zeros((H, W, 3), np.float64)
    ramp = np.linspace(0, 1, W)
    img[: H // 2] = ramp[None, :, None]
    patches = [(0.75, 0.2, 0.2), (0.2, 0.6, 0.25), (0.2, 0.3, 0.75), (0.8, 0.7, 0.3), (0.6, 0.45, 0.4), (0.3, 0.6, 0.65), (0.95, 0.95, 0.95), (0.5, 0.5, 0.5)]
    pw = W // len(patches)
    for i, c in enumerate(patches): img[H // 2:, i * pw:(i + 1) * pw] = c
    return img, patches, pw

M1, M2, C1, C2, C3 = 2610 / 16384, 2523 / 4096 * 128, 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32
def pq_inv(l):
    y = np.power(np.maximum(l, 0) / 10000, M1)
    return np.power((C1 + C2 * y) / (1 + C3 * y), M2)
HA = 0.17883277; HB = 1 - 4 * HA; HC = 0.5 - HA * np.log(4 * HA)
def hlg_oetf(e):
    e = np.maximum(e, 0)
    return np.where(e <= 1 / 12, np.sqrt(3 * e), HA * np.log(np.maximum(12 * e - HB, 1e-12)) + HC)

TO2020 = np.array([[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]])
def to_hdr(sdr, transfer):
    lin = np.power(sdr, 2.4) @ TO2020.T * 203.0  # display light, cd/m², BT.2020
    if transfer == "pq": return pq_inv(lin)
    lw, g = 1000.0, 1.2
    yd = lin @ np.array([0.2627, 0.6780, 0.0593])
    ys = np.power(np.maximum(yd, 1e-12) / lw, 1 / g)
    es = lin / (lw * np.power(ys, g - 1))[..., None]
    return hlg_oetf(np.clip(es, 0, 1))

def write_webm(sig, transfer, path):
    r, g, b = sig[..., 0], sig[..., 1], sig[..., 2]
    y = 0.2627 * r + 0.6780 * g + 0.0593 * b
    cb, cr = (b - y) / 1.8814, (r - y) / 1.4746
    Y = np.clip(np.round(64 + 876 * y), 0, 1023).astype(np.uint16)
    sub = lambda c: c.reshape(H // 2, 2, W // 2, 2).mean(axis=(1, 3))
    U = np.clip(np.round(512 + 896 * sub(cb)), 0, 1023).astype(np.uint16)
    V = np.clip(np.round(512 + 896 * sub(cr)), 0, 1023).astype(np.uint16)
    raw = f"{TMP}/hdr_{transfer}.yuv"
    with open(raw, "wb") as f:
        for _ in range(3): f.write(Y.tobytes()); f.write(U.tobytes()); f.write(V.tobytes())
    trc = "arib-std-b67" if transfer == "hlg" else "smpte2084"
    subprocess.run([FF, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "yuv420p10le", "-s", f"{W}x{H}", "-r", "25", "-i", raw,
                    "-c:v", "libvpx-vp9", "-profile:v", "2", "-pix_fmt", "yuv420p10le", "-lossless", "1",
                    "-color_primaries", "bt2020", "-color_trc", trc, "-colorspace", "bt2020nc", "-color_range", "tv", path], check=True)

FRAME_RGB_JS = """(() => { const a = window.lucid.store.lastRender.rgba, n = a.length / 4, rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { rgb[i * 3] = a[i * 4]; rgb[i * 3 + 1] = a[i * 4 + 1]; rgb[i * 3 + 2] = a[i * 4 + 2]; }
  let s = ''; for (let i = 0; i < rgb.length; i += 0x8000) s += String.fromCharCode.apply(null, rgb.subarray(i, i + 0x8000));
  return btoa(s); })()"""

async def load(pg, path):
    before = await pg.evaluate("window.lucid.store.project.chains.length")
    async with pg.expect_file_chooser() as fc:
        await pg.evaluate("(()=>{ window.lucid.actions.openMedia(); return null })()")
    await (await fc.value).set_files([path])
    await pg.wait_for_function(f"""() => {{ const s = window.lucid.store; return s.project.chains.length > {before} && s.lastRender && s.lastRender.chainId === s.ui.chainId && !!s.lastRender.md5 }}""", timeout=60000, polling=100)
    return await pg.evaluate("""(()=>{ const s = window.lucid.store, f = s.chain().filters[0], i = s.sources.get(f.params.source);
      return { params: f.params, meta: i.metadata, transfer: i.transfer, primaries: i.colorPrimaries, browser: !!i.browserConversion } })()""")

async def frame(pg, n, **params):
    await pg.evaluate(f"""(()=>{{ const s = window.lucid.store, a = window.lucid.actions, f = s.chain().filters[0];
      for (const [k, v] of Object.entries({json.dumps(params)})) a.setParam(f.id, k, v); s.setFrame({n}); }})()""")
    await pg.wait_for_function(f"""() => {{ const s = window.lucid.store, r = s.lastRender, f = s.chain().filters[0];
      return r && r.md5 && r.frame === {n} && Object.entries({json.dumps(params)}).every(([k, v]) => f.params[k] === v) && !window.lucid.mainViewer.isBusy }}""", timeout=30000, polling=100)
    await pg.wait_for_timeout(300)
    await pg.wait_for_function("() => !window.lucid.mainViewer.isBusy", timeout=30000, polling=50)
    return np.frombuffer(base64.b64decode(await pg.evaluate(FRAME_RGB_JS)), np.uint8).reshape(H, W, 3).astype(float)

async def main():
    sdr, patches, pw = sdr_picture()
    async with async_playwright() as p:
        profile = tempfile.mkdtemp(prefix="profile-", dir=TMP)
        ctx = await p.chromium.launch_persistent_context(profile, viewport={"width": 1500, "height": 900}, args=["--no-sandbox"])
        pg = ctx.pages[0] if ctx.pages else await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL, wait_until="networkidle")
        await pg.wait_for_function("() => !!(window.lucid && window.lucid.store)", timeout=30000)
        for transfer in ("hlg", "pq"):
            sig = to_hdr(sdr, transfer)
            path = f"{TMP}/hdr_{transfer}.webm"
            write_webm(sig, transfer, path)
            info = await load(pg, path)
            T = transfer.upper()
            check(f"{T}: stream recognised as HDR ({info['transfer']}, {info['primaries']}); decoded planes converted by LUCID", info["transfer"] == transfer and info["primaries"] == "bt2020" and not info["browser"])
            check(f"{T}: new Video Loader tone maps by default (peak 1000 cd/m²)", info["params"].get("hdr") == "tonemap" and info["params"].get("hdrPeak") == 1000, json.dumps({k: info["params"].get(k) for k in ("hdr", "hdrPeak")}))
            md = dict((k, v) for k, v in info["meta"] if k)
            check(f"{T}: File Info explains the HDR handling and has a Quality Check", "tone mapped" in md.get("HDR", "") and "Quality Check" in md, md.get("HDR", ""))
            tm = await frame(pg, 1, hdr="tonemap")
            ref = sdr * 255
            ramp_x = np.arange(4, W - 4)
            v = ramp_x / (W - 1)
            row = tm[40:140, 4:W - 4].mean(axis=0)  # ramp rows, averaged
            refrow = ref[40:140, 4:W - 4].mean(axis=0)
            low = v <= 0.70
            err = np.abs(row[low] - refrow[low])
            check(f"{T}: gray ramp below the knee (≤ 70 %) reproduces the SDR original", err.mean() < 1.2 and err.max() < 3.5, f"mean {err.mean():.2f}, max {err.max():.2f} code values")
            hi = row[v > 0.75, 1]
            check(f"{T}: highlights above the knee are compressed smoothly (monotonic, below the original, no clipping)", np.all(np.diff(hi) > -0.6) and np.all(row[v > 0.8, 1] <= refrow[v > 0.8, 1] + 1) and row[-1, 1] < 254.5 and row[-1, 1] > 200, f"top of ramp {row[-1, 1]:.1f}")
            neutral = np.abs(row[:, 0] - row[:, 1]).max(), np.abs(row[:, 2] - row[:, 1]).max()
            check(f"{T}: the gray ramp stays neutral", max(neutral) < 1.5, f"max channel spread {max(neutral):.2f}")
            perr = []
            for i, c in enumerate(patches):
                got = tm[H // 2 + 20:H - 20, i * pw + 12:(i + 1) * pw - 12].reshape(-1, 3).mean(axis=0)
                want = np.array(c) * 255
                lum = np.dot(np.power(c, 2.4), [0.2126, 0.7152, 0.0722])
                if lum < 0.4: perr.append(np.abs(got - want).max())
                else: perr.append(0 if np.argmax(got) == np.argmax(want) or np.ptp(want) < 1 else 99)
            check(f"{T}: color patches: mid-tones match the SDR original, bright ones keep their hue", max(perr) < 3.5, ", ".join(f"{e:.1f}" for e in perr))
            raw = await frame(pg, 1, hdr="none")
            sigrow = sig[40:140, 4:W - 4].mean(axis=0)[low] * 255
            check(f"{T}: \"Signal values as decoded\" returns the raw HDR code values", np.abs(raw[40:140, 4:W - 4].mean(axis=0)[low] - sigrow).mean() < 1.5)
            def sat(img):  # mean colorfulness of the colored patches (max − min channel)
                vals = [img[H // 2 + 20:H - 20, i * pw + 12:(i + 1) * pw - 12].reshape(-1, 3).mean(axis=0) for i in range(6)]
                return float(np.mean([v.max() - v.min() for v in vals]))
            s_ref, s_tm, s_raw = sat(ref), sat(tm), sat(raw)
            check(f"{T}: raw values look washed out (colorfulness {s_raw / s_ref:.0%} of the original), tone mapped restores it ({s_tm / s_ref:.0%})", s_raw < 0.8 * s_ref and abs(s_tm / s_ref - 1) < 0.05)
            await pg.evaluate("(()=>{ const s = window.lucid.store; s.mutate((p) => { const f = p.chains.find((c) => c.id === s.ui.chainId).filters[0]; delete f.params.hdr; delete f.params.hdrPeak; }); s.setFrame(2); })()")
            await pg.wait_for_function("() => { const r = window.lucid.store.lastRender; return r && r.frame === 2 && !window.lucid.mainViewer.isBusy }", timeout=30000, polling=100)
            await pg.wait_for_timeout(300)
            legacy = np.frombuffer(base64.b64decode(await pg.evaluate(FRAME_RGB_JS)), np.uint8).reshape(H, W, 3).astype(float)
            check(f"{T}: a loader saved without the HDR parameter (earlier projects) decodes as before (no tone mapping)", np.abs(legacy - raw).max() <= 1)
            t = await pg.evaluate("""(async () => { const s = window.lucid.store, a = window.lucid.actions, f = s.chain().filters[0]; a.setParam(f.id, 'hdr', 'tonemap'); a.setParam(f.id, 'hdrPeak', 1000);
              const t0 = performance.now(); s.setFrame(0); await new Promise((r) => { const k = () => { const x = s.lastRender; if (x && x.frame === 0 && !window.lucid.mainViewer.isBusy) r(); else setTimeout(k, 20); }; setTimeout(k, 50); }); return performance.now() - t0; })()""")
            print(f"INFO {T}: {W}×{H} frame decoded + tone mapped + rendered in {t:.0f} ms", flush=True)
        check("no page errors", not errors, "; ".join(errors[:3]))
        await ctx.close()
    print(f"\nhdr: {sum(results)}/{len(results)} passed", flush=True)
    sys.exit(0 if all(results) else 1)

asyncio.run(main())
