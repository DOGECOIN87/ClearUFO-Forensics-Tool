// MCP client for LUCID's assistant: connects to MCP servers over HTTP from the browser.
//  - Streamable HTTP, modern era (2026-07-28: no handshake, _meta on every request, Mcp-Method / Mcp-Name /
//    Mcp-Param-* headers, Multi Round-Trip Requests for elicitation)
//  - Streamable HTTP, legacy era (2025-11-25 … 2025-03-26: initialize, Mcp-Session-Id, server requests on SSE)
//  - HTTP+SSE (2024-11-05, deprecated) as the last fallback
// Era detection per the 2026-07-28 Backward Compatibility rules: a modern request first; a 4xx without a
// recognised modern JSON-RPC error means a legacy server. Responses may be JSON or SSE streams.
import { sseEvents } from "../ai/sse";

export const MODERN = "2026-07-28";
export const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MODERN_ERRORS = new Set([-32020, -32021, -32022]);
export const CLIENT_INFO = { name: "lucid-forensic-workbench", title: "LUCID Forensic Workbench", version: "1.0.0" };

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, any>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
  /** x-mcp-header annotations: argument path → header name part. */
  headerParams?: { path: string[]; header: string }[];
}
export interface ElicitRequest { mode?: string; message: string; requestedSchema?: any; url?: string }
export interface ElicitResult { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }
export interface ClientHooks {
  /** Extra request headers (configured headers, bearer token). */
  headers(): Promise<Record<string, string>>;
  /** 401: try to (re)authorize; true to retry. */
  unauthorized?(wwwAuthenticate: string | null, resourceUrl: string): Promise<boolean>;
  /** A server asks the user for input (elicitation). */
  elicit?(req: ElicitRequest): Promise<ElicitResult>;
  progress?(p: { progress: number; total?: number; message?: string }): void;
  /** The server announced a new tool list (already re-listed). */
  toolsChanged?(): void;
}

export class McpError extends Error {
  constructor(message: string, public code?: number, public status?: number, public data?: unknown) { super(message); }
}

