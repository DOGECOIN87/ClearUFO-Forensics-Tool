// MCP client protocol details, against a scripted fake server (global fetch replaced):
//  1. header value encoding (Base64 sentinel) and x-mcp-header annotation validation (2026-07-28),
//  2. modern requests carry MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Param-* and _meta,
//  3. Multi Round-Trip Requests: input_required → elicitation → retry with inputResponses + requestState,
//  4. era detection: a 400 without a modern error → legacy initialize + Mcp-Session-Id; a modern error does not fall back,
//  5. LUCID's tool results in MCP's CallToolResult shape; the catalog the bridge serves.
import { encodeHeaderValue, headerParams, McpClient, MODERN } from "../src/mcp/client";
import { catalogJson, toCallToolResult } from "../src/mcp/catalog";

let fail = 0, pass = 0;
const ok = (cond: unknown, msg: string) => { if (cond) { pass++; if (process.env.VERBOSE) console.log("ok  ", msg); } else { fail++; console.log("FAIL", msg); } };

// 1
ok(encodeHeaderValue("get_state") === "get_state", "plain ASCII stays as is");
ok(encodeHeaderValue("Hello, 世界") === "=?base64?SGVsbG8sIOS4lueVjA==?=", "non-ASCII → Base64 sentinel (spec example)");
ok(encodeHeaderValue(" padded ") === "=?base64?IHBhZGRlZCA=?=", "leading/trailing space → Base64 (spec example)");
ok(encodeHeaderValue("line1\nline2") === "=?base64?bGluZTEKbGluZTI=?=", "newline → Base64 (spec example)");
ok(encodeHeaderValue("=?base64?literal?=") === "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=", "a value that looks like the sentinel is encoded (spec example)");
ok(JSON.stringify(headerParams({ type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" }, q: { type: "string" } } })) === JSON.stringify([{ path: ["region"], header: "Region" }]), "x-mcp-header found");
ok(JSON.stringify(headerParams({ type: "object", properties: { a: { type: "object", properties: { b: { type: "integer", "x-mcp-header": "B" } } } } })) === JSON.stringify([{ path: ["a", "b"], header: "B" }]), "nested properties chain is allowed");
ok(headerParams({ type: "object", properties: { n: { type: "number", "x-mcp-header": "N" } } }) === null, "number parameters may not be mirrored → tool rejected");
ok(headerParams({ type: "object", properties: { l: { type: "array", items: { type: "string", "x-mcp-header": "L" } } } }) === null, "through items → rejected");
ok(headerParams({ type: "object", properties: { a: { type: "string", "x-mcp-header": "X" }, b: { type: "string", "x-mcp-header": "x" } } }) === null, "case-insensitive duplicates → rejected");
ok(headerParams({ type: "object", properties: { a: { type: "string", "x-mcp-header": "bad header" } } }) === null, "invalid token → rejected");

// fake server
type Req = { url: string; method: string; headers: Record<string, string>; body: any };
let log: Req[] = [];
let handler: (r: Req) => { status: number; body?: any; headers?: Record<string, string> } = () => ({ status: 500 });
(globalThis as any).fetch = async (url: string, init: any) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
  const r: Req = { url, method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(init.body) : undefined };
  log.push(r);
  const out = handler(r);
  return new Response(out.body === undefined ? null : JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json", ...(out.headers ?? {}) } });
};
const hooks = { headers: async () => ({ Authorization: "Bearer t" }), elicit: async (q: any) => ({ action: "accept" as const, content: { name: `answer to ${q.message}` } }) };

async function main() {
  // 2 + 3: modern server with MRTR
  log = [];
  handler = (r) => {
    const m = r.body;
    if (m.method === "server/discover") return { status: 200, body: { jsonrpc: "2.0", id: m.id, result: { resultType: "complete", supportedVersions: [MODERN], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake", version: "9" } } } } };
    if (m.method === "tools/list") return { status: 200, body: { jsonrpc: "2.0", id: m.id, result: { resultType: "complete", ttlMs: 0, cacheScope: "public", tools: [{ name: "sql", inputSchema: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } } }, { name: "broken", inputSchema: { type: "object", properties: { n: { type: "number", "x-mcp-header": "N" } } } }] } } };
    if (m.method === "tools/call" && !m.params.inputResponses) return { status: 200, body: { jsonrpc: "2.0", id: m.id, result: { resultType: "input_required", inputRequests: { who: { method: "elicitation/create", params: { mode: "form", message: "Name?", requestedSchema: { type: "object", properties: { name: { type: "string" } } } } } }, requestState: "opaque-1" } } };
    if (m.method === "tools/call") return { status: 200, body: { jsonrpc: "2.0", id: m.id, result: { resultType: "complete", content: [{ type: "text", text: `ok ${m.params.inputResponses.who.content.name} ${m.params.requestState}` }] } } };
    return { status: 404, body: { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } } };
  };
  const c = new McpClient("https://fake.example/mcp", "auto", hooks);
  await c.connect();
  ok(c.era === "modern" && c.serverInfo.name === "fake", "modern era from server/discover");
  const tools = await c.listTools();
  ok(tools.length === 1 && tools[0].name === "sql" && c.rejected.length === 1, "a tool with an invalid x-mcp-header annotation is excluded");
  const r = await c.callTool("sql", { region: "us-west1", q: "x" });
  ok(r.content[0].text === "ok answer to Name? opaque-1", "MRTR: elicitation answered, request retried with inputResponses and requestState");
  const call = log.filter((x) => x.body?.method === "tools/call");
  const h = call[0].headers;
  ok(h["mcp-protocol-version"] === MODERN && h["mcp-method"] === "tools/call" && h["mcp-name"] === "sql" && h["mcp-param-region"] === "us-west1" && h.authorization === "Bearer t", "modern headers: version, method, name, x-mcp-header parameter, auth");
  ok(call[0].body.params._meta["io.modelcontextprotocol/protocolVersion"] === MODERN && call[0].body.params._meta["io.modelcontextprotocol/clientInfo"].name, "request _meta: protocol version and client info");
  ok(call.length === 2 && call[1].body.id !== call[0].body.id, "the retry is a new request (new id)");
  ok(!log.some((x) => x.body?.method === "initialize"), "no initialize handshake in the modern era");

  // 4: legacy server
  log = [];
  handler = (r) => {
    const m = r.body;
    if (m.method === "server/discover") return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: Server not initialized" } } };
    if (m.method === "initialize") return { status: 200, body: { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "old" } } }, headers: { "mcp-session-id": "S1" } };
    if (m.method === "notifications/initialized") return { status: 202 };
    if (m.method === "tools/list") return { status: 200, body: { jsonrpc: "2.0", id: m.id, result: { tools: [] } } };
    return { status: 405 };
  };
  const l = new McpClient("https://old.example/mcp", "auto", hooks);
  await l.connect();
  await l.listTools();
  const lt = log.find((x) => x.body?.method === "tools/list")!;
  ok(l.era === "legacy" && l.version === "2025-06-18", "400 without a modern error → legacy initialize");
  ok(lt.headers["mcp-session-id"] === "S1" && lt.headers["mcp-protocol-version"] === "2025-06-18" && !lt.headers["mcp-method"], "legacy requests: session id and negotiated version, no modern headers");
  l.close();

  // a modern server that rejects our version must not be mistaken for a legacy one
  handler = (r) => ({ status: 400, body: { jsonrpc: "2.0", id: r.body.id, error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2027-01-01"], requested: MODERN } } } });
  let err = "";
  try { await new McpClient("https://future.example/mcp", "auto", hooks).connect(); } catch (e) { err = (e as Error).message; }
  ok(/only supports protocol versions 2027-01-01/.test(err), "UnsupportedProtocolVersion from a modern server: clear error, no legacy fallback");

  // 5
  const res = toCallToolResult({ ok: true, data: { a: 1 }, image: { mime: "image/jpeg", data: "AAA" } });
  ok(res.content[0].type === "text" && (res.structuredContent as any).a === 1 && res.content[1].type === "image" && !res.isError, "tool result → text + structuredContent + image");
  ok(toCallToolResult({ ok: false, error: "nope" }).isError === true, "tool error → isError");
  const cat = catalogJson();
  ok(cat.tools.length === 31 && cat.tools.every((t) => t.inputSchema.type === "object" && /^[a-z_]+$/.test(t.name)), "catalog: 31 tools with object schemas and header-safe names");
  ok(cat.tools.find((t) => t.name === "delete_chain")!.annotations.destructiveHint && cat.tools.find((t) => t.name === "get_state")!.annotations.readOnlyHint, "catalog: destructive / read-only hints");

  console.log(`mcp: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main();
