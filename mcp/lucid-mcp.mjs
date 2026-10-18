#!/usr/bin/env node
// LUCID MCP bridge (Model Context Protocol). Zero dependencies, Node 18+.
//
// 1. MCP SERVER for AI applications (Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Gemini CLI, Codex,
//    any MCP client): every LUCID tool, plus resources (project, audit log, filters) and prompts. A browser tab
//    cannot listen on a port, so this process speaks MCP and relays each call to the LUCID tab, where the
//    examiner's policy, approvals, frame consent and the audit log apply.
//    Transports: stdio (what MCP clients launch) and Streamable HTTP at http://127.0.0.1:47800/mcp.
//    Protocol eras: modern (2026-07-28: per-request _meta, server/discover, Mcp-Method/Mcp-Name headers) and
//    legacy (2025-11-25 … 2024-11-05: initialize handshake, Mcp-Session-Id) — both, per request.
// 2. It SERVES THE APP itself (the built release/ folder), so the LUCID tab and the bridge share one origin:
//    no CORS, mixed-content or private-network prompts. Other origins can link with the pairing code.
// 3. MCP SERVERS FOR LUCID'S OWN ASSISTANT that a browser cannot reach: stdio servers it launches and remote
//    servers without CORS, configured like Claude Desktop ("mcpServers" in ~/.lucid-mcp/servers.json) and
//    exposed to the tab at /servers/<name>/mcp.
//
// Usage:
//   node mcp/lucid-mcp.mjs                 stdio MCP server + web server (MCP clients start it like this)
//   node mcp/lucid-mcp.mjs --http          web server only (app + /mcp), e.g. for clients that take a URL
// Options: --port 47800  --host 127.0.0.1  --app <dir>  --config <servers.json>  --allow-origin <origin>
//          --token <secret> (require "Authorization: Bearer <secret>" on /mcp)  --no-open  --help
import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const VERSION = "1.0.0";
const MODERN = ["2026-07-28"];
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SUPPORTED = [...MODERN, ...LEGACY];
const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------------------------------------ options
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def; };
const flag = (name) => argv.includes(`--${name}`);
if (flag("help") || flag("h")) {
  process.stderr.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).slice(0, 24).map((l) => l.slice(3)).join("\n") + "\n");
  process.exit(0);
}
const PORT = Number(opt("port", process.env.LUCID_MCP_PORT ?? 47800));
const HOST = opt("host", "127.0.0.1");
const APP_DIR = resolve(opt("app", process.env.LUCID_APP_DIR ?? join(HERE, "..", "release")));
const TOKEN = opt("token", process.env.LUCID_MCP_TOKEN ?? "");
const STDIO = !flag("http") && !process.stdin.isTTY; // started from a terminal: web server only
const AUTO_OPEN = !flag("no-open") && process.env.LUCID_MCP_NO_OPEN !== "1";
const allowOrigins = new Set(argv.flatMap((a, i) => (a === "--allow-origin" && argv[i + 1] ? [argv[i + 1].replace(/\/$/, "")] : [])));
const STATE_DIR = process.env.LUCID_MCP_HOME ?? join(os.homedir(), ".lucid-mcp");
const CONFIG = opt("config", join(STATE_DIR, "servers.json"));
const log = (...a) => process.stderr.write(`[lucid-mcp] ${a.join(" ")}\n`);

function state() {
  try { mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 }); } catch { /* read-only home */ }
  const f = join(STATE_DIR, "pairing.json");
  try { const s = JSON.parse(readFileSync(f, "utf8")); if (s.code) return s; } catch { /* first run */ }
  const s = { code: randomBytes(5).toString("hex").toUpperCase() };
  try { writeFileSync(f, JSON.stringify(s), { mode: 0o600 }); } catch { /* keep in memory */ }
  return s;
}
const PAIRING = state().code;
const SECRET = randomBytes(24).toString("hex"); // for stdio relays of a second instance
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// ------------------------------------------------------------------------------------------------ catalog
function loadCatalog() {
  try { return JSON.parse(readFileSync(join(HERE, "catalog.json"), "utf8")); }
  catch { return { app: { name: "LUCID", version: "?" }, instructions: "", tools: [], resources: [], prompts: [] }; }
}
const CATALOG = loadCatalog();
const SERVER_INFO = { name: "lucid", title: `${CATALOG.app.fullName ?? "LUCID Forensic Workbench"} (MCP bridge)`, version: VERSION };
// list changes (a LUCID tab linking with its live catalog) can only be announced to legacy stdio clients
const caps = (sess) => { const lc = sess.era === "legacy" && sess.transport === "stdio"; return { tools: { listChanged: lc }, resources: { listChanged: false }, prompts: { listChanged: false }, logging: {} }; };
const tools = () => active?.catalog?.tools?.length ? active.catalog.tools : CATALOG.tools;

