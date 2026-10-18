"""AI assistant end to end, in a real browser, against tests/e2e/ai_mock.py — a mock model server that streams the
OpenAI and Anthropic APIs with scripted agent behaviours and records every request.

Covers: AI Settings (provider, address, model list, connection test), the agent loop (multi-step, parallel tool
calls), validation errors fed back and corrected, invalid argument JSON, approvals (reject / allow), Ask mode
(read-only tools only), frame sharing consent (deny / allow once / never), questions to the user (buttons and
typed answers), Save buttons for exports (lossless file verified with ffmpeg), playback speed and frames, menu
commands, Stop, provider errors, checkpoints and undo, the Anthropic, Gemini and OpenRouter dialects (headers,
schemas), the command palette, "Ask AI" from History, the audit log in the project and in the report.

Usage: URL=http://127.0.0.1:5199/ BROWSER=chromium LUCID_TMP=/disk/dir python3 tests/e2e/ai.py
"""
import asyncio, json, os, subprocess, sys, tempfile, time, urllib.request
import imageio_ffmpeg
from playwright.async_api import async_playwright

URL = os.environ.get("URL", "http://127.0.0.1:5199/")
BROWSER = os.environ.get("BROWSER", "chromium")
PORT = int(os.environ.get("MOCK_PORT", "8799"))
MOCK = f"http://127.0.0.1:{PORT}"
FF = imageio_ffmpeg.get_ffmpeg_exe()
TMP = tempfile.mkdtemp(prefix="lucid-ai-", dir=os.environ.get("LUCID_TMP") or None)
DEV = not URL.startswith("file:") and ":4173" not in URL
results, T0 = [], time.time()

def check(name, ok, info=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{info}]" if info else "") + f"  ({time.time() - T0:.0f}s)", flush=True)

def mock_log():
    return json.loads(urllib.request.urlopen(f"{MOCK}/log", timeout=5).read())

def mock_reset():
    urllib.request.urlopen(urllib.request.Request(f"{MOCK}/reset", data=b"{}", method="POST"), timeout=5)

async def configure(pg, provider="custom", model="mock-agent", key=None, **extra):
    await pg.evaluate("""([p, url, model, extra]) => { const a = window.lucid.agent, s = a.settings;
      a.saveSettings(Object.assign({ provider: p, baseUrls: { ...s.baseUrls, [p]: url }, models: { ...s.models, [p]: model } }, extra)); }""", [provider, f"{MOCK}/v1", model, extra])
    if key is not None: await pg.evaluate("([p, k]) => window.lucid.agent.setApiKey(p, k)", [provider, key])

async def users(pg):
    return await pg.evaluate("window.lucid.agent.items.filter((i) => i.kind === 'user').length")

async def send(pg, text):
    n = await users(pg)
    await pg.evaluate("window.lucid.focusAi()")
    await pg.wait_for_selector(".panel.ai .ai-input", state="visible", timeout=10000)
    # Playwright's fill occasionally inserts nothing in WebKit: make sure the text is there before Enter
    for _ in range(4):
        await pg.fill(".panel.ai .ai-input", text)
        if await pg.evaluate("document.querySelector('.panel.ai .ai-input').value") == text: break
        await pg.wait_for_timeout(100)
    await pg.press(".panel.ai .ai-input", "Enter")
    await pg.wait_for_function(f"() => window.lucid.agent.items.filter((i) => i.kind === 'user').length > {n}", timeout=10000)

async def idle(pg, timeout=60000):
    await pg.wait_for_function("() => !window.lucid.agent.busy", timeout=timeout, polling=100)
    await pg.wait_for_timeout(150)

async def reply(pg):
    return await pg.evaluate("(() => { const it = window.lucid.agent.items.filter((i) => i.kind === 'assistant' && i.text).pop(); return it ? it.text : ''; })()")

async def tools_of_last_turn(pg):
    return await pg.evaluate("""(() => { const it = window.lucid.agent.items; let k = it.length - 1; while (k >= 0 && it[k].kind !== 'user') k--;
      return it.slice(k + 1).filter((i) => i.kind === 'tool').map((i) => ({ name: i.name, status: i.status, error: i.result && i.result.error || '' })); })()""")

async def notes(pg):
    return await pg.evaluate("window.lucid.agent.items.filter((i) => i.kind === 'note').map((i) => i.level + ': ' + i.text)")

