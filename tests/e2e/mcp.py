"""MCP in both directions, in a real browser, against the official MCP SDKs (v1 1.32 and v2 2.3).

1. AI applications → LUCID (LUCID as an MCP server through mcp/lucid-mcp.mjs):
   SDK clients over stdio (relayed through a second bridge process) and Streamable HTTP, legacy (2025 initialize)
   and modern (2026-07-28) eras: tools/list, tools/call (executed in the LUCID tab), resources/read,
   prompts/get, a change approved by the examiner, transport security (Origin, Host, header validation,
   version errors), the examiner's policy (read-only, off, denying an application), the audit log.
2. LUCID's assistant → MCP servers (LUCID as an MCP client), from the browser: a v2 dual-era server (modern
   era detected), a v1 server with sessions (legacy era) incl. elicitation, a v1 HTTP+SSE server (2024-11-05),
   a stdio server launched by the bridge, an OAuth-protected server (dynamic registration, PKCE, resource
   indicator, issuer check, sign-in popup), and the agent loop with a mock model calling an MCP tool after
   the examiner's approval.
3. The bridge serving the built app (same origin, no pairing code), when release/ is built.

Usage: URL=http://127.0.0.1:5199/ python3 tests/e2e/mcp.py
"""
import asyncio, json, os, shutil, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright

URL = os.environ.get("URL", "http://127.0.0.1:5199/")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BRIDGE_PORT = int(os.environ.get("BRIDGE_PORT", "47811"))
SRV = int(os.environ.get("MCP_SRV_PORT", "47900"))
MOCK_PORT = int(os.environ.get("MOCK_PORT", "8799"))
TMP = os.environ.get("LUCID_TMP") or tempfile.mkdtemp(prefix="lucid-mcp-")
results, procs = [], []

def check(name, ok, info=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f'  [{info}]' if info and not ok else ''}", flush=True)