/** Header value encoding of the 2026-07-28 transport (Base64 sentinel for unsafe values). */
export function encodeHeaderValue(v: string): string {
  const safe = /^[\x20-\x7e\t]*$/.test(v) && !/^\s|\s$/.test(v) && !(v.startsWith("=?base64?") && v.endsWith("?="));
  if (safe) return v;
  const bytes = new TextEncoder().encode(v);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?base64?${btoa(bin)}?=`;
}

const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** x-mcp-header annotations of a tool schema; null when one is invalid (the tool must then be dropped). */
export function headerParams(schema: any): { path: string[]; header: string }[] | null {
  const out: { path: string[]; header: string }[] = [], seen = new Set<string>();
  let bad = false;
  const walk = (s: any, path: string[], reachable: boolean) => {
    if (!s || typeof s !== "object") return;
    if (Array.isArray(s)) { s.forEach((x) => walk(x, path, false)); return; }
    if ("x-mcp-header" in s && path.length) {
      const h = s["x-mcp-header"];
      if (!reachable || typeof h !== "string" || !h || !TCHAR.test(h) || seen.has(h.toLowerCase()) || !["string", "integer", "boolean"].includes(s.type)) bad = true;
      else { seen.add(h.toLowerCase()); out.push({ path, header: h }); }
    }
    for (const [k, v] of Object.entries(s)) {
      if (k === "properties" && v && typeof v === "object") for (const [pk, pv] of Object.entries(v as object)) walk(pv, [...path, pk], reachable);
      else if (k !== "x-mcp-header" && typeof v === "object") walk(v, path, false);
    }
  };
  walk(schema, [], true);
  return bad ? null : out;
}

let reqSeq = 0;

export class McpClient {
  era: "modern" | "legacy" | "sse" | null = null;
  version = MODERN;
  session: string | null = null;
  serverInfo: { name?: string; title?: string; version?: string } = {};
  capabilities: Record<string, any> = {};
  instructions = "";
  tools: McpToolInfo[] = [];
  rejected: string[] = [];
  private sse: { endpoint: string; abort: AbortController; waiters: Map<string | number, (m: any) => void>; ready: Promise<void> } | null = null;

  constructor(public url: string, private transport: "auto" | "streamable" | "sse", private hooks: ClientHooks) {}

  /** Detect the protocol era and connect (cached per client). */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.era) return;
    if (this.transport !== "sse") {
      if (await this.tryModern(signal)) return;
      try { await this.initialize(signal); return; }
      catch (e) {
        const st = (e as McpError).status;
        if (this.transport === "streamable" || !(st === 404 || st === 405 || st === 400)) throw e;
      }
    }
    await this.openSse(signal);
    await this.initialize(signal);
  }

  private async tryModern(signal?: AbortSignal): Promise<boolean> {
    try {
      const r = await this.request("server/discover", {}, signal, "modern");
      const vs: string[] = Array.isArray(r?.supportedVersions) ? r.supportedVersions : [];
      if (vs.length && !vs.includes(MODERN)) { this.era = null; return false; }
      this.era = "modern"; this.version = MODERN;
      this.serverInfo = r?._meta?.["io.modelcontextprotocol/serverInfo"] ?? {};
      this.capabilities = r?.capabilities ?? {};
      this.instructions = r?.instructions ?? "";
      return true;
    } catch (e) {
      const err = e as McpError;
      if (err.code === -32022) { // a modern server that does not speak our version: legacy if it offers one
        const sup: string[] = (err.data as any)?.supported ?? [];
        if (sup.some((v) => LEGACY.includes(v))) return false;
        throw new McpError(`The server only supports protocol versions ${sup.join(", ")}`, err.code, err.status);
      }
      if (err.code !== undefined && MODERN_ERRORS.has(err.code)) throw e;
      if (err.status === 401 || err.status === 403) throw e;
      if (err.name === "AbortError") throw e;
      if (!(e instanceof McpError)) throw new McpError(`Cannot reach ${this.url}: ${(e as Error).message}. The server must allow requests from this page (CORS) — or add it to the LUCID MCP bridge.`);
      return false;
    }
  }

  private async initialize(signal?: AbortSignal) {
    const r = await this.request("initialize", { protocolVersion: LEGACY[0], capabilities: { elicitation: { form: {} } }, clientInfo: CLIENT_INFO }, signal, "legacy");
    const v = String(r?.protocolVersion ?? "");
    if (!LEGACY.includes(v)) throw new McpError(`The server answered with an unsupported protocol version "${v}"`);
    this.version = v;
    if (!this.sse) this.era = "legacy"; else this.era = "sse";
    this.serverInfo = r?.serverInfo ?? {};
    this.capabilities = r?.capabilities ?? {};
    this.instructions = r?.instructions ?? "";
    await this.notify("notifications/initialized", {}, signal).catch(() => { /* optional for some servers */ });
    if (this.era === "legacy") void this.openListen();
  }

  /**
   * Legacy Streamable HTTP: the optional standalone GET stream, where servers send requests not tied to a client
   * request (e.g. elicitation started outside a request context) and list change notifications.
   */
  private listen: AbortController | null = null;
  private async openListen() {
    const ac = new AbortController();
    this.listen = ac;
    try {
      const h: Record<string, string> = { Accept: "text/event-stream", ...(await this.hooks.headers()) };
      if (this.session) h["Mcp-Session-Id"] = this.session;
      if (this.version !== "2025-03-26") h["MCP-Protocol-Version"] = this.version;
      const res = await fetch(this.url, { headers: h, signal: ac.signal, credentials: "omit" });
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) { try { await res.body?.cancel(); } catch { /* none */ } return; }
      for await (const ev of sseEvents(res.body!, ac.signal)) {
        let m: any; try { m = JSON.parse(ev.data); } catch { continue; }
        if (m?.method === "notifications/tools/list_changed") { void this.listTools().then(() => this.hooks.toolsChanged?.()).catch(() => {}); continue; }
        if (m?.method && m.id !== undefined) void this.onMessage(m, undefined, "legacy");
      }
    } catch { /* closed or unsupported */ }
  }

  // ------------------------------------------------------------------------------------------- requests
  /** Send a request; handles MRTR input requests (modern) and server requests on streams (legacy). */
  async request(method: string, params: Record<string, any> = {}, signal?: AbortSignal, era = this.era ?? "modern"): Promise<any> {
    let p = params;
    for (let round = 0; round < 6; round++) {
      const r = await this.send(method, p, signal, era);
      if (r?.resultType !== "input_required") return r;
      const responses: Record<string, unknown> = {};
      for (const [key, ir] of Object.entries<any>(r.inputRequests ?? {})) {
        if (ir?.method === "elicitation/create" && this.hooks.elicit) responses[key] = await this.hooks.elicit(ir.params ?? {});
        else if (ir?.method === "roots/list") responses[key] = { roots: [] };
        else throw new McpError(`The server needs "${ir?.method}", which LUCID does not provide`);
      }
      p = { ...params, inputResponses: responses, ...(r.requestState !== undefined ? { requestState: r.requestState } : {}) };
    }
    throw new McpError("Too many input rounds");
  }

  async notify(method: string, params: Record<string, any>, signal?: AbortSignal) {
    await this.post({ jsonrpc: "2.0", method, params }, signal, this.era ?? "legacy", method);
  }

  private meta(): Record<string, unknown> {
    return { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": CLIENT_INFO, "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } } };
  }

  private async send(method: string, params: Record<string, any>, signal: AbortSignal | undefined, era: string): Promise<any> {
    const id = `l${++reqSeq}`;
    const body = era === "modern" ? { jsonrpc: "2.0", id, method, params: { ...params, _meta: { ...(params._meta ?? {}), ...this.meta() } } } : { jsonrpc: "2.0", id, method, params };
    const msg = await this.post(body, signal, era, method);
    if (!msg) throw new McpError(`No response to ${method}`);
    if (msg.error) throw new McpError(String(msg.error.message ?? "error"), msg.error.code, msg.status, msg.error.data);
    return msg.result;
  }

  private async headers(era: string, body: any): Promise<Record<string, string>> {
    const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(await this.hooks.headers()) };
    if (era === "modern") {
      h["MCP-Protocol-Version"] = MODERN;
      h["Mcp-Method"] = body.method;
      const name = body.method === "tools/call" || body.method === "prompts/get" ? body.params?.name : body.method === "resources/read" ? body.params?.uri : undefined;
      if (name !== undefined) h["Mcp-Name"] = encodeHeaderValue(String(name));
      if (body.method === "tools/call") {
        const t = this.tools.find((x) => x.name === body.params?.name);
        for (const hp of t?.headerParams ?? []) {
          let v: any = body.params?.arguments;
          for (const k of hp.path) v = v?.[k];
          if (v === undefined || v === null) continue;
          h[`Mcp-Param-${hp.header}`] = encodeHeaderValue(typeof v === "boolean" ? String(v) : String(v));
        }
      }
    } else {
      if (this.version !== "2025-03-26" && this.version !== "2024-11-05" && body.method !== "initialize") h["MCP-Protocol-Version"] = this.version;
      if (this.session) h["Mcp-Session-Id"] = this.session;
    }
    return h;
  }

  /** POST one message; returns the JSON-RPC response for requests (null for notifications). */
  private async post(body: any, signal: AbortSignal | undefined, era: string, method: string, retried = false): Promise<any> {
    if (this.sse && era !== "modern") return this.postSse(body, signal);
    const res = await fetch(this.url, { method: "POST", headers: await this.headers(era, body), body: JSON.stringify(body), signal, credentials: "omit" });
    if (res.status === 401 && !retried && this.hooks.unauthorized && (await this.hooks.unauthorized(res.headers.get("www-authenticate"), this.url))) return this.post(body, signal, era, method, true);
    if (res.status === 404 && era === "legacy" && this.session && method !== "initialize" && !retried) { // session expired: start over
      this.session = null; this.era = null;
      await this.initialize(signal);
      return this.post(body, signal, "legacy", method, true);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid && method === "initialize") this.session = sid;
    if (res.status === 202 || (res.ok && body.id === undefined)) { try { await res.body?.cancel(); } catch { /* none */ } return null; }
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      let msg: any = null;
      try { const t = await res.text(); msg = t ? JSON.parse(t) : null; } catch { /* not JSON */ }
      if (msg?.error) return { ...msg, status: res.status, error: msg.error, ...(MODERN_ERRORS.has(msg.error.code) || res.status === 404 ? {} : {}) };
      throw new McpError(`HTTP ${res.status} ${res.statusText}`.trim(), undefined, res.status);
    }
    if (ct.includes("text/event-stream")) {
      for await (const ev of sseEvents(res.body!, signal)) {
        let m: any; try { m = JSON.parse(ev.data); } catch { continue; }
        const hit = await this.onMessage(m, body.id, era, signal);
        if (hit) return { ...hit, status: res.status };
      }
      throw new McpError(`The stream ended without a response to ${method}`, undefined, res.status);
    }
    const m = await res.json();
    if (Array.isArray(m)) return m.find((x) => x.id === body.id) ?? null;
    return { ...m, status: res.status };
  }

  /** A message on a response stream: the response we wait for, a notification, or a (legacy) server request. */
  private async onMessage(m: any, id: unknown, era: string, signal?: AbortSignal): Promise<any> {
    if (m && id !== undefined && m.id === id && ("result" in m || "error" in m)) return m;
    if (m?.method === "notifications/tools/list_changed") { void this.listTools().then(() => this.hooks.toolsChanged?.()).catch(() => {}); return null; }
    if (m?.method === "notifications/progress") this.hooks.progress?.(m.params ?? {});
    else if (m?.method && m.id !== undefined && era !== "modern") {
      let result: unknown, error: { code: number; message: string } | undefined;
      if (m.method === "ping") result = {};
      else if (m.method === "roots/list") result = { roots: [] };
      else if (m.method === "elicitation/create" && this.hooks.elicit) result = await this.hooks.elicit(m.params ?? {});
      else error = { code: -32601, message: `${m.method} is not supported by LUCID` };
      await this.post({ jsonrpc: "2.0", id: m.id, ...(error ? { error } : { result }) }, signal, era, "response").catch(() => { /* best effort */ });
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------- HTTP+SSE (2024-11-05)
  private async openSse(signal?: AbortSignal) {
    const abort = new AbortController();
    signal?.addEventListener("abort", () => abort.abort(), { once: true });
    const res = await fetch(this.url, { headers: { Accept: "text/event-stream", ...(await this.hooks.headers()) }, signal: abort.signal, credentials: "omit" });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) throw new McpError(`Not an MCP server (HTTP ${res.status})`, undefined, res.status);
    let gotEndpoint: () => void = () => {}, failed: (e: Error) => void = () => {};
    const ready = new Promise<void>((ok, fail) => { gotEndpoint = ok; failed = fail; });
    this.sse = { endpoint: "", abort, waiters: new Map(), ready };
    const s = this.sse;
    void (async () => {
      try {
        for await (const ev of sseEvents(res.body!, abort.signal)) {
          if (ev.event === "endpoint") { s.endpoint = new URL(ev.data.trim(), this.url).href; gotEndpoint(); continue; }
          let m: any; try { m = JSON.parse(ev.data); } catch { continue; }
          if (m.id !== undefined && ("result" in m || "error" in m)) { s.waiters.get(m.id)?.(m); s.waiters.delete(m.id); }
          else if (m.method) void this.onMessage(m, undefined, "sse");
        }
      } catch (e) { failed(e as Error); }
      for (const w of s.waiters.values()) w({ error: { code: -32603, message: "The server closed the event stream" } });
      s.waiters.clear();
    })();
    await Promise.race([ready, new Promise((_, fail) => setTimeout(() => fail(new McpError("The server sent no endpoint event")), 15000))]);
  }

  private async postSse(body: any, signal?: AbortSignal): Promise<any> {
    const s = this.sse!;
    await s.ready;
    const wait = body.id !== undefined && !("result" in body || "error" in body) ? new Promise<any>((ok) => s.waiters.set(body.id, ok)) : null;
    const res = await fetch(s.endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...(await this.hooks.headers()) }, body: JSON.stringify(body), signal, credentials: "omit" });
    if (!res.ok && res.status !== 202) { s.waiters.delete(body.id); throw new McpError(`HTTP ${res.status}`, undefined, res.status); }
    try { await res.body?.cancel(); } catch { /* none */ }
    if (!wait) return null;
    const onAbort = () => { s.waiters.get(body.id)?.({ error: { code: -32800, message: "Cancelled" } }); s.waiters.delete(body.id); void this.notify("notifications/cancelled", { requestId: body.id, reason: "cancelled" }).catch(() => {}); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try { return await wait; } finally { signal?.removeEventListener("abort", onAbort); }
  }

  // ------------------------------------------------------------------------------------------- operations
  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const all: McpToolInfo[] = [], rejected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.request("tools/list", cursor ? { cursor } : {}, signal);
      for (const t of r?.tools ?? []) {
        if (!t || typeof t.name !== "string") continue;
        const hp = headerParams(t.inputSchema);
        if (hp === null) { rejected.push(`${t.name}: invalid x-mcp-header annotation`); continue; }
        all.push({ ...t, inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} }, headerParams: hp });
      }
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    this.tools = all; this.rejected = rejected;
    return all;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: any[]; structuredContent?: unknown; isError?: boolean }> {
    try { return await this.request("tools/call", { name, arguments: args }, signal); }
    catch (e) {
      if ((e as McpError).code === -32020 && this.era === "modern") { await this.listTools(signal); return this.request("tools/call", { name, arguments: args }, signal); }
      throw e;
    }
  }
  listResources(signal?: AbortSignal) { return this.request("resources/list", {}, signal); }
  readResource(uri: string, signal?: AbortSignal) { return this.request("resources/read", { uri }, signal); }
  listPrompts(signal?: AbortSignal) { return this.request("prompts/list", {}, signal); }
  getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal) { return this.request("prompts/get", { name, arguments: args }, signal); }

  close() {
    this.sse?.abort.abort();
    this.listen?.abort();
    if (this.era === "legacy" && this.session) { void this.hooks.headers().then((h) => fetch(this.url, { method: "DELETE", headers: { ...h, "Mcp-Session-Id": this.session! } })).catch(() => {}); }
    this.era = null; this.session = null; this.sse = null;
  }
}