// ------------------------------------------------------------------------------------------------ LUCID tabs
const links = new Map(); // id → { id, res, since, origin, catalog }
let active = null;
const pending = new Map(); // call id → { resolve, link }
let callSeq = 0, lastOpen = 0;
const appUrl = () => `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}/`;

function sse(res, msg) { try { res.write(`data: ${JSON.stringify(msg)}\n\n`); } catch { /* closed */ } }
function pickActive() {
  const prev = active;
  active = [...links.values()].sort((a, b) => b.since - a.since)[0] ?? null;
  for (const l of links.values()) sse(l.res, { type: l === active ? "active" : "standby" });
  if (prev !== active) notifyListChanged();
}
function waitForTab(ms) {
  return new Promise((ok) => {
    if (active) return ok(active);
    const t0 = Date.now(), iv = setInterval(() => { if (active || Date.now() - t0 > ms) { clearInterval(iv); ok(active); } }, 250);
  });
}
function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch { /* no desktop */ }
}
/** Relay one request to the active LUCID tab; resolves with what the tab answers. */
async function tabRequest(msg, signal) {
  let tab = active;
  if (!tab) {
    if (AUTO_OPEN && servedApp && Date.now() - lastOpen > 60000) { lastOpen = Date.now(); log(`no LUCID tab is linked: opening ${appUrl()}`); openBrowser(appUrl()); }
    tab = await waitForTab(AUTO_OPEN ? 45000 : 1500);
  }
  if (!tab) throw Object.assign(new Error(`LUCID is not open. Open ${appUrl()} in a browser (or link a LUCID tab in AI panel › MCP), then try again.`), { tool: true });
  const id = `c${++callSeq}`;
  return new Promise((ok, fail) => {
    const done = (v, e) => { pending.delete(id); signal?.removeEventListener?.("abort", onAbort); e ? fail(e) : ok(v); };
    const onAbort = () => { sse(tab.res, { type: "cancel", id }); done(null, Object.assign(new Error("Cancelled"), { code: -32800 })); };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    pending.set(id, { resolve: done, link: tab });
    sse(tab.res, { ...msg, id });
  });
}

// ------------------------------------------------------------------------------------------------ MCP core
class RpcError extends Error { constructor(code, message, data) { super(message); this.code = code; this.data = data; } }
const META_VERSION = "io.modelcontextprotocol/protocolVersion", META_CLIENT = "io.modelcontextprotocol/clientInfo";
const cacheable = (sess, ttlMs = 60000) => (sess.era === "modern" ? { ttlMs, cacheScope: "public" } : {});
const complete = (sess) => (sess.era === "modern" ? { resultType: "complete" } : {});
const clientLabel = (sess) => { const c = sess.clientInfo ?? {}; return `${c.title || c.name || "MCP client"}${c.version ? ` ${c.version}` : ""}`; };

function fill(template, args) { return String(template).replace(/\{\{(\w+)\}\}/g, (_, k) => (args?.[k] != null && args[k] !== "" ? String(args[k]) : "")); }

