// MCP in LUCID, both directions:
//  - servers: MCP servers LUCID's assistant uses (LUCID as an MCP client)        → servers.ts, client.ts
//  - external control: AI applications operate LUCID (LUCID as an MCP server) through
//      the local bridge (mcp/lucid-mcp.mjs: stdio + Streamable HTTP)            → BridgeLink below
//      WebMCP (document.modelContext / navigator.modelContext) for browser agents
//      window.lucid.mcp, for browser-automation agents (Playwright MCP, Chrome DevTools MCP)
// Every external call goes through McpHost: the examiner's policy (off / read-only / ask before changes /
// full control), a one-time connection approval per application, frame consent, and the audit log.
import type { AppCtx } from "../app/context";
import { TOOL_BY_NAME } from "../ai/tools";
import { FILTERS } from "../shared/filters";
import { Emitter } from "../ui/dom";
import { MCP_HELP, MCP_PROMPTS, MCP_RESOURCES, mcpTools, toCallToolResult, type CallToolResult } from "./catalog";
import { McpServers } from "./servers";

export type ExternalPolicy = "off" | "read" | "ask" | "full";
export interface McpSettings {
  /** What AI applications may do: nothing, read, change with approval, change freely. */
  external: ExternalPolicy;
  /** Link this tab to the LUCID MCP bridge (automatic when the bridge serves the page). */
  bridge: { enabled: boolean; url: string; code: string };
  /** Offer the tools to the browser's own agent (WebMCP) when the browser supports it. */
  webmcp: boolean;
}
const KEY = "lucid.mcp.settings";
export const DEFAULT_BRIDGE = "http://127.0.0.1:47800";
const DEFAULTS: McpSettings = { external: "ask", bridge: { enabled: false, url: DEFAULT_BRIDGE, code: "" }, webmcp: true };

export type LinkState = "off" | "connecting" | "active" | "standby" | "error";

export class Mcp extends Emitter<{ change: [] }> {
  settings: McpSettings;
  readonly servers = new McpServers();
  link: LinkState = "off";
  linkError = "";
  bridgeInfo: { version?: string; mcp?: string; servers?: number; script?: string } | null = null;
  /** Same origin as a bridge (the bridge serves this page). */
  servedByBridge = false;
  webmcpState: "unsupported" | "registered" | "off" | "error" = "unsupported";
  private grants = new Map<string, "allow" | "read" | "deny">();
  private es: EventSource | null = null;
  private linkId = "";
  private calls = new Map<string, AbortController>();
  private webmcpAbort: AbortController | null = null;

  constructor(private ctx: AppCtx) {
    super();
    this.settings = load();
    this.servers.on("change", () => this.emit("change"));
  }

  /** After the app is up: link to the bridge if it serves this page (or is configured), register WebMCP. */
  async start() {
    // The bridge serves LUCID over plain HTTP only (mcp/lucid-mcp.mjs), so only an http: page can be one it serves.
    // Probing from https: hosts (e.g. GitHub Pages) would only cost a request, and a 404 in the console, on every load.
    if (location.protocol === "http:") {
      try {
        const r = await fetch(new URL("lucid/info", location.href), { cache: "no-store" });
        const j = r.ok && (r.headers.get("content-type") ?? "").includes("json") ? await r.json() : null;
        if (j?.bridge === "lucid-mcp") { this.servedByBridge = true; this.bridgeInfo = j; }
      } catch { /* not served by the bridge */ }
    }
    this.syncBridgeServers();
    if (this.servedByBridge || this.settings.bridge.enabled) this.connectBridge();
    this.registerWebMcp();
  }

  save(patch: Partial<McpSettings>) {
    this.settings = { ...this.settings, ...patch, bridge: { ...this.settings.bridge, ...(patch.bridge ?? {}) } };
    try { localStorage.setItem(KEY, JSON.stringify(this.settings)); } catch { /* storage unavailable */ }
    if (patch.external) this.grants.clear(); // the policy applies per call: the link stays, so clients get a clear refusal
    if (patch.bridge) { this.disconnectBridge(); if (this.servedByBridge || this.settings.bridge.enabled) this.connectBridge(); }
    this.syncBridgeServers();
    this.registerWebMcp();
    this.emit("change");
  }

