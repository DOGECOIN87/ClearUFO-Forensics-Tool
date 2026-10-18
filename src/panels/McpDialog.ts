// AI panel › MCP: both directions of the Model Context Protocol.
//  1. "AI applications → LUCID": what external AI applications may do, the link to the LUCID MCP bridge,
//     WebMCP, and ready-to-paste client configurations.
//  2. "Assistant → MCP servers": MCP servers whose tools LUCID's own assistant may use.
import type { App } from "../app/App";
import { DEFAULT_BRIDGE, type ExternalPolicy } from "../mcp";
import { McpClient } from "../mcp/client";
import type { McpServerConfig } from "../mcp/servers";
import { checkBox, selectBox } from "../ui/controls";
import { confirmDialog, dialog, toast } from "../ui/dialog";
import { h, uid } from "../ui/dom";

const POLICIES: [ExternalPolicy, string][] = [["off", "Off — no external control"], ["read", "Read only — inspect, no changes"], ["ask", "Ask me before each change"], ["full", "Full control (each change is undoable)"]];

function copyBlock(label: string, text: string) {
  const pre = h("pre", { class: "mcp-snippet" }, text);
  const b = h("button", { class: "ai-link", type: "button" }, "Copy");
  b.addEventListener("click", async () => { try { await navigator.clipboard.writeText(text); toast("Copied.", "ok", 1500); } catch { const r = document.createRange(); r.selectNodeContents(pre); getSelection()?.removeAllRanges(); getSelection()?.addRange(r); } });
  return h("div", { class: "mcp-snip" }, h("div", { class: "mcp-snip-h" }, h("span", null, label), b), pre);
}

