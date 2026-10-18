// Official MCP SDK clients against the LUCID MCP bridge (tests/e2e/mcp.py runs this while a LUCID tab is
// linked to the bridge). Prints one "RESULT {json}" line per check.
//   node tests/mcp/clients.mjs <port> <scenario...>
// Scenarios: v1-stdio v1-http v2-modern-http v2-auto-stdio v2-legacy-http raw readonly off
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Client as Client1 } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as Stdio1 } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport as Http1 } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client as Client2, StreamableHTTPClientTransport as Http2 } from "@modelcontextprotocol/client";
import { StdioClientTransport as Stdio2 } from "@modelcontextprotocol/client/stdio";

const PORT = Number(process.argv[2]);
const BRIDGE = fileURLToPath(new URL("../../mcp/lucid-mcp.mjs", import.meta.url));
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
const out = (name, ok, info = "") => console.log(`RESULT ${JSON.stringify({ name, ok: !!ok, info: String(info).slice(0, 300) })}`);
const text = (r) => (r?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const env = { ...process.env, LUCID_MCP_NO_OPEN: "1" };

async function exercise(tag, client, { write = false } = {}) {
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  out(`${tag}: tools/list has LUCID's 31 tools with annotations`, names.length >= 31 && names.includes("get_state") && names.includes("view_frame") && tools.tools.find((t) => t.name === "get_state")?.annotations?.readOnlyHint === true, `${names.length} tools`);
  const st = await client.callTool({ name: "get_state", arguments: {} });
  let state = null; try { state = JSON.parse(text(st)); } catch { /* not JSON */ }
  out(`${tag}: tools/call get_state runs in the LUCID tab`, !st.isError && state && Array.isArray(state.chains ?? state.project?.chains ?? []), text(st).slice(0, 160));
  const res = await client.readResource({ uri: "lucid://project" });
  let proj = null; try { proj = JSON.parse(res.contents[0].text); } catch { /* */ }
  out(`${tag}: resources/read lucid://project`, proj && Array.isArray(proj.chains), res.contents?.[0]?.text?.slice(0, 120));
  const pr = await client.getPrompt({ name: "assess_evidence", arguments: { chain: "c1" } });
  out(`${tag}: prompts/get assess_evidence`, pr.messages?.[0]?.content?.text?.includes("get_source_info"), pr.messages?.[0]?.content?.text?.slice(0, 80));
  if (write) {
    const add = await client.callTool({ name: "add_filter", arguments: { type: "levels", params: { inBlack: 7 } } });
    out(`${tag}: tools/call add_filter changes the project (after the examiner's approval)`, !add.isError && /levels/i.test(text(add)), text(add).slice(0, 200));
  }
}

const scenarios = {
  async "v1-stdio"() {
    const c = new Client1({ name: "sdk-v1-stdio", version: "1.32" });
    await c.connect(new Stdio1({ command: process.execPath, args: [BRIDGE, "--port", String(PORT)], env, stderr: "ignore" }));
    out("v1-stdio: initialize (legacy era) through a relaying second bridge", c.getServerVersion()?.name === "lucid", JSON.stringify(c.getServerVersion()));
    await exercise("v1-stdio", c, { write: true });
    await c.close();
  },
  async "v1-http"() {
    const c = new Client1({ name: "sdk-v1-http", version: "1.32" });
    await c.connect(new Http1(new URL(URL_)));
    out("v1-http: initialize with Mcp-Session-Id (2025 Streamable HTTP)", c.getServerVersion()?.name === "lucid");
    await exercise("v1-http", c);
    await c.close();
  },
  async "v2-modern-http"() {
    const c = new Client2({ name: "sdk-v2-modern", version: "2.3" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await c.connect(new Http2(new URL(URL_)));
    out("v2-modern-http: pinned to 2026-07-28 (server/discover, per-request _meta, Mcp-Method/Mcp-Name)", true, JSON.stringify(c.getServerVersion?.() ?? {}));
    await exercise("v2-modern-http", c);
    await c.close();
  },
  async "v2-auto-stdio"() {
    const c = new Client2({ name: "sdk-v2-auto", version: "2.3" }, { versionNegotiation: { mode: "auto" } });
    await c.connect(new Stdio2({ command: process.execPath, args: [BRIDGE, "--port", String(PORT)], env, stderr: "ignore" }));
    const v = c.getNegotiatedProtocolVersion?.() ?? c.getProtocolVersion?.() ?? "";
    out("v2-auto-stdio: negotiation picks the modern era over stdio", !v || v === "2026-07-28", `version ${v || "(not exposed)"}`);
    await exercise("v2-auto-stdio", c);
    await c.close();
  },
  async "v2-legacy-http"() {
    const c = new Client2({ name: "sdk-v2-legacy", version: "2.3" });
    await c.connect(new Http2(new URL(URL_)));
    await exercise("v2-legacy-http", c);
    await c.close();
  },
  async readonly() {
    const c = new Client1({ name: "sdk-v1-http", version: "1.32" });
    await c.connect(new Http1(new URL(URL_)));
    const r = await c.callTool({ name: "add_filter", arguments: { type: "levels" } });
    out("read-only policy: a change is refused, reads still work", r.isError && /read-only/i.test(text(r)) && !(await c.callTool({ name: "get_state", arguments: {} })).isError, text(r).slice(0, 160));
    await c.close();
  },
  async off() {
    const c = new Client1({ name: "sdk-v1-http", version: "1.32" });
    await c.connect(new Http1(new URL(URL_)));
    const r = await c.callTool({ name: "get_state", arguments: {} });
    out("policy off: every call is refused", r.isError && /off/i.test(text(r)), text(r).slice(0, 160));
    await c.close();
  },
  async deny() {
    const c = new Client1({ name: "untrusted-app", version: "0.1" });
    await c.connect(new Http1(new URL(URL_)));
    const r = await c.callTool({ name: "get_state", arguments: {} });
    out("an application the examiner denies gets no access", r.isError && /did not allow/i.test(text(r)), text(r).slice(0, 160));
    await c.close();
  },
  async raw() {
    const meta = (v = "2026-07-28") => ({ "io.modelcontextprotocol/protocolVersion": v, "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} });
    const post = (body, headers = {}) => new Promise((ok) => {
      const req = http.request({ host: "127.0.0.1", port: PORT, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (res) => {
        let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch { /* */ } ok({ status: res.statusCode, json: j, headers: res.headers }); });
      });
      req.end(typeof body === "string" ? body : JSON.stringify(body));
    });
    const H = (method, extra = {}) => ({ "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...extra });
    let r = await post({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta() } }, H("server/discover"));
    out("raw: server/discover (modern) lists supported versions", r.status === 200 && r.json?.result?.supportedVersions?.includes("2026-07-28") && r.json.result.supportedVersions.includes("2025-11-25") && r.json.result.resultType === "complete", JSON.stringify(r.json?.result?.supportedVersions));
    r = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta() } }, H("tools/list"));
    out("raw: modern tools/list carries ttlMs and cacheScope", r.status === 200 && typeof r.json?.result?.ttlMs === "number" && r.json.result.cacheScope && r.json.result.tools.length >= 31);
    r = await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: meta() } }, H("tools/call"));
    out("raw: Mcp-Method that disagrees with the body → 400 HeaderMismatch (-32020)", r.status === 400 && r.json?.error?.code === -32020);
    r = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_state", arguments: {}, _meta: meta() } }, H("tools/call"));
    out("raw: tools/call without Mcp-Name → 400 HeaderMismatch", r.status === 400 && r.json?.error?.code === -32020);
    r = await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_state", arguments: {}, _meta: meta() } }, H("tools/call", { "mcp-name": "=?base64?Z2V0X3N0YXRl?=" }));
    out("raw: Base64-encoded Mcp-Name is decoded and accepted", r.status === 200 && r.json?.result && !r.json.result.isError, JSON.stringify(r.json).slice(0, 120));
    r = await post({ jsonrpc: "2.0", id: 6, method: "tools/list", params: { _meta: meta("2099-01-01") } }, H("tools/list", { "mcp-protocol-version": "2099-01-01" }));
    out("raw: unknown version → 400 UnsupportedProtocolVersion (-32022) with the supported list", r.status === 400 && r.json?.error?.code === -32022 && r.json.error.data?.supported?.includes("2026-07-28"));
    r = await post({ jsonrpc: "2.0", id: 7, method: "nope/nope", params: { _meta: meta() } }, H("nope/nope"));
    out("raw: unknown method (modern) → 404 with -32601", r.status === 404 && r.json?.error?.code === -32601);
    r = await post({ jsonrpc: "2.0", id: 8, method: "tools/list" }, { "mcp-session-id": "bogus", "mcp-protocol-version": "2025-11-25" });
    out("raw: unknown legacy session → 404", r.status === 404);
    r = await post({ jsonrpc: "2.0", id: 9, method: "tools/list" }, { origin: "http://evil.example" });
    out("raw: foreign Origin → 403 (DNS rebinding / CSRF protection)", r.status === 403);
    r = await post({ jsonrpc: "2.0", id: 10, method: "tools/list" }, { host: "evil.example:80" });
    out("raw: foreign Host header → 403", r.status === 403);
    r = await new Promise((ok) => http.get({ host: "127.0.0.1", port: PORT, path: "/mcp", headers: { accept: "text/event-stream" } }, (res) => { res.resume(); ok({ status: res.statusCode }); }));
    out("raw: GET /mcp (no standalone stream) → 405", r.status === 405);
    r = await post("{not json", {});
    out("raw: malformed JSON → 400 Parse error (-32700)", r.status === 400 && r.json?.error?.code === -32700);
    r = await new Promise((ok) => http.get({ host: "127.0.0.1", port: PORT, path: "/lucid/link", headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site" } }, (res) => { res.resume(); ok({ status: res.statusCode }); }));
    out("raw: a foreign page cannot link as a LUCID tab without the pairing code", r.status === 403);
    r = await new Promise((ok) => http.get({ host: "127.0.0.1", port: PORT, path: "/../../etc/passwd" }, (res) => { res.resume(); ok({ status: res.statusCode }); }));
    out("raw: path traversal out of the app folder is refused", r.status === 404 || r.status === 400);
  },
};

for (const s of process.argv.slice(3)) {
  try { await scenarios[s](); }
  catch (e) { out(`${s}: completed without errors`, false, e?.stack ?? e); }
}
process.exit(0);