  bridgeUrl(): string { return this.servedByBridge ? location.origin : (this.settings.bridge.url || DEFAULT_BRIDGE).replace(/\/+$/, ""); }
  private syncBridgeServers() { this.servers.bridge = this.servedByBridge || this.settings.bridge.enabled ? { url: this.bridgeUrl(), code: this.servedByBridge ? "" : this.settings.bridge.code } : null; }

  // -------------------------------------------------------------------------------------------- the bridge
  connectBridge() {
    if (this.es) return;
    const base = this.bridgeUrl(), code = this.servedByBridge ? "" : this.settings.bridge.code.trim().toUpperCase();
    this.setLink("connecting");
    let es: EventSource;
    try { es = new EventSource(`${base}/lucid/link${code ? `?code=${encodeURIComponent(code)}` : ""}`); }
    catch (e) { this.linkError = (e as Error).message; this.setLink("error"); return; }
    this.es = es;
    let opened = false;
    es.onopen = () => { opened = true; };
    es.onerror = () => {
      if (!opened) { this.linkError = this.servedByBridge ? "The bridge stopped." : `No LUCID MCP bridge at ${base}${code ? "" : " (or a pairing code is needed)"}. Start it with: node mcp/lucid-mcp.mjs --http`; }
      this.setLink(es.readyState === EventSource.CLOSED ? "error" : "connecting");
      if (es.readyState === EventSource.CLOSED) { this.es = null; setTimeout(() => { if (!this.es && (this.servedByBridge || this.settings.bridge.enabled)) this.connectBridge(); }, 5000); }
    };
    es.onmessage = (ev) => { let m: any; try { m = JSON.parse(ev.data); } catch { return; } void this.onBridge(m); };
  }
  disconnectBridge() {
    this.es?.close(); this.es = null; this.linkId = "";
    for (const c of this.calls.values()) c.abort();
    this.calls.clear();
    this.setLink("off");
  }
  private setLink(s: LinkState) { if (this.link !== s) { this.link = s; this.emit("change"); } }