def start(cmd, env=None):
    p = subprocess.Popen(cmd, cwd=ROOT, env={**os.environ, **(env or {})}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    procs.append(p)
    return p

def wait_for(p, text, timeout=20):
    t0 = time.time(); seen = ""
    while time.time() - t0 < timeout:
        line = p.stdout.readline()
        if line: seen += line
        if text in line: return seen
        if p.poll() is not None: break
    raise RuntimeError(f"{text!r} not seen: {seen[-500:]}")

async def run_clients(*scenarios, timeout=240):
    p = await asyncio.create_subprocess_exec("node", "tests/mcp/clients.mjs", str(BRIDGE_PORT), *scenarios, cwd=ROOT, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                                             env={**os.environ, "LUCID_MCP_HOME": HOME, "LUCID_MCP_NO_OPEN": "1"})
    out, _ = await asyncio.wait_for(p.communicate(), timeout)
    lines = out.decode(errors="replace").splitlines()
    got = [json.loads(l[7:]) for l in lines if l.startswith("RESULT ")]
    if not got: print("\n".join(lines[-20:]))
    for r in got: check(r["name"], r["ok"], r["info"])
    return got

DENY = {"untrusted-app"}
async def autoclick(pg, stop):
    """The examiner: allow applications (deny the untrusted one), approve changes, answer elicitation."""
    while not stop.is_set():
        try:
            await pg.evaluate("""(deny) => {
              for (const c of document.querySelectorAll('.ai-card.open')) {
                const t = c.querySelector('.ai-card-t')?.textContent || '';
                const btn = (label) => [...c.querySelectorAll('button')].find((b) => b.textContent === label);
                if (t.includes('wants to use LUCID')) { (deny.some((d) => t.includes(d)) ? btn('Deny') : btn('Allow'))?.click(); }
                else if (t.includes('asks')) { const i = c.querySelector('input'); if (i) { i.value = 'Ada'; i.dispatchEvent(new Event('input')); [...c.querySelectorAll('button')].find((b) => b.textContent === 'Send')?.click(); } }
              }
              for (const b of document.querySelectorAll('.ai-tool.approval .ai-approve .btn.primary')) b.click();
              for (const b of document.querySelectorAll('.ai-card.consent.open .btn.primary')) b.click();
            }""", list(DENY))
        except Exception: pass
        await asyncio.sleep(0.2)

async def main():
    global HOME
    HOME = tempfile.mkdtemp(prefix="bridge-home-", dir=TMP)
    with open(os.path.join(HOME, "servers.json"), "w") as f:
        json.dump({"mcpServers": {"stdio-test": {"command": "node", "args": [os.path.join(ROOT, "tests/mcp/stdio_server.mjs")]}}}, f)
    srv = start(["node", "tests/mcp/servers.mjs", str(SRV)]); wait_for(srv, "READY")
    bridge = start(["node", "mcp/lucid-mcp.mjs", "--http", "--port", str(BRIDGE_PORT), "--no-open"], {"LUCID_MCP_HOME": HOME}); wait_for(bridge, "pairing code")
    code = json.load(open(os.path.join(HOME, "pairing.json")))["code"]
    mock = start([sys.executable, "tests/e2e/ai_mock.py", str(MOCK_PORT)]); time.sleep(0.8)

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(tempfile.mkdtemp(prefix="profile-", dir=TMP), viewport={"width": 1500, "height": 900}, args=["--no-sandbox"])
        pg = ctx.pages[0] if ctx.pages else await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL, wait_until="networkidle")
        await pg.wait_for_function("() => !!(window.lucid && window.lucid.store && window.lucid.mcp)", timeout=30000)
        stop = asyncio.Event()
        clicker = asyncio.create_task(autoclick(pg, stop))

        # ================================================================ 1. AI applications → LUCID
        await pg.evaluate("() => window.lucid.actions.loadSampleProject()")
        await pg.wait_for_function("() => window.lucid.store.project.chains.length > 0 && !!window.lucid.store.lastRender", timeout=60000)
        await pg.evaluate("([u, c]) => window.lucid.mcp.save({ external: 'ask', bridge: { enabled: true, url: u, code: c } })", [f"http://127.0.0.1:{BRIDGE_PORT}", code])
        await pg.wait_for_function("() => window.lucid.mcp.link === 'active'", timeout=15000)
        check("a LUCID tab on another origin links to the bridge with the pairing code", True)
        await run_clients("v1-stdio", "v1-http", "v2-modern-http", "v2-auto-stdio", "v2-legacy-http", "raw")
        st = await pg.evaluate("""() => { const s = window.lucid.store, f = s.chain().filters.filter((x) => x.type === 'levels').find((x) => x.params.inBlack === 7);
          return { levels: f ? f.params.inBlack : null, log: (s.project.aiLog || []).filter((e) => e.provider.startsWith('MCP client:')).map((e) => ({ p: e.provider, n: e.actions.length })),
                   via: document.querySelectorAll('.ai-via').length } }""")
        check("the approved change made by an MCP client is in the project (Levels, input black 7)", st["levels"] == 7, json.dumps(st))
        clients = {e["p"] for e in st["log"]}
        check("every MCP client session is in the audit log (report › AI assistance)", any("sdk-v1-stdio" in c for c in clients) and any("sdk-v2-modern" in c for c in clients) and all(e["n"] > 0 for e in st["log"]), json.dumps(st["log"]))
        check("MCP calls appear in the AI panel, labelled with the application", st["via"] > 0)
        await pg.evaluate("() => window.lucid.mcp.save({ external: 'read' })"); await run_clients("readonly")
        await pg.evaluate("() => window.lucid.mcp.save({ external: 'off' })"); await run_clients("off")
        await pg.evaluate("() => window.lucid.mcp.save({ external: 'ask' })"); await run_clients("deny")

        # ================================================================ 2. assistant → MCP servers
        servers = [
            {"id": "a", "name": "v2modern", "url": f"http://127.0.0.1:{SRV}/mcp", "transport": "auto", "auth": "none", "headers": {}, "approval": "ask", "enabled": True, "disabledTools": []},
            {"id": "b", "name": "v1sessions", "url": f"http://127.0.0.1:{SRV + 1}/mcp", "transport": "auto", "auth": "none", "headers": {}, "approval": "auto", "enabled": True, "disabledTools": []},
            {"id": "c", "name": "v1sse", "url": f"http://127.0.0.1:{SRV + 2}/sse", "transport": "auto", "auth": "none", "headers": {}, "approval": "auto", "enabled": True, "disabledTools": []},
            {"id": "s", "name": "stdio", "url": "/servers/stdio-test/mcp", "transport": "streamable", "auth": "none", "headers": {}, "approval": "auto", "enabled": True, "disabledTools": [], "bridge": True},
        ]
        await pg.evaluate("(l) => window.lucid.mcp.servers.save(l)", servers)
        probs = await pg.evaluate("async () => window.lucid.mcp.servers.ensure()")
        states = await pg.evaluate("() => Object.fromEntries([...window.lucid.mcp.servers.states].map(([k, v]) => [k, v]))")
        check("all four MCP servers connect from the browser", not probs, json.dumps(probs))
        check("v2 server: modern era (2026-07-28) detected with server/discover", states.get("a", {}).get("era") == "modern", json.dumps(states.get("a")))
        check("v1 server with sessions: legacy era (initialize, 2025-11-25)", states.get("b", {}).get("era") == "legacy" and states["b"].get("version") == "2025-11-25", json.dumps(states.get("b")))
        check("v1 HTTP+SSE server: deprecated 2024-11-05 transport as the fallback", states.get("c", {}).get("era") == "sse", json.dumps(states.get("c")))
        check("stdio server launched by the bridge, reached through it", states.get("s", {}).get("state") == "ready" and states["s"].get("tools") == 1, json.dumps(states.get("s")))
        names = await pg.evaluate("() => window.lucid.mcp.servers.specs(false, (x) => x).map((t) => t.name)")
        check("tools are namespaced mcp__<server>__<tool>", "mcp__v2modern__add" in names and "mcp__v1sse__add" in names and "mcp__stdio__upper" in names, json.dumps(names))
        call = "async ([n, a]) => { const r = await window.lucid.mcp.servers.call(n, a, new AbortController().signal); return JSON.parse(JSON.stringify(r)); }"
        r = await pg.evaluate(call, ["mcp__v2modern__add", {"a": 2, "b": 3}])
        check("modern tools/call (Mcp-Method/Mcp-Name headers, _meta) returns structured content", r["ok"] and r["data"]["untrusted_third_party_content"] == {"sum": 5}, json.dumps(r))
        r = await pg.evaluate(call, ["mcp__v1sessions__add", {"a": 2, "b": 3}])
        check("legacy session tools/call", r["ok"] and r["data"]["untrusted_third_party_content"] == "5", json.dumps(r))
        r = await pg.evaluate(call, ["mcp__v1sse__add", {"a": 4, "b": 4}])
        check("HTTP+SSE tools/call (response on the event stream)", r["ok"] and r["data"]["untrusted_third_party_content"] == "8", json.dumps(r))
        r = await pg.evaluate(call, ["mcp__stdio__upper", {"text": "plate"}])
        check("bridge-hosted stdio tools/call", r["ok"] and r["data"]["untrusted_third_party_content"] == "PLATE", json.dumps(r))
        r = await pg.evaluate(call, ["mcp__v2modern__pixel", {}])
        check("image content of an MCP tool reaches the model", r["ok"] and r.get("image", {}).get("mime") == "image/png", json.dumps(r)[:200])
        r = await pg.evaluate(call, ["mcp__v2modern__fail", {}])
        check("an MCP tool error is reported as an error", not r["ok"] and "deliberate failure" in r["error"], json.dumps(r))
        await pg.evaluate("() => window.lucid.focusAi()")
        r = await pg.evaluate(call, ["mcp__v1sessions__confirm", {}])
        check("elicitation: the server's question is shown to the examiner and the answer returned", r["ok"] and r["data"]["untrusted_third_party_content"] == "Hello Ada", json.dumps(r))

        # agent loop with the mock model
        await pg.evaluate("""([url]) => { const a = window.lucid.agent, s = a.settings; a.saveSettings({ provider: 'openai', baseUrls: { ...s.baseUrls, openai: url }, models: { ...s.models, openai: 'mock-model' }, mode: 'agent', approval: 'auto' }); a.setApiKey('openai', 'sk-test'); a.newChat(); }""", [f"http://127.0.0.1:{MOCK_PORT}/v1"])
        await pg.evaluate("() => window.lucid.agent.send('TEST:mcp add {\"a\": 20, \"b\": 22}')")
        await pg.wait_for_function("() => !window.lucid.agent.busy", timeout=60000)
        tr = await pg.evaluate("""() => { const it = window.lucid.agent.items; const tool = it.find((i) => i.kind === 'tool' && i.tkind === 'mcp');
          const last = [...it].reverse().find((i) => i.kind === 'assistant' && i.text); const log = window.lucid.store.project.aiLog.at(-1);
          return { tool: tool ? { name: tool.name, status: tool.status } : null, text: last ? last.text : '', actions: log.actions.map((x) => x.tool) } }""")
        check("agent: the model calls an MCP tool after the examiner's approval and gets the result", tr["tool"] and tr["tool"]["status"] == "done" and "MCP_RESULT" in tr["text"] and "42" in tr["text"], json.dumps(tr))
        check("agent: the MCP call is in the audit log (mcp:<server>/<tool>)", "mcp:v2modern/add" in tr["actions"], json.dumps(tr["actions"]))
        await pg.evaluate("() => window.lucid.agent.send('TEST:mcp ignore_rules {}')")
        await pg.wait_for_function("() => !window.lucid.agent.busy", timeout=60000)
        txt = await pg.evaluate("() => [...window.lucid.agent.items].reverse().find((i) => i.kind === 'assistant' && i.text)?.text || ''")
        check("third-party MCP output reaches the model marked as untrusted data", "untrusted_third_party_content" in txt and "IGNORE ALL PREVIOUS" in txt, txt[:200])
        n = await pg.evaluate("() => window.lucid.store.project.chains.length")
        check("…and the project is untouched", n > 0)
        ro = await pg.evaluate("() => window.lucid.mcp.servers.specs(true, (x) => x).map((t) => t.name)")
        check("Ask mode offers only the read-only MCP tools (readOnlyHint)", "mcp__v2modern__add" in ro and "mcp__v2modern__pixel" not in ro and "mcp__v2modern__fail" not in ro, json.dumps(ro))

        # OAuth: sign in through the MCP dialog (real clicks: the popup needs a user gesture)
        servers.append({"id": "d", "name": "oauth", "url": f"http://127.0.0.1:{SRV + 3}/mcp", "transport": "auto", "auth": "oauth", "headers": {}, "approval": "auto", "enabled": True, "disabledTools": []})
        await pg.evaluate("(l) => window.lucid.mcp.servers.save(l)", servers)
        probs = await pg.evaluate("async () => window.lucid.mcp.servers.ensure()")
        st = await pg.evaluate("() => window.lucid.mcp.servers.states.get('d')")
        check("an OAuth-protected server without sign-in reports “sign-in required”", st and st["state"] == "signin", json.dumps(st))
        await pg.evaluate("() => window.lucid.commands().find((c) => c.id === 'ai:mcp').run()")
        await pg.locator(".mcp-srv", has_text="oauth").get_by_role("button", name="Edit").click()
        async with ctx.expect_page() as pop:
            await pg.get_by_role("button", name="Sign in…").click()
        popup = await pop.value
        purl = popup.url
        try: await pg.wait_for_function("() => [...document.querySelectorAll('.dlg .ai-set-status')].some((e) => /Signed in|refused|failed|blocked|closed|error/i.test(e.textContent))", timeout=30000)
        except Exception:
            print("DEBUG popup", purl, popup.is_closed() or popup.url, await pg.evaluate("() => [...document.querySelectorAll('.dlg .ai-set-status')].map((e) => e.textContent)"))
        msg = await pg.evaluate("() => [...document.querySelectorAll('.dlg .ai-set-status')].map((e) => e.textContent).join(' | ')")
        check("OAuth sign-in in a popup (redirect back to LUCID, code exchanged)", "Signed in" in msg, msg)
        await pg.keyboard.press("Escape"); await pg.keyboard.press("Escape")
        probs = await pg.evaluate("async () => window.lucid.mcp.servers.ensure()")
        st = await pg.evaluate("() => window.lucid.mcp.servers.states.get('d')")
        check("after sign-in the OAuth server connects with the access token", st and st["state"] == "ready" and st.get("tools") == 4, json.dumps(st))
        log = json.loads(subprocess.run(["curl", "-s", f"http://127.0.0.1:{SRV + 3}/log"], capture_output=True, text=True).stdout)
        kinds = [e["type"] for e in log]
        check("OAuth: dynamic client registration with LUCID's redirect URI", any(e["type"] == "register" and e["client_name"] == "LUCID Forensic Workbench" for e in log), json.dumps(log)[:300])
        check("OAuth: authorization request with PKCE S256 and the resource indicator (RFC 8707)", any(e["type"] == "authorize" and e["ok"] and e["pkce"] == "S256" for e in log))
        check("OAuth: code exchanged with a verified PKCE verifier", any(e["type"] == "token" and e["ok"] and e["pkce"] for e in log), json.dumps(kinds))
        r = await pg.evaluate(call, ["mcp__oauth__add", {"a": 1, "b": 1}])
        check("OAuth server tools/call", r["ok"] and r["data"]["untrusted_third_party_content"] == {"sum": 2}, json.dumps(r))

        # ================================================================ 3. the bridge serves the built app
        if os.path.exists(os.path.join(ROOT, "release", "index.html")):
            p2 = await ctx.new_page()
            p2.on("pageerror", lambda e: errors.append(str(e)))
            await p2.goto(f"http://127.0.0.1:{BRIDGE_PORT}/", wait_until="load")  # (the bridge link is a long-lived stream: never network-idle)
            await p2.wait_for_function("() => !!(window.lucid && window.lucid.mcp)", timeout=30000)
            await p2.wait_for_function("() => window.lucid.mcp.servedByBridge && window.lucid.mcp.link === 'active'", timeout=15000)
            check("served by the bridge: the tab links automatically (same origin, no code)", True)
            await pg.wait_for_function("() => window.lucid.mcp.link === 'standby'", timeout=10000)
            check("the earlier tab goes on standby (one tab is operated at a time)", True)
            await p2.evaluate("() => window.lucid.actions.loadSampleProject()")
            await p2.wait_for_function("() => window.lucid.store.project.chains.length > 0", timeout=60000)
            asyncio.create_task(autoclick(p2, stop))
            await run_clients("v1-http")
        # ================================================================ 4. WebMCP (the browser's agent), with a stand-in registry
        p3 = await ctx.new_page()
        await p3.add_init_script("""(() => { const reg = new Map(); window.__webmcp = reg;
          Object.defineProperty(document, 'modelContext', { value: { registerTool(t, o) { if (reg.has(t.name)) return Promise.reject(new DOMException('dup', 'InvalidStateError')); reg.set(t.name, t);
            o?.signal?.addEventListener('abort', () => reg.delete(t.name)); return Promise.resolve(); } } }); })()""")
        p3.on("pageerror", lambda e: errors.append(str(e)))
        await p3.goto(URL, wait_until="load")
        await p3.wait_for_function("() => !!(window.lucid && window.lucid.mcp) && window.__webmcp.size >= 31", timeout=30000)
        info = await p3.evaluate("() => { const t = window.__webmcp.get('get_state'); return { n: window.__webmcp.size, schema: t.inputSchema?.type, ro: t.annotations?.readOnlyHint, state: window.lucid.mcp.webmcpState } }")
        check("WebMCP: the 31 tools are registered on document.modelContext with schemas and read-only hints", info["n"] == 31 and info["schema"] == "object" and info["ro"] is True and info["state"] == "registered", json.dumps(info))
        asyncio.create_task(autoclick(p3, stop))
        r = await p3.evaluate("async () => window.__webmcp.get('get_state').execute({}, { name: 'Gemini in Chrome' })")
        check("WebMCP: a tool call from the browser's agent runs under the examiner's policy (approval) and returns MCP content", not r.get("isError") and r["content"][0]["type"] == "text", json.dumps(r)[:200])
        await p3.evaluate("() => window.lucid.mcp.save({ webmcp: false })")
        check("WebMCP: turning it off unregisters the tools", await p3.evaluate("() => window.__webmcp.size") == 0)
        r = await p3.evaluate("async () => window.lucid.mcp.call('list_filters', { category: 'Sharpen' }, 'Playwright MCP')")
        check("window.lucid.mcp.call: the page API for browser-automation agents", not r.get("isError") and "unsharp" in json.dumps(r).lower(), json.dumps(r)[:160])

        stop.set(); await clicker
        check("no page errors", not errors, "; ".join(errors[:3]))
        await ctx.close()
    for pr in procs: pr.terminate()
    print(f"\nmcp: {sum(results)}/{len(results)} passed", flush=True)
    sys.exit(0 if all(results) else 1)

try: asyncio.run(main())
finally:
    for pr in procs:
        try: pr.terminate()
        except Exception: pass
