// MCP servers used by LUCID's assistant (LUCID as an MCP client). Configured in AI panel › MCP; their tools
// are offered to the model next to LUCID's own as "mcp__<server>__<tool>". Calls need the examiner's approval
// unless the server is trusted, results are marked as untrusted third-party content, and every call is
// recorded in the audit log.
import type { ToolResult } from "../ai/tools";
import type { ToolSpec } from "../ai/types";
import { Emitter } from "../ui/dom";
import { McpClient, type ElicitRequest, type ElicitResult, type McpToolInfo } from "./client";
import { authorize, refresh, type TokenSet } from "./oauth";

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  transport: "auto" | "streamable" | "sse";
  auth: "none" | "bearer" | "oauth";
  /** Extra request headers ("Name: value" pairs). */
  headers: Record<string, string>;
  /** OAuth client id when the server does not support dynamic registration. */
  clientId?: string;
  /** ask: the examiner approves each call; auto: calls run directly. */
  approval: "ask" | "auto";
  enabled: boolean;
  disabledTools: string[];
  /** Offered by the LUCID MCP bridge (sends the pairing code). */
  bridge?: boolean;
}
export type ServerState = { state: "off" | "connecting" | "ready" | "error" | "signin"; error?: string; tools?: number; era?: string; version?: string; server?: string };

const KEY = "lucid.mcp.servers";
const secretKey = (id: string, kind: "bearer" | "oauth") => `lucid.mcp.${kind}.${id}`;
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20) || "server";

export class McpServers extends Emitter<{ change: [] }> {
  list: McpServerConfig[] = [];
  states = new Map<string, ServerState>();
  private clients = new Map<string, McpClient>();
  private byName = new Map<string, { server: McpServerConfig; tool: McpToolInfo }>();
  /** The pairing code and address of the bridge (for servers it hosts). */
  bridge: { url: string; code: string } | null = null;
  /** Asks the examiner (elicitation); set by the agent. */
  elicit: ((server: string, req: ElicitRequest) => Promise<ElicitResult>) | null = null;
  remember = false;

  constructor() { super(); this.load(); }