async function dispatch(method, p, sess, signal) {
  switch (method) {
    case "initialize": {
      sess.era = "legacy";
      sess.version = LEGACY.includes(p.protocolVersion) ? p.protocolVersion : LEGACY[0];
      sess.clientInfo = p.clientInfo;
      log(`${clientLabel(sess)} connected (protocol ${sess.version}, ${sess.transport})`);
      return { protocolVersion: sess.version, capabilities: caps(sess), serverInfo: SERVER_INFO, instructions: CATALOG.instructions };
    }
    case "server/discover":
      return { resultType: "complete", supportedVersions: SUPPORTED, capabilities: caps(sess), _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO }, instructions: CATALOG.instructions, ttlMs: 60000, cacheScope: "public" };
    case "ping": return {};
    case "logging/setLevel": return {};
    case "completion/complete": return { completion: { values: [], hasMore: false } };
    case "tools/list": return { tools: tools(), ...cacheable(sess) };
    case "tools/call": {
      const name = String(p.name ?? "");
      if (!tools().some((t) => t.name === name)) throw new RpcError(-32602, `Unknown tool: ${name}`);
      try {
        const r = await tabRequest({ type: "tool", name, args: p.arguments ?? {}, client: clientLabel(sess), transport: sess.transport }, signal);
        return { ...complete(sess), ...r };
      } catch (e) {
        if (e.code === -32800) throw new RpcError(-32800, "Request cancelled");
        return { ...complete(sess), content: [{ type: "text", text: e.message }], isError: true };
      }
    }
    case "resources/list": return { resources: CATALOG.resources, ...cacheable(sess) };
    case "resources/templates/list": return { resourceTemplates: [], ...cacheable(sess) };
    case "resources/read": {
      const uri = String(p.uri ?? "");
      if (!CATALOG.resources.some((r) => r.uri === uri)) throw new RpcError(-32002, `Resource not found: ${uri}`, { uri });
      if (uri === "lucid://help") return { ...complete(sess), contents: [{ uri, mimeType: "text/markdown", text: CATALOG.help ?? CATALOG.instructions }], ...cacheable(sess, 0) };
      try {
        const r = await tabRequest({ type: "resource", uri, client: clientLabel(sess), transport: sess.transport }, signal);
        return { ...complete(sess), ...r, ...cacheable(sess, 0) };
      } catch (e) { throw new RpcError(-32603, e.message); }
    }
    case "prompts/list": return { prompts: CATALOG.prompts.map(({ template, ...rest }) => rest), ...cacheable(sess) };
    case "prompts/get": {
      const pr = CATALOG.prompts.find((x) => x.name === p.name);
      if (!pr) throw new RpcError(-32602, `Unknown prompt: ${p.name}`);
      for (const a of pr.arguments ?? []) if (a.required && !p.arguments?.[a.name]) throw new RpcError(-32602, `Missing argument: ${a.name}`);
      return { ...complete(sess), description: pr.description, messages: [{ role: "user", content: { type: "text", text: fill(pr.template, p.arguments) } }] };
    }
    case "subscriptions/listen": throw new RpcError(-32601, "Method not found: subscriptions/listen (list changes are announced on stdio only)");
    default: throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

/** Handle one JSON-RPC message for a session; returns the response (null for notifications). */
async function handle(msg, sess, signal) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    if (msg && typeof msg === "object" && ("result" in msg || "error" in msg)) return null; // a response to us: none expected
    return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  }
  const isRequest = msg.id !== undefined && msg.id !== null;
  const p = msg.params && typeof msg.params === "object" ? msg.params : {};
  if (!isRequest) {
    if (msg.method === "notifications/initialized") sess.initialized = true;
    if (msg.method === "notifications/cancelled") sess.inflight?.get(p.requestId)?.abort();
    return null;
  }
  const v = p._meta?.[META_VERSION];
  if (v !== undefined && msg.method !== "initialize") {
    sess.era = "modern";
    if (!MODERN.includes(v)) return { jsonrpc: "2.0", id: msg.id, error: { code: -32022, message: "Unsupported protocol version", data: { supported: SUPPORTED, requested: v } } };
    if (p._meta[META_CLIENT]) sess.clientInfo = p._meta[META_CLIENT];
  }
  const ac = new AbortController();
  signal?.addEventListener?.("abort", () => ac.abort(), { once: true });
  (sess.inflight ??= new Map()).set(msg.id, ac);
  try {
    const result = await dispatch(msg.method, p, sess, ac.signal);
    // 2026-07-28: every result states its type ("complete"; "input_required" is never needed here)
    return { jsonrpc: "2.0", id: msg.id, result: sess.era === "modern" ? { resultType: "complete", ...result } : result };
  } catch (e) {
    return { jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message ?? String(e), ...(e.data ? { data: e.data } : {}) } };
  } finally { sess.inflight.delete(msg.id); }
}