CHAIN = "(() => { const c = window.lucid.store.chain(); return c.filters.map((f) => ({ id: f.id, type: f.type, params: f.params })); })()"

async def main():
    srv = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(__file__), "ai_mock.py"), str(PORT)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(50):
        try: mock_log(); break
        except Exception: time.sleep(0.1)
    try:
        async with async_playwright() as p:
            profile = tempfile.mkdtemp(prefix="profile-", dir=TMP)
            ctx = await getattr(p, BROWSER).launch_persistent_context(profile, viewport={"width": 1568, "height": 898}, accept_downloads=True, args=["--no-sandbox"] if BROWSER == "chromium" else [])
            pg = ctx.pages[0] if ctx.pages else await ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.on("dialog", lambda d: asyncio.ensure_future(d.dismiss()))
            await pg.goto(URL, wait_until="networkidle")
            await pg.wait_for_function("() => !!(window.lucid && window.lucid.store && window.lucid.agent)", timeout=30000)
            print(f"{BROWSER}: {await pg.evaluate('navigator.userAgent')}", flush=True)
            await pg.evaluate("window.lucid.store.savePrefs({ saveToDisk: false })")

            # ---------------------------------------------------------- panel, toolbar, settings dialog
            tabs = await pg.evaluate("[...document.querySelectorAll('[data-trellis-part=\"tab\"]')].map((t) => t.textContent.trim())")
            check("AI Assistant is a tab of the workspace (next to History); toolbar button present", "AI Assistant" in tabs and await pg.locator(".tb-btn[aria-label^='AI Assistant']").count() == 1, ", ".join(tabs))
            await pg.keyboard.press("Control+i")
            await pg.wait_for_selector(".panel.ai .ai-input", state="visible", timeout=10000)
            try: await pg.wait_for_function("() => document.activeElement && document.activeElement.classList.contains('ai-input')", timeout=3000); focused = True
            except Exception: focused = False
            check("Ctrl+I opens the assistant and focuses its input", focused)
            empty = await pg.evaluate("!!document.querySelector('.panel.ai .ai-empty .ai-setup')")
            check("unconfigured assistant offers set-up", empty)
            await pg.click(".panel.ai .ai-model")
            await pg.wait_for_selector(".dlg .ai-settings", timeout=5000)
            await pg.select_option(".ai-settings select >> nth=0", "custom")
            await pg.fill(".ai-settings .form-row:nth-of-type(2) .inp", f"{MOCK}/v1")
            await pg.click(".ai-settings button:has-text('Load models')")
            await pg.wait_for_function("() => /models available/.test(document.querySelector('.ai-set-status').textContent)", timeout=10000)
            models = await pg.evaluate("[...document.querySelectorAll('.ai-settings datalist option')].map((o) => o.value)")
            chosen = await pg.evaluate("document.querySelector('.ai-settings input[list]').value")
            check("Load models: chat models newest first, embeddings filtered out, newest chosen", models == ["mock-agent", "mock-old"] and chosen == "mock-agent", f"{models} → {chosen}")
            await pg.click(".ai-settings button:has-text('Test connection')")
            await pg.wait_for_function("() => /Connected|rejected|reach/.test(document.querySelector('.ai-set-status').textContent)", timeout=10000)
            st = await pg.evaluate("document.querySelector('.ai-set-status').textContent")
            check("Test connection reaches the model", st.startswith("Connected") and "OK" in st, st)
            priv = await pg.evaluate("document.querySelector('.ai-privacy').textContent")
            check("privacy note: a local address stays on this computer", "Stays on this computer" in priv, priv[:80])
            await pg.click(".dlg button:has-text('Save')")
            await pg.wait_for_timeout(300)
            head = await pg.evaluate("document.querySelector('.panel.ai .ai-model').textContent")
            check("settings saved: the header shows the model", "mock-agent" in head, head)

            # ---------------------------------------------------------- the agent loop
            await pg.evaluate("window.lucid.actions.loadSampleProject()")
            await pg.wait_for_function("() => { const s = window.lucid.store; return s.project.chains.length === 3 && s.lastRender && s.lastRender.md5 }", timeout=60000)
            await pg.wait_for_timeout(500)
            before = await pg.evaluate(CHAIN)
            mock_reset()
            await send(pg, "TEST:levels make it brighter")
            await idle(pg)
            after = await pg.evaluate(CHAIN)
            new = [f for f in after if f["id"] not in {b["id"] for b in before}]
            tl = await tools_of_last_turn(pg)
            check("agent: reads the state, adds Levels with the requested values, measures the result", len(new) == 1 and new[0]["type"] == "levels" and new[0]["params"]["inBlack"] == 10 and new[0]["params"]["inWhite"] == 240
                  and [t["name"] for t in tl] == ["get_state", "add_filter", "get_frame_stats"] and all(t["status"] == "done" for t in tl), json.dumps(tl))
            bold = await pg.evaluate("[...document.querySelectorAll('.panel.ai .ai-bot strong')].map((e) => e.textContent)")
            check("answer rendered as Markdown (bold, list), streamed", "Levels" in bold and await pg.locator(".panel.ai .ai-bot li").count() >= 2, ", ".join(bold))
            log = mock_log()
            chat = [r for r in log if r.get("path", "").endswith("/chat/completions")]
            check("requests: streamed, Agent mode, 31 tools, conversation grows step by step", len(chat) == 4 and all(r["stream"] for r in chat) and chat[0]["mode"] == "agent" and len(chat[0]["tools"]) == 31 and [r["step"] for r in chat] == [0, 1, 2, 3], json.dumps([(r["step"], len(r["tools"])) for r in chat]))
            check("no API key sent when none is set", all(not r["headers"]["authorization"] for r in chat))
            check("system prompt sent with every request: current state, and evidence text treated as data (prompt injection)", all(r["injection_rule"] and r["has_state"] for r in chat))
            ailog = await pg.evaluate("window.lucid.store.project.aiLog")
            check("audit log: request, model, actions", len(ailog) == 1 and ailog[0]["request"].startswith("TEST:levels") and ailog[0]["model"] == "mock-agent" and [a["tool"] for a in ailog[0]["actions"]] == ["add_filter"] and ailog[0]["actions"][0]["ok"], json.dumps(ailog)[:200])
            hist = await pg.evaluate("[...document.querySelectorAll('.tree-row.tree-filter .tree-name')].map((e) => e.textContent)")
            check("the change is a normal History step", hist.count("Levels") >= 2, ", ".join(hist[:12]))
            # checkpoint, then undo brings it back
            await pg.click(".panel.ai .ai-user .ai-link:has-text('Restore checkpoint')")
            await pg.click(".dlg button:has-text('Restore')")
            await pg.wait_for_timeout(400)
            restored = await pg.evaluate(CHAIN)
            check("Restore checkpoint removes everything the request changed", [f["id"] for f in restored] == [f["id"] for f in before])
            await pg.evaluate("window.lucid.store.undo()")
            check("…and Undo brings it back", len(await pg.evaluate(CHAIN)) == len(before) + 1)
            await pg.evaluate("window.lucid.store.undo()")

            # parallel tool calls
            n0 = len(await pg.evaluate(CHAIN))
            await send(pg, "TEST:multi sharpen it"); await idle(pg)
            r = await reply(pg)
            check("parallel tool calls in one turn, then an action based on both results", "after two parallel lookups" in r and len(await pg.evaluate(CHAIN)) == n0 + 1, r)
            await pg.evaluate("window.lucid.store.undo()")

            # validation error fed back and corrected; invalid JSON arguments
            await send(pg, "TEST:bad"); await idle(pg)
            tl = await tools_of_last_turn(pg)
            last_lv = (await pg.evaluate(CHAIN))[-1]
            check("invalid parameter refused with the valid keys; the model corrects itself", tl[0]["status"] == "error" and "unknown parameter" in tl[0]["error"] and "inBlack" in tl[0]["error"] and tl[1]["status"] == "done" and last_lv["params"]["inBlack"] == 12 and "Fixed" in await reply(pg), tl[0]["error"][:90])
            await pg.evaluate("window.lucid.store.undo()")
            await send(pg, "TEST:badjson"); await idle(pg)
            tl = await tools_of_last_turn(pg)
            check("arguments that are not JSON are reported back, the run continues", tl and tl[0]["status"] == "error" and "not a JSON object" in tl[0]["error"] and "Recovered" in await reply(pg))

            # approvals
            await pg.uncheck(".panel.ai .ai-auto input")
            n0 = len(await pg.evaluate(CHAIN))
            await send(pg, "TEST:levels")
            await pg.wait_for_selector(".panel.ai .ai-tool.approval .ai-approve", timeout=20000)
            await pg.click(".panel.ai .ai-tool.approval .btn:has-text('Reject')")
            await idle(pg)
            ailog = await pg.evaluate("window.lucid.store.project.aiLog")
            check("approval mode: a rejected change is not applied and is logged as rejected", len(await pg.evaluate(CHAIN)) == n0 and any(a.get("note") == "rejected by the user" for a in ailog[-1]["actions"]))
            await send(pg, "TEST:levels")
            await pg.wait_for_selector(".panel.ai .ai-tool.approval .ai-approve", timeout=20000)
            await pg.click(".panel.ai .ai-tool.approval .btn:has-text('Allow')")
            await idle(pg)
            check("approval mode: an allowed change is applied", len(await pg.evaluate(CHAIN)) == n0 + 1)
            await pg.evaluate("window.lucid.store.undo()")
            await pg.check(".panel.ai .ai-auto input")

            # Ask mode
            await pg.select_option(".panel.ai .ai-mode", "ask")
            mock_reset()
            await send(pg, "TEST:count"); await idle(pg)
            r = await reply(pg)
            check("Ask mode: only read-only tools are offered (13), no write tools", r == "TOOLS=13 WRITE=no" and mock_log()[0]["mode"] == "ask", r)
            n0 = len(await pg.evaluate(CHAIN))
            await send(pg, "TEST:levels"); await idle(pg)
            tl = await tools_of_last_turn(pg)
            check("Ask mode: a write tool requested anyway is refused", len(await pg.evaluate(CHAIN)) == n0 and any(t["name"] == "add_filter" and t["status"] == "rejected" for t in tl))
            await pg.select_option(".panel.ai .ai-mode", "agent")
            check("Auto-apply hidden in Ask mode, back in Agent mode", await pg.is_visible(".panel.ai .ai-auto"))

            # frames: consent
            await send(pg, "TEST:look")
            await pg.wait_for_selector(".panel.ai .ai-card.consent.open", timeout=20000)
            await pg.click(".panel.ai .ai-card.consent.open .btn:has-text(\"Don't allow\")")
            await idle(pg)
            r = await reply(pg)
            check("frame sharing denied: no image sent, the model is told", r.startswith("NO_IMAGE") and "does not allow" in r, r[:90])
            mock_reset()
            await send(pg, "TEST:look")
            await pg.wait_for_selector(".panel.ai .ai-card.consent.open", timeout=20000)
            await pg.click(".panel.ai .ai-card.consent.open .btn:has-text('Allow once')")
            await idle(pg)
            r = await reply(pg); ailog = await pg.evaluate("window.lucid.store.project.aiLog")
            check("frame sharing allowed once: the image reaches the model, logged", r == "IMAGE_RECEIVED" and mock_log()[-1]["images"] == 1 and ailog[-1]["framesShared"] == 1, f"{r}, log {ailog[-1]['framesShared']}")
            await pg.evaluate("window.lucid.agent.saveSettings({ frames: 'never' })")
            await send(pg, "TEST:look"); await idle(pg)
            check("frames 'never': refused without asking", (await reply(pg)).startswith("NO_IMAGE") and await pg.locator(".panel.ai .ai-card.consent.open").count() == 0)
            await pg.evaluate("window.lucid.agent.saveSettings({ frames: 'ask' })")

            # questions
            await send(pg, "TEST:ask")
            await pg.wait_for_selector(".panel.ai .ai-card.open .btn:has-text('Face')", timeout=20000)
            await pg.click(".panel.ai .ai-card.open .btn:has-text('Face')")
            await idle(pg)
            check("ask_user: option button", await reply(pg) == "You chose: Face")
            await send(pg, "TEST:ask")
            await pg.wait_for_selector(".panel.ai .ai-card.open .ai-card-in .inp", timeout=20000)
            await pg.fill(".panel.ai .ai-card.open .ai-card-in .inp", "Left mirror")
            await pg.press(".panel.ai .ai-card.open .ai-card-in .inp", "Enter")
            await idle(pg)
            check("ask_user: typed answer", await reply(pg) == "You chose: Left mirror")

            # playback and frames, menu command
            await send(pg, "TEST:speed"); await idle(pg)
            sp = await pg.evaluate("[window.lucid.player.speed, window.lucid.store.frameOf()]")
            nav = await pg.evaluate("(() => { const t = window.lucid.agent.items.filter((i) => i.kind === 'tool' && i.name === 'go_to_frame').pop(); return t && t.result && t.result.data; })()")
            check("playback speed 0.01× and frame navigation through the assistant (clamped to the chain)", sp[0] == 0.01 and nav and sp[1] == nav["frame"] == min(3, nav["frames"] - 1), f"{sp}, {nav}")
            await pg.evaluate("window.lucid.player.setSpeed(1)")
            await send(pg, "TEST:cmd"); await idle(pg)
            dlg = await pg.evaluate("[...document.querySelectorAll('.dlg')].map((d) => d.innerText.slice(0, 40)).join('|')")
            check("menu command run by id (Help › Keyboard Shortcuts)", "Keyboard Shortcuts" in dlg and "Opened" in await reply(pg), dlg)
            await pg.keyboard.press("Escape")
            await pg.evaluate("document.querySelectorAll('.dlg-overlay').forEach((o) => o.remove())")

            # export with a Save button (lossless, verified)
            await send(pg, "TEST:export")
            await pg.wait_for_selector(".panel.ai .ai-card.open .btn:has-text('Save')", timeout=20000)
            card = await pg.evaluate("document.querySelector('.panel.ai .ai-card.open').innerText")
            async with pg.expect_download(timeout=60000) as dl:
                await pg.click(".panel.ai .ai-card.open .btn:has-text('Save')")
            d = await dl.value
            path = os.path.join(TMP, d.suggested_filename); await d.save_as(path)
            await idle(pg)
            dims = subprocess.run([FF, "-v", "error", "-i", path, "-f", "null", "-"], capture_output=True).returncode == 0
            out = await pg.evaluate("(() => { const r = window.lucid.store.lastRender; return [r.width, r.height]; })()")
            raw = subprocess.run([FF, "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb48le", "-"], capture_output=True).stdout
            r = await reply(pg)
            check("export: Save button → lossless 16-bit TIFF, verified, decodable", "no compression" in card and d.suggested_filename.endswith(".tif") and dims and len(raw) == out[0] * out[1] * 6 and '"verified": true' in r, f"{d.suggested_filename}, {len(raw)} bytes, {r[:80]}")

            # stop, errors
            await send(pg, "TEST:slow")
            await pg.wait_for_function("() => window.lucid.agent.items.some((i) => i.kind === 'assistant' && /word3/.test(i.text))", timeout=20000)
            await pg.click(".panel.ai .ai-send.busy")
            await idle(pg, 10000)
            check("Stop ends a streaming answer at once", any("Stopped" in x for x in await notes(pg)))
            await send(pg, "hello"); await idle(pg)
            check("the next request works after Stop", await reply(pg) == "Hello from the mock model.")
            await send(pg, "TEST:401"); await idle(pg)
            nt = (await notes(pg))[-1]
            check("provider error explained (key rejected, with the provider's message)", nt.startswith("error") and "rejected the API key" in nt and "Incorrect API key" in nt, nt[:120])

            # other dialects: Anthropic, Gemini, OpenRouter
            await configure(pg, "anthropic", "mock-claude", key="sk-ant-test", frames="allow")
            mock_reset()
            n0 = len(await pg.evaluate(CHAIN))
            await send(pg, "TEST:levels"); await idle(pg)
            log = [r for r in mock_log() if r.get("path", "").endswith("/messages")]
            h0 = log[0]["headers"] if log else {}
            check("Anthropic: Messages API with key, version and browser-access headers; agent loop works", len(log) == 4 and h0.get("x-api-key") == "sk-ant-test" and h0.get("anthropic-version") == "2023-06-01" and h0.get("anthropic-dangerous-direct-browser-access") == "true" and log[0]["max_tokens"] and len(await pg.evaluate(CHAIN)) == n0 + 1, json.dumps(h0))
            await pg.evaluate("window.lucid.store.undo()")
            await send(pg, "TEST:look"); await idle(pg)
            check("Anthropic: frame image inside the tool result", await reply(pg) == "IMAGE_RECEIVED")
            await configure(pg, "gemini", "mock-gemini", key="g-test", frames="ask")
            mock_reset()
            await send(pg, "TEST:levels"); await idle(pg)
            log = [r for r in mock_log() if r.get("path", "").endswith("/chat/completions")]
            lv = (await pg.evaluate(CHAIN))[-1]
            check("Gemini: no free-form object in the tool schemas, params as JSON text accepted, bearer key", log and log[0]["free_object_params"] == [] and log[0]["headers"]["authorization"] == "Bearer g-test" and lv["type"] == "levels" and lv["params"]["inBlack"] == 10, json.dumps(log[0]["free_object_params"] if log else None))
            await pg.evaluate("window.lucid.store.undo()")
            await configure(pg, "openrouter", "mock-router", key="or-test")
            mock_reset()
            await send(pg, "hello"); await idle(pg)
            h1 = mock_log()[-1]["headers"]
            check("OpenRouter: bearer key and attribution headers", h1["authorization"] == "Bearer or-test" and h1["x-title"] and (h1["http-referer"] or URL.startswith("file:")), json.dumps(h1))
            await configure(pg, "custom", "mock-agent")

            # command palette
            await pg.keyboard.press("Control+k")
            await pg.wait_for_selector(".pal-inp", timeout=5000)
            await pg.keyboard.type("unsharp")
            first = await pg.evaluate("document.querySelector('.pal-item.sel .pal-label').textContent")
            ids0 = {f["id"] for f in await pg.evaluate(CHAIN)}
            await pg.keyboard.press("Enter")
            await pg.wait_for_timeout(500)
            added = [f["type"] for f in await pg.evaluate(CHAIN) if f["id"] not in ids0]
            check("palette: a filter by name, Enter adds it (after the selected filter)", first == "Unsharp Masking" and added == ["unsharp_mask"], f"{first} → {added}")
            await pg.evaluate("window.lucid.store.undo()")
            await pg.keyboard.press("Control+k")
            await pg.wait_for_selector(".pal-inp", timeout=5000)
            await pg.keyboard.type("please make the plate readable")
            ask_first = await pg.evaluate("document.querySelector('.pal-item.sel').classList.contains('ask')")
            n = await users(pg)
            await pg.keyboard.press("Enter")
            await pg.wait_for_function(f"() => window.lucid.agent.items.filter((i) => i.kind === 'user').length > {n}", timeout=10000)
            await idle(pg)
            last_user = await pg.evaluate("window.lucid.agent.items.filter((i) => i.kind === 'user').pop().text")
            check("palette: a sentence goes to the assistant (Ask AI first)", ask_first and last_user == "please make the plate readable" and await reply(pg) == "Hello from the mock model.")
            await pg.keyboard.press("Control+k")
            await pg.keyboard.type("keyboard shortcuts")
            await pg.keyboard.press("Enter")
            await pg.wait_for_timeout(300)
            check("palette: menu commands", "Keyboard Shortcuts" in await pg.evaluate("[...document.querySelectorAll('.dlg')].map((d) => d.innerText).join('|')"))
            await pg.keyboard.press("Escape")
            await pg.evaluate("document.querySelectorAll('.dlg-overlay').forEach((o) => o.remove())")

            # History › Ask AI About This Filter…
            await pg.evaluate("window.lucid.ws().open('history', { focus: true })")
            row = pg.locator(".tree-row.tree-filter").nth(2)
            await row.click(button="right")
            await pg.click(".menu-popup .menu-item:has-text('Ask AI About This Filter')")
            await pg.wait_for_timeout(300)
            val = await pg.evaluate("document.querySelector('.panel.ai .ai-input').value")
            check("History › Ask AI About This Filter: the chat opens with the filter as context", val.startswith("About the ") and "filter (" in val, val)
            await pg.fill(".panel.ai .ai-input", "")

            # audit trail: project and report
            ailog = await pg.evaluate("window.lucid.store.project.aiLog")
            saved = await pg.evaluate("JSON.parse(JSON.stringify(window.lucid.store.project)).aiLog.length")
            check("audit log kept in the project (saved with it)", len(ailog) >= 15 and saved == len(ailog), f"{len(ailog)} requests")
            if DEV:
                html = await pg.evaluate("(async () => { const m = await import('/src/app/report.ts'); return m.buildReport(window.lucid, () => {}); })()")
                check("report: AI Assistance section with requests, models and actions", "AI Assistance" in html and "TEST:levels" in html and "Add Levels" in html and "mock-agent" in html and "carried out through the AI assistant" in html)
            check("no page errors", not errors, "; ".join(errors)[:300])
            await ctx.close()
    finally:
        srv.terminate()
    print(f"\n{sum(results)}/{len(results)} passed", flush=True)
    sys.exit(0 if all(results) else 1)

asyncio.run(main())