  load() {
    try { this.list = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { this.list = []; }
    if (!Array.isArray(this.list)) this.list = [];
  }
  save(list: McpServerConfig[]) {
    for (const s of this.list) if (!list.some((x) => x.id === s.id)) this.drop(s.id, true);
    for (const s of list) { const old = this.list.find((x) => x.id === s.id); if (old && JSON.stringify(old) !== JSON.stringify(s)) this.drop(s.id, false); }
    this.list = list;
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
    this.emit("change");
  }
  private drop(id: string, forget: boolean) {
    this.clients.get(id)?.close();
    this.clients.delete(id);
    this.states.delete(id);
    if (forget) for (const k of ["bearer", "oauth"] as const) this.setSecret(id, k, "");
  }

  secret(id: string, kind: "bearer" | "oauth"): string {
    try { return localStorage.getItem(secretKey(id, kind)) ?? sessionStorage.getItem(secretKey(id, kind)) ?? ""; } catch { return ""; }
  }
  setSecret(id: string, kind: "bearer" | "oauth", v: string) {
    try {
      localStorage.removeItem(secretKey(id, kind)); sessionStorage.removeItem(secretKey(id, kind));
      if (v) (this.remember ? localStorage : sessionStorage).setItem(secretKey(id, kind), v);
    } catch { /* unavailable */ }
  }

  private setState(id: string, s: ServerState) { this.states.set(id, s); this.emit("change"); }

  private client(s: McpServerConfig): McpClient {
    let c = this.clients.get(s.id);
    if (c) return c;
    const url = s.bridge && this.bridge ? new URL(s.url, this.bridge.url).href : s.url;
    c = new McpClient(url, s.transport, {
      headers: async () => {
        const h: Record<string, string> = { ...s.headers };
        if (s.bridge && this.bridge?.code) h["X-Lucid-Link"] = this.bridge.code;
        if (s.auth === "bearer") { const t = this.secret(s.id, "bearer"); if (t) h.Authorization = `Bearer ${t}`; }
        if (s.auth === "oauth") {
          let t: TokenSet | null = null;
          try { t = JSON.parse(this.secret(s.id, "oauth") || "null"); } catch { /* none */ }
          if (t?.expires_at && t.expires_at < Date.now() + 30000) { try { t = await refresh(t); this.setSecret(s.id, "oauth", JSON.stringify(t)); } catch { t = null; } }
          if (t) h.Authorization = `Bearer ${t.access_token}`;
        }
        return h;
      },
      unauthorized: async (wwwAuth) => {
        if (s.auth !== "oauth") return false;
        let t: TokenSet | null = null;
        try { t = JSON.parse(this.secret(s.id, "oauth") || "null"); } catch { /* none */ }
        if (t?.refresh_token) { try { this.setSecret(s.id, "oauth", JSON.stringify(await refresh(t))); return true; } catch { /* sign in again */ } }
        this.pendingAuth.set(s.id, wwwAuth);
        return false;
      },
      elicit: (req) => (this.elicit ? this.elicit(s.name, req) : Promise.resolve({ action: "decline" as const })),
      toolsChanged: () => { const st = this.states.get(s.id); if (st) st.tools = c!.tools.length; this.index(); this.emit("change"); },
    });
    this.clients.set(s.id, c);
    return c;
  }
  private pendingAuth = new Map<string, string | null>();

  /** Interactive OAuth sign-in for a server (from a click). */
  async signIn(s: McpServerConfig): Promise<void> {
    const url = s.bridge && this.bridge ? new URL(s.url, this.bridge.url).href : s.url;
    let www = this.pendingAuth.get(s.id) ?? null;
    if (www === null) { try { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}", credentials: "omit" }); www = r.headers.get("www-authenticate"); } catch { /* discover from the URL */ } }
    const t = await authorize(url, www, s.clientId);
    this.setSecret(s.id, "oauth", JSON.stringify(t));
    this.pendingAuth.delete(s.id);
    this.drop(s.id, false);
  }

  /** Connect (if needed) and list the tools of one server. */
  async connect(s: McpServerConfig, signal?: AbortSignal): Promise<McpClient> {
    const c = this.client(s);
    if (c.era && this.states.get(s.id)?.state === "ready") return c;
    this.setState(s.id, { state: "connecting" });
    try {
      await c.connect(signal);
      await c.listTools(signal);
      this.setState(s.id, { state: "ready", tools: c.tools.length, era: c.era ?? "", version: c.version, server: [c.serverInfo.title ?? c.serverInfo.name, c.serverInfo.version].filter(Boolean).join(" ") });
      return c;
    } catch (e) {
      const status = (e as { status?: number }).status;
      this.clients.delete(s.id);
      this.setState(s.id, status === 401 && s.auth === "oauth" ? { state: "signin", error: "Sign-in required (MCP settings › Sign in)" } : { state: "error", error: (e as Error).message });
      throw e;
    }
  }

  /** Connect every enabled server (in parallel, bounded); returns the problems to report. */
  async ensure(signal?: AbortSignal): Promise<string[]> {
    const problems: string[] = [];
    await Promise.all(this.list.filter((s) => s.enabled).map(async (s) => {
      if (this.states.get(s.id)?.state === "ready" && this.clients.get(s.id)?.era) return;
      const t = new AbortController(), timer = setTimeout(() => t.abort(), 15000);
      signal?.addEventListener("abort", () => t.abort(), { once: true });
      try { await this.connect(s, t.signal); } catch (e) { problems.push(`MCP server “${s.name}”: ${this.states.get(s.id)?.error ?? (e as Error).message}`); }
      finally { clearTimeout(timer); }
    }));
    this.index();
    return problems;
  }

  private index() {
    this.byName.clear();
    for (const s of this.list) {
      const c = this.clients.get(s.id);
      if (!s.enabled || !c?.era) continue;
      for (const t of c.tools) {
        if (s.disabledTools.includes(t.name)) continue;
        let n = `mcp__${slug(s.name)}__${t.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        if (n.length > 64) n = `${n.slice(0, 57)}_${(hash(n) >>> 0).toString(36).slice(0, 6)}`;
        while (this.byName.has(n)) n = `${n.slice(0, 62)}_${this.byName.size % 10}`;
        this.byName.set(n, { server: s, tool: t });
      }
    }
  }

  has(name: string) { return this.byName.has(name); }
  info(name: string) { return this.byName.get(name) ?? null; }

  /** Tool specifications for the model (read-only tools only in Ask mode). */
  specs(readOnly: boolean, adapt: (schema: any) => any): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const [name, { server, tool }] of this.byName) {
      if (readOnly && !tool.annotations?.readOnlyHint) continue;
      out.push({ name, description: `[MCP server “${server.name}”, third-party] ${tool.description ?? tool.title ?? tool.name}`.slice(0, 1024), parameters: adapt(sanitizeSchema(tool.inputSchema)) });
    }
    return out;
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const hit = this.byName.get(name);
    if (!hit) return { ok: false, error: `Unknown MCP tool ${name}` };
    const c = await this.connect(hit.server, signal);
    const r = await c.callTool(hit.tool.name, args, signal);
    const texts: string[] = [];
    let image: ToolResult["image"];
    for (const part of r?.content ?? []) {
      if (part?.type === "text") texts.push(String(part.text ?? ""));
      else if (part?.type === "image" && !image && typeof part.data === "string") image = { mime: part.mimeType ?? "image/png", data: part.data };
      else if (part?.type === "resource") texts.push(String(part.resource?.text ?? `[resource ${part.resource?.uri ?? ""}]`));
      else if (part?.type === "resource_link") texts.push(`[link ${part.uri ?? ""}${part.name ? ` “${part.name}”` : ""}]`);
      else if (part?.type === "audio") texts.push("[audio content omitted]");
    }
    const data = { server: hit.server.name, tool: hit.tool.name, untrusted_third_party_content: r?.structuredContent ?? texts.join("\n") };
    return r?.isError ? { ok: false, error: texts.join("\n").slice(0, 2000) || "The MCP tool reported an error", data: { server: hit.server.name, tool: hit.tool.name } } : { ok: true, data, ...(image ? { image } : {}) };
  }

  close() { for (const c of this.clients.values()) c.close(); this.clients.clear(); this.states.clear(); this.byName.clear(); }
}

function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h; }

/** Keep schemas acceptable to every provider: an object at the top, no $schema, bounded size. */
export function sanitizeSchema(s: any): any {
  const out = s && typeof s === "object" && !Array.isArray(s) ? { ...s } : {};
  delete out.$schema;
  if (out.type !== "object") return { type: "object", properties: {} };
  if (!out.properties || typeof out.properties !== "object") out.properties = {};
  return JSON.stringify(out).length > 20000 ? { type: "object", properties: {}, description: "(schema too large: pass the arguments the tool description asks for)" } : out;
}