export function openMcpDialog(app: App) {
  const mcp = app.mcp;
  const row = (label: string, ...ctl: (HTMLElement | null)[]) => h("div", { class: "form-row" }, h("span", null, label), h("div", { class: "ai-set-ctl" }, ...ctl));

  // ---------------------------------------------------------------- 1. external control
  const policy = selectBox(POLICIES, mcp.settings.external, (v) => mcp.save({ external: v as ExternalPolicy }));
  const linkLine = h("div", { class: "ai-set-status small" });
  const url = h("input", { class: "inp", type: "text", spellcheck: "false", value: mcp.settings.bridge.url || DEFAULT_BRIDGE }) as HTMLInputElement;
  const code = h("input", { class: "inp mcp-code", type: "text", spellcheck: "false", autocomplete: "off", placeholder: "pairing code", value: mcp.settings.bridge.code }) as HTMLInputElement;
  const linkBtn = h("button", { class: "btn", type: "button" }, "Link");
  linkBtn.addEventListener("click", () => {
    if (mcp.settings.bridge.enabled && linkBtn.textContent === "Unlink") { mcp.save({ bridge: { enabled: false, url: mcp.settings.bridge.url, code: mcp.settings.bridge.code } }); return; }
    mcp.save({ bridge: { enabled: true, url: url.value.trim() || DEFAULT_BRIDGE, code: code.value.trim().toUpperCase() } });
  });
  const linkRow = row("Bridge:", url, code, linkBtn);
  const webmcp = checkBox("Offer the tools to the browser's built-in agent (WebMCP)", mcp.settings.webmcp, (v) => mcp.save({ webmcp: v }));
  const webLine = h("div", { class: "muted small" });
  const script = (mcp.bridgeInfo as { script?: string } | null)?.script ?? "/path/to/lucid/mcp/lucid-mcp.mjs";
  const httpUrl = `${mcp.servedByBridge ? location.origin : (mcp.settings.bridge.url || DEFAULT_BRIDGE)}/mcp`;
  const snippets = h("details", { class: "mcp-details" }, h("summary", null, "Connect an AI application (configuration to paste)"),
    h("p", { class: "muted small" }, `MCP clients start the bridge themselves (replace the path with where LUCID is). It serves LUCID at ${DEFAULT_BRIDGE}/ and opens it when a tool is first used. HTTP clients use ${httpUrl}.`),
    copyBlock("Claude Desktop · Cursor · Windsurf · Cline (mcpServers JSON)", JSON.stringify({ mcpServers: { lucid: { command: "node", args: [script] } } }, null, 2)),
    copyBlock("Claude Code", `claude mcp add lucid -- node ${script}\n# or, with the bridge already running:\nclaude mcp add --transport http lucid ${httpUrl}`),
    copyBlock("VS Code (.vscode/mcp.json)", JSON.stringify({ servers: { lucid: { type: "stdio", command: "node", args: [script] } } }, null, 2)),
    copyBlock("Gemini CLI (~/.gemini/settings.json) · Codex CLI (~/.codex/config.toml)", `{ "mcpServers": { "lucid": { "httpUrl": "${httpUrl}" } } }\n\n[mcp_servers.lucid]\ncommand = "node"\nargs = ["${script}"]`),
    copyBlock("Start the bridge by hand (web server only)", `node ${script} --http\n# then open ${DEFAULT_BRIDGE}/`));

  const refreshExt = () => {
    const st = mcp.link, base = mcp.bridgeUrl();
    linkRow.hidden = mcp.servedByBridge;
    linkBtn.textContent = mcp.settings.bridge.enabled ? "Unlink" : "Link";
    linkLine.className = `ai-set-status small ${st === "active" ? "ok" : st === "error" ? "warn" : ""}`;
    linkLine.textContent = st === "active" && mcp.settings.external === "off" ? `Linked to ${base}, but external control is off: AI applications are refused.`
      : st === "active" ? `Linked to the LUCID MCP bridge at ${base}: AI applications connected to it operate this tab.`
      : st === "standby" ? `Linked to ${base}, on standby: another LUCID tab linked more recently is the one AI applications operate.`
      : st === "connecting" ? `Connecting to the bridge at ${base}…`
      : st === "error" ? mcp.linkError || `No bridge at ${base}.`
      : mcp.servedByBridge ? "Served by the LUCID MCP bridge." : "Not linked to a bridge (MCP clients reach LUCID through the bridge; see below).";
    webLine.textContent = mcp.webmcpState === "registered" ? `WebMCP: ${app.mcp.tools().length} tools registered with this browser.` : mcp.webmcpState === "unsupported" ? "WebMCP: not available in this browser (Chrome 146+ with WebMCP enabled)." : mcp.webmcpState === "error" ? "WebMCP: the browser rejected the tools." : "WebMCP: off.";
  };

  // ---------------------------------------------------------------- 2. servers for the assistant
  const servers = mcp.servers;
  let list: McpServerConfig[] = servers.list.map((s) => ({ ...s, headers: { ...s.headers }, disabledTools: [...s.disabledTools] }));
  const listEl = h("div", { class: "mcp-list" });
  const renderList = () => {
    listEl.replaceChildren();
    if (!list.length) listEl.appendChild(h("div", { class: "muted small" }, "No MCP servers yet. Add a server URL, or servers the bridge offers (stdio servers, servers without CORS)."));
    for (const s of list) {
      const st = servers.states.get(s.id);
      const en = h("input", { type: "checkbox", class: "chk", title: "Enabled" }) as HTMLInputElement;
      en.checked = s.enabled;
      en.addEventListener("change", () => { s.enabled = en.checked; servers.save(list); });
      const edit = h("button", { class: "ai-link", type: "button" }, "Edit"), del = h("button", { class: "ai-link", type: "button" }, "Remove");
      edit.addEventListener("click", () => editServer(s));
      del.addEventListener("click", async () => { if (await confirmDialog("Remove MCP Server", `Remove “${s.name}”?`, "Remove", true)) { list = list.filter((x) => x !== s); servers.save(list); renderList(); } });
      const state = !s.enabled ? "disabled" : st?.state === "ready" ? `${st.tools} tools · ${st.server || ""} · ${st.era === "modern" ? "MCP 2026-07-28" : `MCP ${st.version}${st.era === "sse" ? " (HTTP+SSE)" : ""}`}` : st?.state === "error" || st?.state === "signin" ? st.error ?? "error" : st?.state === "connecting" ? "connecting…" : "connects when the assistant runs";
      listEl.appendChild(h("div", { class: `mcp-srv ${st?.state ?? ""}` }, en, h("div", { class: "mcp-srv-t" }, h("b", null, s.name), h("span", { class: "muted small" }, ` ${s.bridge ? "via the bridge" : s.url}`), h("div", { class: "small mcp-srv-st" }, state)), edit, del));
    }
  };
  const addBtn = h("button", { class: "btn", type: "button" }, "Add server…");
  addBtn.addEventListener("click", () => editServer(null));
  const fromBridge = h("button", { class: "btn", type: "button" }, "Add from bridge…");
  fromBridge.addEventListener("click", async () => {
    const base = mcp.bridgeUrl(), c = mcp.servedByBridge ? "" : mcp.settings.bridge.code;
    try {
      const r = await fetch(`${base}/lucid/servers${c ? `?code=${encodeURIComponent(c)}` : ""}`);
      if (!r.ok) throw new Error(r.status === 403 ? "the pairing code is missing or wrong" : `HTTP ${r.status}`);
      const j = await r.json();
      let added = 0;
      for (const b of j.servers ?? []) {
        if (list.some((x) => x.bridge && x.url === b.url)) continue;
        list.push({ id: uid("mcp"), name: b.name, url: b.url, transport: "streamable", auth: "none", headers: {}, approval: "ask", enabled: true, disabledTools: [], bridge: true });
        added++;
      }
      servers.save(list); renderList();
      toast(added ? `${added} server(s) added from the bridge.` : (j.servers ?? []).length ? "All bridge servers are already in the list." : "The bridge offers no servers: add them to ~/.lucid-mcp/servers.json (\"mcpServers\", like Claude Desktop).", added ? "ok" : "info", 6000);
    } catch (e) { toast(`Bridge at ${base}: ${(e as Error).message}. Start it with: node mcp/lucid-mcp.mjs --http`, "error", 7000); }
  });

  function editServer(orig: McpServerConfig | null) {
    const s: McpServerConfig = orig ? { ...orig, headers: { ...orig.headers }, disabledTools: [...orig.disabledTools] } : { id: uid("mcp"), name: "", url: "", transport: "auto", auth: "none", headers: {}, approval: "ask", enabled: true, disabledTools: [] };
    const name = h("input", { class: "inp", type: "text", value: s.name, placeholder: "e.g. files" }) as HTMLInputElement;
    const surl = h("input", { class: "inp", type: "text", spellcheck: "false", value: s.url, placeholder: "https://example.com/mcp", disabled: !!s.bridge }) as HTMLInputElement;
    const transport = selectBox([["auto", "Automatic (Streamable HTTP, then HTTP+SSE)"], ["streamable", "Streamable HTTP"], ["sse", "HTTP+SSE (2024-11-05, deprecated)"]], s.transport, (v) => { s.transport = v as McpServerConfig["transport"]; });
    const token = h("input", { class: "inp", type: "password", autocomplete: "off", value: servers.secret(s.id, "bearer"), placeholder: "token" }) as HTMLInputElement;
    const clientId = h("input", { class: "inp", type: "text", value: s.clientId ?? "", placeholder: "optional (else dynamic registration)" }) as HTMLInputElement;
    const tokenRow = row("Bearer token:", token), clientRow = row("OAuth client id:", clientId);
    const signIn = h("button", { class: "btn", type: "button" }, "Sign in…");
    const auth = selectBox([["none", "None"], ["bearer", "Bearer token"], ["oauth", "OAuth (sign in)"]], s.auth, (v) => { s.auth = v as McpServerConfig["auth"]; syncAuth(); });
    const syncAuth = () => { tokenRow.hidden = s.auth !== "bearer"; clientRow.hidden = s.auth !== "oauth"; signIn.hidden = s.auth !== "oauth"; };
    const headers = h("textarea", { class: "inp mcp-headers", rows: 2, spellcheck: "false", placeholder: "X-Api-Key: value (one header per line)" }, Object.entries(s.headers).map(([k, v]) => `${k}: ${v}`).join("\n")) as HTMLTextAreaElement;
    const approval = selectBox([["ask", "Ask me before each call"], ["auto", "Run calls directly (trusted server)"]], s.approval, (v) => { s.approval = v as McpServerConfig["approval"]; });
    const status = h("div", { class: "ai-set-status small" });
    const toolsEl = h("div", { class: "mcp-tools" });
    const collect = () => {
      s.name = name.value.trim() || (() => { try { return new URL(surl.value).hostname; } catch { return "server"; } })();
      if (!s.bridge) s.url = surl.value.trim();
      s.clientId = clientId.value.trim() || undefined;
      s.headers = {};
      for (const line of headers.value.split("\n")) { const m = /^\s*([^:\s]+)\s*:\s*(.*)$/.exec(line); if (m) s.headers[m[1]] = m[2].trim(); }
    };
    const test = h("button", { class: "btn", type: "button" }, "Test connection");
    test.addEventListener("click", async () => {
      collect();
      if (!s.url) { status.textContent = "Enter the server URL."; status.className = "ai-set-status small warn"; return; }
      if (s.auth === "bearer") servers.setSecret(s.id, "bearer", token.value.trim());
      status.textContent = "Connecting…"; status.className = "ai-set-status small";
      const tmp = new McpServersProbe(servers, s);
      try {
        const c = await tmp.run();
        status.textContent = `Connected: ${[c.serverInfo.title ?? c.serverInfo.name, c.serverInfo.version].filter(Boolean).join(" ") || "server"} · ${c.era === "modern" ? "MCP 2026-07-28" : `MCP ${c.version}${c.era === "sse" ? " over HTTP+SSE" : ""}`} · ${c.tools.length} tools${c.rejected.length ? ` (${c.rejected.length} rejected: invalid header annotations)` : ""}.`;
        status.className = "ai-set-status small ok";
        toolsEl.replaceChildren(...c.tools.map((t) => {
          const cb = checkBox(`${t.name}${t.annotations?.readOnlyHint ? " (read-only)" : ""} — ${(t.description ?? "").slice(0, 110)}`, !s.disabledTools.includes(t.name), (v) => { s.disabledTools = v ? s.disabledTools.filter((x) => x !== t.name) : [...s.disabledTools, t.name]; });
          return cb.el;
        }));
      } catch (e) { status.textContent = (e as Error).message; status.className = "ai-set-status small warn"; }
    });
    signIn.addEventListener("click", async () => {
      collect();
      status.textContent = "Signing in (a window opens)…"; status.className = "ai-set-status small";
      try { await servers.signIn(s); status.textContent = "Signed in. Test the connection."; status.className = "ai-set-status small ok"; }
      catch (e) { status.textContent = (e as Error).message; status.className = "ai-set-status small warn"; }
    });
    const body = h("div", { class: "form ai-settings" },
      row("Name:", name), row("URL:", surl), row("Transport:", transport), row("Authorization:", auth, signIn), tokenRow, clientRow,
      row("Headers:", headers), row("Calls:", approval),
      h("div", { class: "ai-set-test" }, test, status), toolsEl,
      h("div", { class: "muted small" }, "The server must allow requests from this page (CORS). Servers that do not, and local stdio servers, go through the LUCID MCP bridge (Add from bridge). Results of MCP tools are treated as untrusted third-party data."));
    syncAuth();
    dialog({
      title: orig ? `MCP Server: ${orig.name}` : "Add MCP Server", body, width: 620,
      buttons: [{ label: "Cancel" }, { label: "Save", primary: true, action: () => {
        collect();
        if (!s.url) { status.textContent = "Enter the server URL."; status.className = "ai-set-status small warn"; return false; }
        if (s.auth === "bearer") servers.setSecret(s.id, "bearer", token.value.trim());
        list = orig ? list.map((x) => (x === orig ? s : x)) : [...list, s];
        servers.save(list); renderList();
      } }],
    });
  }

  const body = h("div", { class: "form ai-settings mcp-dialog" },
    h("div", { class: "form-sep" }, "AI applications → LUCID (LUCID as an MCP server)"),
    h("div", { class: "muted small" }, "Claude Desktop, Claude Code, Cursor, VS Code, Gemini CLI and other MCP clients operate LUCID with the same tools as the built-in assistant. Their actions appear in the AI panel and the audit log."),
    row("Allow:", policy), linkLine, linkRow, webmcp.el, webLine, snippets,
    h("div", { class: "form-sep" }, "Assistant → MCP servers (LUCID as an MCP client)"),
    h("div", { class: "muted small" }, "Tools of these servers are offered to LUCID's assistant (Agent mode; read-only tools in Ask mode)."),
    listEl, h("div", { class: "ai-set-test" }, addBtn, fromBridge));
  const off = mcp.on("change", () => { refreshExt(); renderList(); });
  refreshExt(); renderList();
  dialog({ title: "MCP — Model Context Protocol", body, width: 680, buttons: [{ label: "Close", primary: true }], onClose: () => off?.() });
}