// ------------------------------------------------------------------------------------------------ stdio
const stdioSess = { transport: "stdio", era: null };
let stdioOut = null; // set when serving stdio
function notifyListChanged() {
  if (stdioOut && stdioSess.era === "legacy" && stdioSess.initialized) stdioOut({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
}
function serveStdio(forward) {
  stdioOut = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { stdioOut({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    const r = forward ? await forward(msg) : await handle(msg, stdioSess);
    if (r) stdioOut(r);
  });
  rl.on("close", () => { log("stdin closed: exiting"); shutdown(0); });
}

// ------------------------------------------------------------------------------------------------ HTTP
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".wasm": "application/wasm", ".map": "application/json", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".webmanifest": "application/manifest+json" };
const servedApp = existsSync(join(APP_DIR, "index.html"));
const legacySessions = new Map(); // Mcp-Session-Id → session
const selfOrigins = () => new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`, `http://${HOST}:${PORT}`]);
const hostOk = (req) => { const h = String(req.headers.host ?? "").toLowerCase(); return [...selfOrigins()].some((o) => o.slice(7) === h) || HOST === "0.0.0.0"; };
const originOk = (origin) => !origin || selfOrigins().has(origin) || allowOrigins.has(origin);
const json = (res, status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(body === undefined ? "" : JSON.stringify(body)); };
const rpcErr = (id, code, message, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
function cors(req, res, extra = {}) {
  const o = req.headers.origin;
  if (!o) return;
  res.setHeader("Access-Control-Allow-Origin", o);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, accept, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, last-event-id, x-lucid-link");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, www-authenticate, mcp-protocol-version");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}
/** May this request act as (or for) a LUCID tab? Same origin, a non-browser local client, or the pairing code. */
function linkOk(req, url) {
  const site = req.headers["sec-fetch-site"], origin = req.headers.origin;
  if (origin ? selfOrigins().has(origin) : !site || site === "same-origin" || site === "none") return true;
  const code = url.searchParams.get("code") ?? req.headers["x-lucid-link"];
  return !!code && safeEq(String(code).toUpperCase(), PAIRING);
}
async function body(req, limit = 64 << 20) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error("body too large"); chunks.push(c); }
  return Buffer.concat(chunks).toString("utf8");
}
const decodeHeader = (v) => { const m = /^=\?base64\?(.*)\?=$/.exec(v ?? ""); return m ? Buffer.from(m[1], "base64").toString("utf8") : v; };

async function mcpEndpoint(req, res) {
  if (!originOk(req.headers.origin)) return json(res, 403, rpcErr(null, -32600, "Forbidden origin"));
  cors(req, res);
  if (TOKEN && !safeEq(String(req.headers.authorization ?? ""), `Bearer ${TOKEN}`)) return json(res, 401, rpcErr(null, -32600, "Unauthorized"), { "WWW-Authenticate": 'Bearer realm="lucid-mcp"' });
  if (req.method === "GET") return json(res, 405, rpcErr(null, -32600, "Method not allowed: no standalone stream"), { Allow: "POST, DELETE" });
  if (req.method === "DELETE") { legacySessions.delete(String(req.headers["mcp-session-id"] ?? "")); return json(res, 200, {}); }
  if (req.method !== "POST") return json(res, 405, rpcErr(null, -32600, "Method not allowed"), { Allow: "POST, DELETE" });
  let msg;
  try { msg = JSON.parse(await body(req)); } catch { return json(res, 400, rpcErr(null, -32700, "Parse error")); }
  if (Array.isArray(msg)) return json(res, 400, rpcErr(null, -32600, "JSON-RPC batches are not supported"));
  const hv = req.headers["mcp-protocol-version"], mv = msg?.params?._meta?.[META_VERSION];
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); }); // closing the response cancels the request
  if (msg?.method === "initialize") {
    const sess = { transport: "http", era: "legacy" }, sid = randomBytes(16).toString("hex");
    const r = await handle(msg, sess, ac.signal);
    if (!r.error) legacySessions.set(sid, sess);
    return json(res, 200, r, r.error ? {} : { "Mcp-Session-Id": sid });
  }
  const modern = mv !== undefined || (hv !== undefined && !LEGACY.includes(hv));
  if (modern) {
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (isRequest) {
      if (hv === undefined || hv !== mv) return json(res, 400, rpcErr(msg.id, -32020, `Header mismatch: MCP-Protocol-Version '${hv ?? ""}' does not match _meta '${mv ?? ""}'`));
      if (req.headers["mcp-method"] !== msg.method) return json(res, 400, rpcErr(msg.id, -32020, `Header mismatch: Mcp-Method '${req.headers["mcp-method"] ?? ""}' does not match body '${msg.method}'`));
      const nameField = msg.method === "tools/call" || msg.method === "prompts/get" ? msg.params?.name : msg.method === "resources/read" ? msg.params?.uri : undefined;
      if (nameField !== undefined && decodeHeader(req.headers["mcp-name"]) !== String(nameField)) return json(res, 400, rpcErr(msg.id, -32020, `Header mismatch: Mcp-Name does not match the body`));
    }
    const r = await handle(msg, { transport: "http", era: "modern" }, ac.signal);
    if (!r) return json(res, 202);
    const status = r.error?.code === -32022 || r.error?.code === -32600 ? 400 : r.error?.code === -32601 ? 404 : 200;
    return json(res, status, r);
  }
  const sid = req.headers["mcp-session-id"];
  if (!sid) return json(res, 400, rpcErr(msg?.id, -32600, "Bad Request: no Mcp-Session-Id (send initialize first)"));
  const sess = legacySessions.get(String(sid));
  if (!sess) return json(res, 404, rpcErr(msg?.id, -32600, "Session not found: initialize again"));
  const r = await handle(msg, sess, ac.signal);
  return r ? json(res, 200, r) : json(res, 202);
}