  private async post(path: string, body: unknown) {
    const code = this.servedByBridge ? "" : this.settings.bridge.code.trim().toUpperCase();
    await fetch(`${this.bridgeUrl()}${path}${code ? `?code=${encodeURIComponent(code)}` : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
  }

  private async onBridge(m: any) {
    switch (m.type) {
      case "hello":
        this.linkId = m.link; this.linkError = "";
        await this.post("/lucid/catalog", { link: this.linkId, tools: mcpTools(), app: { name: "LUCID" } });
        break;
      case "active": this.setLink("active"); break;
      case "standby": this.setLink("standby"); break;
      case "cancel": this.calls.get(m.id)?.abort(); break;
      case "tool": case "resource": {
        const ac = new AbortController();
        this.calls.set(m.id, ac);
        try {
          const result = m.type === "tool" ? await this.callTool({ name: m.client || "MCP client", transport: `the LUCID MCP bridge (${m.transport ?? "MCP"})` }, m.name, m.args ?? {}, ac.signal) : await this.readResource({ name: m.client || "MCP client", transport: "the LUCID MCP bridge" }, m.uri, ac.signal);
          await this.post("/lucid/reply", { link: this.linkId, id: m.id, result });
        } catch (e) { await this.post("/lucid/reply", { link: this.linkId, id: m.id, error: (e as Error).message }); }
        finally { this.calls.delete(m.id); }
        break;
      }
    }
  }

  // -------------------------------------------------------------------------------------------- policy + execution
  private async grant(client: { name: string; transport: string }, signal?: AbortSignal): Promise<"allow" | "read" | "deny"> {
    const key = `${client.transport}|${client.name}`;
    let g = this.grants.get(key);
    if (!g) {
      this.ctx.focusAi();
      g = await this.agent().askConnect(client.name, client.transport, signal);
      if (!signal?.aborted) this.grants.set(key, g);
    }
    return g;
  }
  private agent() { return (this.ctx as unknown as { agent: import("../ai/agent").Agent }).agent; }

  /** A tool call from an external AI application. */
  async callTool(client: { name: string; transport: string }, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    const fail = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });
    const def = TOOL_BY_NAME.get(name);
    if (!def) return fail(`Unknown tool: ${name}`);
    const policy = this.settings.external;
    if (policy === "off") return fail("The examiner has turned external AI control off in LUCID (AI panel › MCP).");
    const g = await this.grant(client, signal);
    if (g === "deny") return fail("The examiner did not allow this application to use LUCID.");
    const readOnly = policy === "read" || g === "read";
    if (readOnly && !(def.kind === "read" || def.kind === "nav")) return fail(`Read-only access: “${name}” would change the project or needs the examiner. Describe the change instead.`);
    const r = await this.agent().runExternal(client.name, client.transport, name, args, policy === "ask" && def.kind === "write", signal);
    return toCallToolResult(r);
  }

  /** Resource reads from external applications (project, audit log, filters). */
  async readResource(client: { name: string; transport: string }, uri: string, signal?: AbortSignal): Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
    if (this.settings.external === "off") throw new Error("External AI control is off in LUCID.");
    if ((await this.grant(client, signal)) === "deny") throw new Error("The examiner did not allow this application to use LUCID.");
    const s = this.ctx.store, text = (v: unknown, mime = "application/json") => ({ contents: [{ uri, mimeType: mime, text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });
    if (uri === "lucid://project") {
      const p = s.project;
      return text({ name: p.name, case: (p as any).caseInfo ?? (p as any).case, chains: p.chains.map((c) => ({ id: c.id, name: c.name, filters: c.filters.map((f) => ({ id: f.id, type: f.type, name: FILTERS[f.type]?.name ?? f.type, enabled: f.enabled, params: f.params })) })), sources: Object.fromEntries(Object.entries(p.sources ?? {}).map(([id, src]) => [id, { name: (src as any).name, size: (src as any).size, md5: (src as any).md5, sha256: (src as any).sha256 }])), active_chain: s.ui.chainId });
    }
    if (uri === "lucid://audit-log") return text(s.project.aiLog ?? []);
    if (uri === "lucid://filters") return text(Object.values(FILTERS).map((f) => ({ id: f.id, name: f.name, category: f.category, kind: f.kind, description: f.description })));
    if (uri === "lucid://help") return text(MCP_HELP, "text/markdown");
    throw new Error(`Unknown resource ${uri}`);
  }

  // -------------------------------------------------------------------------------------------- WebMCP
  registerWebMcp() {
    this.webmcpAbort?.abort();
    this.webmcpAbort = null;
    const mc: any = (document as any).modelContext ?? (navigator as any).modelContext;
    if (!mc || typeof mc.registerTool !== "function") { this.webmcpState = "unsupported"; return; }
    if (!this.settings.webmcp || this.settings.external === "off") {
      if (typeof mc.unregisterTool === "function") for (const t of mcpTools()) { try { mc.unregisterTool(t.name); } catch { /* not registered */ } }
      this.webmcpState = "off"; return;
    }
    const ac = new AbortController();
    this.webmcpAbort = ac;
    let failed = 0;
    for (const t of mcpTools()) {
      const tool = {
        name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.annotations.readOnlyHint },
        execute: async (input: Record<string, unknown>, agent?: { name?: string }) => this.callTool({ name: agent?.name ? `${agent.name} (WebMCP)` : "Browser agent (WebMCP)", transport: "WebMCP (the browser's agent)" }, t.name, input ?? {}, new AbortController().signal),
      };
      try {
        if (typeof mc.unregisterTool === "function") { try { mc.unregisterTool(t.name); } catch { /* new */ } }
        const r = mc.registerTool(tool, { signal: ac.signal });
        if (r && typeof r.then === "function") r.catch(() => { failed++; });
      } catch { failed++; }
    }
    this.webmcpState = failed === mcpTools().length ? "error" : "registered";
  }

  // -------------------------------------------------------------------------------------------- page API
  // window.lucid.mcp.tools() / .call(name, args) / .read(uri): the same tools for agents that drive the page
  // (Playwright MCP, Chrome DevTools MCP), under the same policy, approvals and audit log.
  tools() { return mcpTools(); }
  resources() { return MCP_RESOURCES; }
  prompts() { return MCP_PROMPTS.map(({ template, ...p }) => p); }
  call(name: string, args: Record<string, unknown> = {}, client = "Page automation"): Promise<CallToolResult> {
    return this.callTool({ name: client, transport: "the page API (window.lucid.mcp)" }, name, args, new AbortController().signal);
  }
  read(uri: string, client = "Page automation") { return this.readResource({ name: client, transport: "the page API (window.lucid.mcp)" }, uri); }
}

function load(): McpSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...DEFAULTS, ...s, bridge: { ...DEFAULTS.bridge, ...(s.bridge ?? {}) } };
  } catch { return { ...DEFAULTS, bridge: { ...DEFAULTS.bridge } }; }
}