/** A one-off connection with unsaved settings (Test connection). */
class McpServersProbe {
  constructor(private servers: import("../mcp/servers").McpServers, private s: McpServerConfig) {}
  async run(): Promise<McpClient> {
    const s = this.s, servers = this.servers;
    const url = s.bridge && servers.bridge ? new URL(s.url, servers.bridge.url).href : s.url;
    const c = new McpClient(url, s.transport, {
      headers: async () => {
        const hd: Record<string, string> = { ...s.headers };
        if (s.bridge && servers.bridge?.code) hd["X-Lucid-Link"] = servers.bridge.code;
        if (s.auth === "bearer") { const t = servers.secret(s.id, "bearer"); if (t) hd.Authorization = `Bearer ${t}`; }
        if (s.auth === "oauth") { try { const t = JSON.parse(servers.secret(s.id, "oauth") || "null"); if (t) hd.Authorization = `Bearer ${t.access_token}`; } catch { /* none */ } }
        return hd;
      },
    });
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 15000);
    try { await c.connect(ac.signal); await c.listTools(ac.signal); return c; }
    catch (e) { throw (e as Error).name === "AbortError" ? new Error("No answer within 15 s") : (e as { status?: number }).status === 401 ? new Error(s.auth === "oauth" ? "Sign-in required: click Sign in." : "HTTP 401: the server requires authorization") : e; }
    finally { clearTimeout(t); c.close(); }
  }
}