function staticFile(req, res, url) {
  if (!servedApp) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<!doctype html><title>LUCID MCP bridge</title><p>The LUCID MCP bridge is running, but no app build was found in ${APP_DIR} (run <code>npm run build</code>, or pass <code>--app</code>). Pairing code: <b>${PAIRING}</b>.</p>`); return; }
  let rel;
  try { rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ""); } catch { res.writeHead(400); res.end(); return; }
  if (!rel || rel.endsWith(sep) || rel.endsWith("/")) rel += "index.html";
  const file = resolve(APP_DIR, rel);
  if (!file.startsWith(APP_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return; }
  res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": rel === "index.html" ? "no-cache" : "public, max-age=3600", "X-Content-Type-Options": "nosniff" });
  createReadStream(file).pipe(res);
}

// ---- the tab link: Server-Sent Events down, POST up
function linkEndpoint(req, res, url) {
  cors(req, res);
  if (!linkOk(req, url)) return json(res, 403, { error: "pairing code required" });
  const id = randomBytes(6).toString("hex");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const link = { id, res, since: Date.now(), origin: req.headers.origin ?? "same origin", catalog: null };
  links.set(id, link);
  sse(res, { type: "hello", link: id, bridge: VERSION, pairing: false });
  log(`LUCID tab linked (${link.origin})`);
  pickActive();
  req.on("close", () => {
    links.delete(id);
    for (const [cid, p] of pending) if (p.link === link) p.resolve(null, new Error("The LUCID tab was closed or reloaded during the call."));
    log("LUCID tab unlinked");
    pickActive();
  });
}
async function replyEndpoint(req, res, url) {
  cors(req, res);
  if (!linkOk(req, url)) return json(res, 403, { error: "pairing code required" });
  let m; try { m = JSON.parse(await body(req)); } catch { return json(res, 400, { error: "bad json" }); }
  if (url.pathname === "/lucid/catalog") {
    const l = links.get(m.link);
    if (l) { l.catalog = { tools: Array.isArray(m.tools) ? m.tools : [], app: m.app }; if (l === active) notifyListChanged(); }
    return json(res, 200, { ok: !!l });
  }
  const p = pending.get(m.id);
  if (p) { if (m.error) p.resolve(null, new Error(String(m.error))); else p.resolve(m.result); }
  json(res, 200, { ok: !!p });
}

// ---- MCP servers hosted for LUCID's assistant
function loadServers() {
  try { const c = JSON.parse(readFileSync(CONFIG, "utf8")); return c.mcpServers ?? c.servers ?? {}; } catch { return {}; }
}
const hosted = new Map();
function stdioServer(name, cfg) {
  let h = hosted.get(name);
  if (h?.child && h.child.exitCode === null) return h;
  const child = spawn(cfg.command, cfg.args ?? [], { env: { ...process.env, ...(cfg.env ?? {}) }, cwd: cfg.cwd, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
  h = { child, pending: new Map(), seq: 0, init: null, initialized: false, stderr: "" };
  hosted.set(name, h);
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.method && m.id !== undefined) { // a request from the server: answer what a relay can
      const result = m.method === "ping" ? {} : m.method === "roots/list" ? { roots: [] } : undefined;
      child.stdin.write(JSON.stringify(result ? { jsonrpc: "2.0", id: m.id, result } : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `${m.method} is not available through the LUCID bridge` } }) + "\n");
      return;
    }
    if (m.id !== undefined && h.pending.has(m.id)) { const p = h.pending.get(m.id); h.pending.delete(m.id); p(m); }
  });
  child.stderr.on("data", (d) => { h.stderr = (h.stderr + d).slice(-4000); });
  child.on("error", (e) => { h.error = e.message; for (const p of h.pending.values()) p({ error: { code: -32603, message: `Could not start "${cfg.command}": ${e.message}` } }); h.pending.clear(); });
  child.on("exit", (code) => { for (const p of h.pending.values()) p({ error: { code: -32603, message: `The server exited (code ${code}). ${h.stderr.slice(-400)}` } }); h.pending.clear(); });
  log(`started MCP server "${name}": ${cfg.command} ${(cfg.args ?? []).join(" ")}`);
  return h;
}
async function serversEndpoint(req, res, url) {
  cors(req, res);
  if (!linkOk(req, url)) return json(res, 403, { error: "pairing code required" });
  const all = loadServers();
  if (url.pathname === "/lucid/servers") return json(res, 200, { servers: Object.entries(all).map(([name, c]) => ({ name, transport: c.command ? "stdio" : "http", url: `/servers/${encodeURIComponent(name)}/mcp`, description: c.description ?? (c.command ? `${c.command} ${(c.args ?? []).join(" ")}` : c.url) })) });
  const m = /^\/servers\/([^/]+)\/mcp$/.exec(url.pathname);
  const name = m ? decodeURIComponent(m[1]) : "", cfg = all[name];
  if (!cfg) return json(res, 404, rpcErr(null, -32600, `No MCP server "${name}" in ${CONFIG}`));
  if (cfg.url) { // remote server: forward (no CORS restrictions here), streaming the answer back
    const headers = { ...(cfg.headers ?? {}) };
    for (const k of ["content-type", "accept", "mcp-protocol-version", "mcp-session-id", "mcp-method", "mcp-name", "last-event-id"]) if (req.headers[k]) headers[k] = req.headers[k];
    for (const [k, v] of Object.entries(req.headers)) if (k.startsWith("mcp-param-")) headers[k] = v;
    try {
      const r = await fetch(cfg.url, { method: req.method, headers, body: req.method === "POST" ? await body(req) : undefined });
      const out = { "Content-Type": r.headers.get("content-type") ?? "application/json" };
      for (const k of ["mcp-session-id", "www-authenticate", "mcp-protocol-version"]) if (r.headers.get(k)) out[k] = r.headers.get(k);
      res.writeHead(r.status, out);
      if (r.body) for await (const c of r.body) res.write(c);
      return res.end();
    } catch (e) { return json(res, 502, rpcErr(null, -32603, `Could not reach ${cfg.url}: ${e.message}`)); }
  }
  if (req.method === "GET") return json(res, 405, rpcErr(null, -32600, "no standalone stream"), { Allow: "POST, DELETE" });
  if (req.method === "DELETE") return json(res, 200, {});
  let msg; try { msg = JSON.parse(await body(req)); } catch { return json(res, 400, rpcErr(null, -32700, "Parse error")); }
  const h = stdioServer(name, cfg);
  if (h.error) return json(res, 502, rpcErr(msg.id, -32603, h.error));
  if (msg.id === undefined || msg.id === null) { // notification
    if (msg.method === "notifications/initialized") { if (h.initialized) return json(res, 202); h.initialized = true; }
    h.child.stdin.write(JSON.stringify(msg) + "\n");
    return json(res, 202);
  }
  if (msg.method === "initialize" && h.init) return json(res, 200, { jsonrpc: "2.0", id: msg.id, result: h.init }); // one process, many page loads
  const inner = `lucid-${++h.seq}`;
  const answer = await new Promise((ok) => {
    const t = setTimeout(() => { h.pending.delete(inner); ok({ error: { code: -32603, message: "The server did not answer within 10 minutes" } }); }, 600000);
    h.pending.set(inner, (m) => { clearTimeout(t); ok(m); });
    h.child.stdin.write(JSON.stringify({ ...msg, id: inner }) + "\n");
  });
  if (msg.method === "initialize" && answer.result) h.init = answer.result;
  json(res, 200, { jsonrpc: "2.0", id: msg.id, ...(answer.error ? { error: answer.error } : { result: answer.result }) });
}

// ---- relay for a second instance whose port is taken (e.g. two MCP clients launching the bridge)
const relaySessions = new Map();
async function relayEndpoint(req, res) {
  if (!safeEq(String(req.headers["x-lucid-secret"] ?? ""), SECRET)) return json(res, 403, {});
  let m; try { m = JSON.parse(await body(req)); } catch { return json(res, 400, {}); }
  let sess = relaySessions.get(m.session);
  if (!sess) { sess = { transport: "stdio (relayed)", era: null }; relaySessions.set(m.session, sess); }
  json(res, 200, { response: await handle(m.message, sess) });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!hostOk(req)) return json(res, 403, { error: "Forbidden host (DNS rebinding protection)" });
    if (req.method === "OPTIONS") { cors(req, res); res.writeHead(204); return res.end(); }
    if (url.pathname === "/mcp") return await mcpEndpoint(req, res);
    if (url.pathname === "/lucid/info") { cors(req, res); return json(res, 200, { bridge: "lucid-mcp", version: VERSION, app: servedApp, script: linkOk(req, url) ? fileURLToPath(import.meta.url) : undefined, tabs: links.size, servers: Object.keys(loadServers()).length, mcp: `${appUrl()}mcp` }); }
    if (url.pathname === "/lucid/link") return linkEndpoint(req, res, url);
    if (url.pathname === "/lucid/reply" || url.pathname === "/lucid/catalog") return await replyEndpoint(req, res, url);
    if (url.pathname === "/lucid/servers" || url.pathname.startsWith("/servers/")) return await serversEndpoint(req, res, url);
    if (url.pathname === "/lucid/rpc" && req.method === "POST") return await relayEndpoint(req, res);
    if (req.method === "GET" || req.method === "HEAD") return staticFile(req, res, url);
    json(res, 405, { error: "method not allowed" });
  } catch (e) { try { json(res, 500, { error: String(e?.message ?? e) }); } catch { /* sent */ } }
});

setInterval(() => { for (const l of links.values()) { try { l.res.write(": ping\n\n"); } catch { /* closed */ } } }, 20000).unref();

let owner = false; // this process listens on the port (a relaying instance must not touch the instance file)
function shutdown(code) {
  for (const h of hosted.values()) { try { h.child.kill(); } catch { /* gone */ } }
  if (owner) { try { writeFileSync(join(STATE_DIR, `instance-${PORT}.json`), "{}"); } catch { /* ignore */ } }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

server.on("error", async (e) => {
  if (e.code !== "EADDRINUSE") { log(`cannot listen on ${HOST}:${PORT}: ${e.message}`); process.exit(1); }
  // another bridge owns the port: relay this client's stdio through it
  let inst = null;
  try { inst = JSON.parse(readFileSync(join(STATE_DIR, `instance-${PORT}.json`), "utf8")); } catch { /* none */ }
  if (!STDIO || !inst?.secret) { log(`port ${PORT} is in use${STDIO ? " (and not by a LUCID bridge this user started)" : ""}: choose another with --port`); process.exit(1); }
  const session = randomBytes(8).toString("hex");
  log(`a LUCID bridge already runs on port ${PORT}: relaying this client through it`);
  serveStdio(async (message) => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/lucid/rpc`, { method: "POST", headers: { "Content-Type": "application/json", "X-Lucid-Secret": inst.secret }, body: JSON.stringify({ session, message }) });
      return (await r.json()).response;
    } catch (err) { return message?.id !== undefined ? rpcErr(message.id, -32603, `relay failed: ${err.message}`) : null; }
  });
});
server.listen(PORT, HOST, () => {
  owner = true;
  try { writeFileSync(join(STATE_DIR, `instance-${PORT}.json`), JSON.stringify({ secret: SECRET, pid: process.pid }), { mode: 0o600 }); } catch { /* single instance only */ }
  log(`LUCID MCP bridge ${VERSION}: app ${servedApp ? appUrl() : `(no build in ${APP_DIR})`} · MCP endpoint ${appUrl()}mcp${TOKEN ? " (token required)" : ""} · pairing code ${PAIRING}${STDIO ? " · stdio" : ""}`);
  const n = Object.keys(loadServers()).length;
  if (n) log(`${n} MCP server(s) offered to LUCID's assistant from ${CONFIG}`);
  if (STDIO) serveStdio(null);
});
