# Scripted E2E runner: python3 steps.py steps.json  (each step: {"js": "...", "wait": ms, "shot": "name", "probe": "js expr"})
import asyncio, sys, json, os
from playwright.async_api import async_playwright

URL = os.environ.get("URL", "http://localhost:5173/")
OUTDIR = os.environ.get("OUTDIR", "/home/user/scratch")

async def main():
    steps = json.load(open(sys.argv[1]))
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        ctx = await b.new_context(viewport={"width": int(os.environ.get("W", 1568)), "height": int(os.environ.get("H", 898))}, device_scale_factor=1, accept_downloads=True)
        pg = await ctx.new_page()
        logs = []
        pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning", "log") else None)
        pg.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        await pg.goto(URL, wait_until="networkidle")
        await pg.wait_for_timeout(1200)
        for st in steps:
            if "click" in st:
                await pg.click(st["click"])
            if "mouse" in st:
                for m in st["mouse"]:
                    if m[0] == "move": await pg.mouse.move(m[1], m[2], steps=m[3] if len(m) > 3 else 1)
                    elif m[0] == "down": await pg.mouse.down()
                    elif m[0] == "up": await pg.mouse.up()
                    elif m[0] == "click": await pg.mouse.click(m[1], m[2])
                    elif m[0] == "dbl": await pg.mouse.dblclick(m[1], m[2])
                    elif m[0] == "wheel": await pg.mouse.wheel(0, m[1])
            if st.get("reload"):
                await pg.reload(wait_until="networkidle")
                await pg.wait_for_timeout(1500)
            if "keys" in st:
                for k in st["keys"]: await pg.keyboard.press(k)
            if "files" in st:
                try:
                    async with pg.expect_file_chooser(timeout=8000) as fc:
                        await pg.evaluate("(()=>{ " + st["trigger"] + "; return null })()")
                    chooser = await fc.value
                    await chooser.set_files(st["files"])
                except Exception as e:
                    print("FILES ERROR", e)
            if "js" in st:
                try:
                    r = await pg.evaluate(st["js"])
                    if "save" in st: json.dump(r, open(st["save"], "w"))
                    elif r is not None: print("JS>", json.dumps(r)[:1500])
                except Exception as e:
                    print("JS ERROR", e)
            await pg.wait_for_timeout(st.get("wait", 500))
            if "probe" in st:
                try: print("PROBE>", json.dumps(await pg.evaluate(st["probe"]))[:3000])
                except Exception as e: print("PROBE ERROR", e)
            if "shot" in st:
                await pg.screenshot(path=f"{OUTDIR}/{st['shot']}.png")
                print("SHOT", st["shot"])
        print("---- console (errors/warnings/logs) ----")
        for l in logs[-60:]: print(l)
        await b.close()

asyncio.run(main())
