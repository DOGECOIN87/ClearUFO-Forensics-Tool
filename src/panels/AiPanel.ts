// AI Assistant panel: the chat of an IDE agent, docked in the workspace. Streaming answers, one card per
// action (what it did, and the details), approvals, questions and Save/Open buttons from the assistant,
// checkpoints per request, mode (Agent / Ask) and auto-apply, provider settings.
import type { Agent, Item } from "../ai/agent";
import { renderMarkdown } from "../ai/markdown";
import { chat, isLocalUrl, listModels, PROVIDERS, providerInfo } from "../ai/providers";
import { forgetKeys, getKey, setKey, type AiSettings } from "../ai/settings";
import type { ImagePart, ProviderId } from "../ai/types";
import type { AppCtx } from "../app/context";
import { FILTERS } from "../shared/filters";
import { checkBox, selectBox, spinBox } from "../ui/controls";
import { confirmDialog, dialog, toast } from "../ui/dialog";
import { h, svg } from "../ui/dom";
import { I } from "../ui/icons";
import type { App } from "../app/App";
import { openMcpDialog } from "./McpDialog";
import { isTouchUi } from "../ui/touch";

const TOOL_LABEL: Record<string, string> = {
  get_state: "Read state", list_filters: "Filters", get_filter_schema: "Filter parameters", get_source_info: "File info", get_frame_stats: "Measure",
  view_frame: "Look at frame", list_commands: "Commands", select: "Select", go_to_frame: "Go to frame", playback: "Playback", set_view: "View",
  set_selection: "Selection", add_filter: "Add filter", set_filter_params: "Set parameters", remove_filter: "Remove filter", move_filter: "Move filter",
  set_filter_enabled: "Enable/disable", reset_filter: "Reset filter", duplicate_chain: "Duplicate chain", rename_chain: "Rename chain",
  delete_chain: "Delete chain", set_in_out: "In/Out", add_bookmark: "Bookmark", set_case_info: "Case info", undo: "Undo", redo: "Redo",
  load_sample_case: "Sample case", run_command: "Command", open_media: "Open file", export: "Export", ask_user: "Question",
};

/** Provider names for the narrow panel header. */
const SHORT: Record<ProviderId, string> = { openai: "OpenAI", anthropic: "Claude", gemini: "Gemini", openrouter: "OpenRouter", ollama: "Ollama", lmstudio: "LM Studio", custom: "Custom" };

export class AiPanel {
  el: HTMLElement;
  private log: HTMLElement;
  private empty: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private modelBtn: HTMLButtonElement;
  private modeSel: HTMLSelectElement;
  private autoCb: ReturnType<typeof checkBox>;
  private ctxLine: HTMLElement;
  private attachBtn: HTMLButtonElement;
  private els = new Map<string, HTMLElement>();
  private queued = new Map<string, Item>();
  private raf = 0;
  private attach = false;
  private sent: string[] = [];
  private hpos = -1;
  private offs: (() => void)[] = [];
  private mcpBtn!: HTMLButtonElement;

  constructor(private ctx: AppCtx, private agent: Agent) {
    this.modelBtn = h("button", { class: "ai-model", type: "button", title: "AI Settings: provider, model, privacy" }) as HTMLButtonElement;
    this.modelBtn.addEventListener("click", () => this.settings());
    this.modeSel = selectBox([["agent", "Agent"], ["ask", "Ask"]], agent.settings.mode, (v) => agent.saveSettings({ mode: v as "agent" | "ask" }), "sel ai-mode");
    this.modeSel.title = "Agent: the assistant operates the workbench. Ask: read-only, it explains and advises.";
    this.autoCb = checkBox("Auto", agent.settings.approval === "auto", (v) => agent.saveSettings({ approval: v ? "auto" : "ask" }));
    this.autoCb.el.classList.add("ai-auto");
    this.autoCb.el.title = "Apply the assistant's changes directly (each is undoable). Off: approve every change.";
    const newBtn = h("button", { class: "ibtn ai-ib", type: "button", title: "New chat", "aria-label": "New chat" }, svg(I.plus));
    newBtn.addEventListener("click", () => { this.agent.newChat(); this.input.focus(); });
    const gear = h("button", { class: "ibtn ai-ib", type: "button", title: "AI Settings", "aria-label": "AI Settings" }, svg(I.settings));
    gear.addEventListener("click", () => this.settings());
    this.mcpBtn = h("button", { class: "ibtn ai-ib ai-mcp", type: "button", title: "MCP: AI applications operating LUCID, MCP servers for the assistant", "aria-label": "MCP" }, "MCP") as HTMLButtonElement;
    this.mcpBtn.addEventListener("click", () => openMcpDialog(ctx as unknown as App));
    const head = h("div", { class: "ai-head" }, this.modelBtn, this.modeSel, this.autoCb.el, newBtn, this.mcpBtn, gear);
    const mcp = ctx.mcp;
    if (mcp) { const upd = () => { this.mcpBtn.classList.toggle("on", mcp.link === "active" || mcp.servers.list.some((x) => x.enabled)); this.mcpBtn.title = `MCP — ${mcp.link === "active" ? "linked to the LUCID MCP bridge: AI applications can operate this tab" : mcp.settings.external === "off" ? "external control off" : "not linked to a bridge"}; ${mcp.servers.list.filter((x) => x.enabled).length} MCP server(s) for the assistant`; }; upd(); this.offs.push(mcp.on("change", upd)); }

    this.log = h("div", { class: "ai-log", role: "log", "aria-live": "polite" });
    this.empty = h("div", { class: "ai-empty" });
    this.log.addEventListener("scroll", () => { /* stick to the bottom unless the user scrolled up */ });

    this.ctxLine = h("div", { class: "ai-ctx" });
    this.attachBtn = h("button", { class: "ibtn ai-ib ai-attach", type: "button", title: "Attach the current frame to the next message (sent to the provider)", "aria-pressed": "false" }, svg(I.image)) as HTMLButtonElement;
    this.attachBtn.addEventListener("click", () => { this.attach = !this.attach; this.attachBtn.classList.toggle("on", this.attach); this.attachBtn.setAttribute("aria-pressed", String(this.attach)); });
    this.input = h("textarea", { class: "ai-input", rows: "1", placeholder: isTouchUi() ? "Ask LUCID AI…" : "Ask LUCID AI… (Enter to send, Shift+Enter for a new line)", spellcheck: "true", enterkeyhint: "send", "aria-label": "Message to the assistant" }) as HTMLTextAreaElement;
    this.sendBtn = h("button", { class: "ai-send", type: "button", title: "Send (Enter)", "aria-label": "Send" }, svg(I.send)) as HTMLButtonElement;
    this.sendBtn.addEventListener("click", () => (this.agent.busy ? this.agent.stop() : void this.submit()));
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!this.agent.busy) void this.submit(); }
      else if (e.key === "ArrowUp" && !this.input.value && this.sent.length) { e.preventDefault(); this.hpos = Math.min(this.sent.length - 1, this.hpos + 1); this.input.value = this.sent[this.sent.length - 1 - this.hpos]; this.grow(); }
      else if (e.key === "Escape" && this.agent.busy) { e.preventDefault(); this.agent.stop(); }
    });
    this.input.addEventListener("input", () => this.grow());
    const box = h("div", { class: "ai-box" }, this.input, h("div", { class: "ai-box-btns" }, this.attachBtn, this.sendBtn));
    this.el = h("div", { class: "panel ai" }, head, this.log, h("div", { class: "ai-foot" }, this.ctxLine, box));

    // The workspace moves the focus into a view it shows (Ctrl+I, restoring a hidden panel) by focusing its first
    // control, which is the model button: the chat input is what should get it. Clicks and Tab are left alone.
    let lastUser = -1e9;
    const userMark = () => { lastUser = performance.now(); };
    const tabMark = (e: KeyboardEvent) => { if (e.key === "Tab") userMark(); };
    this.el.addEventListener("pointerdown", userMark, true);
    document.addEventListener("keydown", tabMark, true);
    this.el.addEventListener("focusin", (e) => {
      // (the workspace may do it twice: when it shows the panel and after its animation)
      if (!(e.target instanceof HTMLElement) || !head.contains(e.target)) return;
      if (performance.now() - lastUser < 500) return;
      // after the focus event (Firefox ignores a focus change made while it is dispatched), if still there
      const t = e.target;
      setTimeout(() => { if (document.activeElement === t) this.input.focus({ preventScroll: true }); }, 0);
    });
    this.offs.push(() => document.removeEventListener("keydown", tabMark, true));

    this.offs.push(
      agent.on("item", (it) => this.queue(it)),
      agent.on("reset", () => this.rebuild()),
      agent.on("busy", (b) => this.refreshBusy(b)),
      agent.on("settings", () => this.refreshHead()),
      ctx.store.on("ui", (k) => { if (k.has("chainId") || k.has("frame") || k.has("selected")) this.refreshCtx(); }),
      ctx.store.on("project", () => { this.refreshCtx(); if (!this.agent.items.length) this.renderEmpty(); }),
    );
    this.refreshHead();
    this.refreshCtx();
    this.rebuild();
  }

  dispose() { this.offs.forEach((o) => o()); cancelAnimationFrame(this.raf); }

  /** Show the panel's input with optional text to complete. */
  focus(prefill?: string) {
    if (prefill !== undefined) { this.input.value = prefill; this.grow(); }
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

  /** Send a request as if typed (command palette, menus). */
  ask(text: string) { this.input.value = text; void this.submit(); }

  private grow() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(180, this.input.scrollHeight + 2)}px`;
  }

  private async submit() {
    const text = this.input.value.trim();
    if (!text) return;
    if (this.agent.problem()) { this.settings(); return; }
    let images: ImagePart[] = [];
    if (this.attach) {
      const img = await this.currentFrame();
      if (img) images = [img];
      this.attach = false; this.attachBtn.classList.remove("on"); this.attachBtn.setAttribute("aria-pressed", "false");
    }
    this.sent.push(text); this.hpos = -1;
    this.input.value = ""; this.grow();
    await this.agent.send(text, images);
  }

  /** The current output frame as an image for the model (user-initiated: the user chose to attach it). */
  private async currentFrame(): Promise<ImagePart | null> {
    const s = this.ctx.store, c = s.chain();
    if (!c) { toast("No frame to attach: load evidence first.", "info"); return null; }
    if (this.agent.settings.frames === "never") { toast("Frame sharing is off (AI Settings › Frames).", "info"); return null; }
    const r = await this.ctx.engine.call<{ w: number; h: number; rgba: Uint8ClampedArray } | null>("snapshot", c.id, s.selectedFilter()?.id ?? null, s.frameOf(), 1280);
    if (!r) return null;
    const cv = new OffscreenCanvas(r.w, r.h);
    cv.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.w, r.h), 0, 0);
    const b = new Uint8Array(await (await cv.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer());
    let bin = "";
    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
    return { mime: "image/jpeg", data: btoa(bin) };
  }

  // ------------------------------------------------------------ header / context
  private refreshHead() {
    const s = this.agent.settings, cfg = this.agent.config(), info = providerInfo(cfg.provider), problem = this.agent.problem();
    this.modelBtn.replaceChildren(h("span", { class: `ai-dot ${problem ? "off" : isLocalUrl(cfg.baseUrl) ? "local" : "on"}` }), h("span", { class: "ai-model-t" }, problem ? "Set up the assistant" : cfg.model));
    this.modelBtn.title = problem ? `${problem} (AI Settings)` : `${SHORT[cfg.provider]}: ${cfg.model} — ${cfg.baseUrl}${isLocalUrl(cfg.baseUrl) ? " (on this computer)" : ""}. Click to change.`;
    void info;
    this.modeSel.value = s.mode;
    this.autoCb.set(s.approval === "auto");
    this.autoCb.el.hidden = s.mode !== "agent";
    if (!this.agent.items.length) this.renderEmpty();
  }

  private refreshCtx() {
    const s = this.ctx.store, c = s.chain();
    if (!c) { this.ctxLine.textContent = "No evidence loaded"; return; }
    const f = s.selectedFilter();
    this.ctxLine.textContent = `${c.name} · frame ${s.frameOf()}${f ? ` · ${FILTERS[f.type]?.name ?? f.type}` : ""}`;
  }

  private refreshBusy(b: boolean) {
    this.sendBtn.replaceChildren(svg(b ? I.stop : I.send));
    this.sendBtn.title = b ? "Stop (Esc)" : "Send (Enter)";
    this.sendBtn.setAttribute("aria-label", b ? "Stop" : "Send");
    this.sendBtn.classList.toggle("busy", b);
    this.el.classList.toggle("busy", b);
    for (const it of this.agent.items) if (it.kind === "user") this.queue(it);
  }

  // ------------------------------------------------------------ transcript
  private rebuild() {
    this.els.clear(); this.queued.clear();
    this.log.replaceChildren();
    if (!this.agent.items.length) this.renderEmpty();
    for (const it of this.agent.items) this.render(it);
    this.scroll(true);
  }

  private renderEmpty() {
    if (this.agent.items.length) return;
    const has = this.ctx.store.project.chains.length > 0;
    const problem = this.agent.problem();
    const ideas = has
      ? ["Describe this evidence: format, frames, quality and anything unusual", "Make the license plate as readable as possible", "Stabilize this video and show me the result", "Improve brightness and contrast of this frame", "Play from the start at 0.05× speed", "Export the current frame as a 16-bit TIFF"]
      : ["Load the sample case and explain what each chain does", "What can you do in this application?", "Open a video for me"];
    const chips = h("div", { class: "ai-ideas" }, ...ideas.map((t) => { const b = h("button", { class: "ai-idea", type: "button" }, t); b.addEventListener("click", () => (problem ? this.settings() : this.ask(t))); return b; }));
    const setup = problem ? h("button", { class: "btn primary ai-setup", type: "button" }, "Set up the assistant…") : null;
    setup?.addEventListener("click", () => this.settings());
    this.empty.replaceChildren(
      h("div", { class: "ai-hero" }, svg(I.ai, "icon ai-hero-i"), h("b", null, "LUCID AI")),
      h("p", null, "Tell the assistant what you need. It works the application for you — filters, frames, playback, measurements, exports — and shows every step. Every change is undoable, and every request is recorded in the project and the report."),
      ...(setup ? [setup] : []), chips,
      h("p", { class: "muted small" }, problem ? "Works with OpenAI, Anthropic, Google Gemini, OpenRouter, or a model on this computer (Ollama, LM Studio)." : "Ctrl+K: command palette · Ctrl+I: this chat"));
    if (!this.empty.isConnected) this.log.replaceChildren(this.empty);
  }

  private queue(it: Item) {
    this.queued.set(it.id, it);
    if (!this.raf) this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 60;
      for (const q of this.queued.values()) this.render(q);
      this.queued.clear();
      this.scroll(atBottom);
    });
  }

  private scroll(force: boolean) { if (force) this.log.scrollTop = this.log.scrollHeight; }

  private render(it: Item) {
    if (this.empty.isConnected) this.empty.remove();
    const el = this.build(it);
    const old = this.els.get(it.id);
    if (old) old.replaceWith(el); else this.log.appendChild(el);
    this.els.set(it.id, el);
  }

  private build(it: Item): HTMLElement {
    switch (it.kind) {
      case "user": {
        const el = h("div", { class: "ai-msg ai-user", "data-id": it.id }, h("div", { class: "ai-bubble" }, it.text, it.images ? h("span", { class: "ai-badge" }, svg(I.image), "frame attached") : null));
        if (it.changed && !this.agent.busy) {
          const r = h("button", { class: "ai-link", type: "button", title: "Undo everything the assistant changed after this request (Edit › Undo brings it back)" }, svg(I.undo), "Restore checkpoint");
          r.addEventListener("click", async () => { if (await confirmDialog("Restore Checkpoint", "Undo every change the assistant made after this request?", "Restore")) this.agent.restore(it.id); });
          el.appendChild(h("div", { class: "ai-msg-foot" }, r));
        }
        return el;
      }
      case "assistant": {
        const el = h("div", { class: `ai-msg ai-bot${it.done ? "" : " streaming"}`, "data-id": it.id });
        if (!it.text && it.done) { el.hidden = true; return el; }
        if (!it.text) el.appendChild(h("div", { class: "ai-typing" }, h("i"), h("i"), h("i")));
        else el.appendChild(renderMarkdown(it.text));
        return el;
      }
      case "tool": {
        const icon = it.status === "done" ? I.check : it.status === "error" || it.status === "rejected" || it.status === "cancelled" ? I.close : it.status === "approval" ? I.help : I.loading;
        const head = h("div", { class: "ai-tool-head" },
          svg(icon, `icon ai-st ${it.status}`),
          it.via ? h("span", { class: "ai-via", title: `Requested by ${it.via} through MCP` }, it.via) : null,
          h("span", { class: "ai-tool-name" }, it.tkind === "mcp" ? "MCP" : TOOL_LABEL[it.name] ?? it.name),
          h("span", { class: "ai-tool-sum" }, it.summary),
          h("span", { class: "ai-caret" }, "▸"));
        const el = h("div", { class: `ai-tool ${it.status} k-${it.tkind}`, "data-id": it.id, "data-tool": it.name }, head);
        const details = h("pre", { class: "ai-tool-body", hidden: true });
        head.addEventListener("click", () => {
          details.hidden = !details.hidden;
          el.classList.toggle("open", !details.hidden);
          if (!details.hidden && !details.textContent) {
            const res = it.result ? (it.result.ok ? it.result.data : { error: it.result.error, details: it.result.data }) : "(running)";
            details.textContent = `${JSON.stringify(it.args, null, 1)}\n→ ${typeof res === "string" ? res : JSON.stringify(res, null, 1)}${it.result?.image ? "\n[image given to the model]" : ""}`;
          }
        });
        el.appendChild(details);
        if (it.status === "error" && it.result?.error) el.appendChild(h("div", { class: "ai-tool-err" }, it.result.error));
        if (it.status === "approval" && it.decide) {
          const yes = h("button", { class: "btn primary", type: "button" }, "Allow"), no = h("button", { class: "btn", type: "button" }, "Reject"), all = h("button", { class: "btn", type: "button" }, "Allow all in this chat");
          yes.addEventListener("click", () => it.decide?.("yes")); no.addEventListener("click", () => it.decide?.("no")); all.addEventListener("click", () => it.decide?.("always"));
          if (it.via || it.tkind === "mcp") all.textContent = it.via ? `Allow all from ${it.via}` : "Allow all calls to this server";
          el.appendChild(h("div", { class: "ai-approve" }, h("span", null, it.via ? `Allow ${it.via} to make this change?` : it.tkind === "mcp" ? "Allow this MCP tool call?" : "Allow this change?"), yes, no, all));
        }
        return el;
      }
      case "card": {
        const el = h("div", { class: `ai-card${it.open ? " open" : ""}`, "data-id": it.id }, h("div", { class: "ai-card-t" }, it.card.title), it.card.text ? h("div", { class: "ai-card-x" }, it.card.text) : null);
        if (it.open) {
          const row = h("div", { class: "ai-card-btns" });
          it.card.choices.forEach((c, i) => { const b = h("button", { class: `btn${c.primary ? " primary" : ""}${c.danger ? " danger" : ""}`, type: "button" }, c.label); b.addEventListener("click", () => it.pick?.(i)); row.appendChild(b); });
          el.appendChild(row);
          if (it.card.input) {
            const inp = h("input", { class: "inp", type: "text", placeholder: it.card.input.placeholder }) as HTMLInputElement;
            const go = h("button", { class: "btn", type: "button" }, "Send");
            const send = () => { if (inp.value.trim()) it.pick?.(inp.value.trim()); };
            go.addEventListener("click", send);
            inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(); } });
            el.appendChild(h("div", { class: "ai-card-in" }, inp, go));
            setTimeout(() => { if (inp.isConnected && !this.input.value) inp.focus(); }, 30);
          }
        } else el.appendChild(h("div", { class: "ai-card-ans" }, `→ ${it.answer ?? ""}`));
        return el;
      }
      case "consent": {
        const el = h("div", { class: `ai-card consent${it.open ? " open" : ""}`, "data-id": it.id },
          h("div", { class: "ai-card-t" }, svg(I.image), " The assistant wants to look at a frame"),
          h("div", { class: "ai-card-x" }, `The image is sent to ${it.provider}. Evidence images may be sensitive: allow only if that is acceptable for this case.`));
        if (it.open && it.decide) {
          const mk = (label: string, d: "once" | "chat" | "always" | "no", primary = false) => { const b = h("button", { class: `btn${primary ? " primary" : ""}`, type: "button" }, label); b.addEventListener("click", () => it.decide?.(d)); return b; };
          el.appendChild(h("div", { class: "ai-card-btns" }, mk("Allow once", "once", true), mk("Allow in this chat", "chat"), mk("Always allow", "always"), mk("Don't allow", "no")));
        } else el.appendChild(h("div", { class: "ai-card-ans" }, `→ ${({ once: "allowed once", chat: "allowed in this chat", always: "always allowed", no: "not allowed" } as Record<string, string>)[it.answer ?? "no"] ?? it.answer}`));
        return el;
      }
      case "note": return h("div", { class: `ai-note ${it.level}`, "data-id": it.id }, it.text);
    }
  }

  // ------------------------------------------------------------ settings
  settings() {
    const cur = this.agent.settings;
    const st: AiSettings = { ...cur, baseUrls: { ...cur.baseUrls }, models: { ...cur.models } };
    let keys: Partial<Record<ProviderId, string>> = {};
    const keyOf = (p: ProviderId) => keys[p] ?? getKey(p);
    const prov = selectBox(PROVIDERS.map((p) => [p.id, p.label]), st.provider, (v) => { st.provider = v as ProviderId; sync(); });
    const url = h("input", { class: "inp", type: "text", spellcheck: "false" }) as HTMLInputElement;
    url.addEventListener("input", () => { st.baseUrls[st.provider] = url.value.trim(); privacy(); });
    const resetUrl = h("button", { class: "ai-link", type: "button", title: "Use the provider's default address" }, "Default");
    resetUrl.addEventListener("click", () => { delete st.baseUrls[st.provider]; sync(); });
    const key = h("input", { class: "inp", type: "password", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    key.addEventListener("input", () => { keys[st.provider] = key.value.trim(); });
    const show = h("button", { class: "ai-link", type: "button" }, "Show");
    show.addEventListener("click", () => { key.type = key.type === "password" ? "text" : "password"; show.textContent = key.type === "password" ? "Show" : "Hide"; });
    const getKeyLink = h("a", { class: "ai-link", target: "_blank", rel: "noopener noreferrer" }, "Get a key");
    const remember = checkBox("Remember the key on this device (otherwise only until this tab is closed)", st.remember, (v) => { st.remember = v; });
    const list = h("datalist", { id: `ai-models-${Math.random().toString(36).slice(2)}` });
    const model = h("input", { class: "inp", type: "text", spellcheck: "false", list: list.id, placeholder: "Load the list, or type a model name" }) as HTMLInputElement;
    model.addEventListener("input", () => { st.models[st.provider] = model.value.trim(); });
    const load = h("button", { class: "btn", type: "button" }, "Load models");
    const status = h("div", { class: "ai-set-status small" });
    load.addEventListener("click", async () => {
      status.textContent = "Loading the model list…"; status.className = "ai-set-status small";
      try {
        const ids = await listModels(cfg());
        list.replaceChildren(...ids.map((id) => h("option", { value: id })));
        if (!model.value && ids.length) { model.value = ids[0]; st.models[st.provider] = ids[0]; }
        status.textContent = ids.length ? `${ids.length} models available (newest first). Choose one with tool use (function calling).` : "The provider returned no models.";
      } catch (e) { status.textContent = (e as Error).message; status.className = "ai-set-status small warn"; }
    });
    const frames = selectBox([["ask", "Ask me each time"], ["allow", "Always allow"], ["never", "Never (statistics only)"]], st.frames, (v) => { st.frames = v as AiSettings["frames"]; privacy(); });
    const approval = selectBox([["auto", "Apply directly (each change is undoable)"], ["ask", "Ask me before each change"]], st.approval, (v) => { st.approval = v as AiSettings["approval"]; });
    const steps = spinBox({ value: st.maxSteps, min: 3, max: 200, width: 80, onChange: (v) => { st.maxSteps = v; } });
    const hint = h("div", { class: "muted small ai-hint" });
    const priv = h("div", { class: "ai-privacy small" });
    const cfg = () => ({ provider: st.provider, baseUrl: st.baseUrls[st.provider] || providerInfo(st.provider).baseUrl, apiKey: keyOf(st.provider), model: st.models[st.provider] ?? "" });
    const privacy = () => {
      const c = cfg(), local = isLocalUrl(c.baseUrl);
      let host = c.baseUrl; try { host = new URL(c.baseUrl).host; } catch { /* keep */ }
      priv.className = `ai-privacy small ${local ? "local" : "cloud"}`;
      priv.replaceChildren(h("b", null, local ? "Stays on this computer. " : "Data leaves this computer. "),
        local ? `Requests go to ${host || "the local server"} only.`
          : `Your messages, the project structure, file metadata and measurements the assistant reads are sent to ${providerInfo(c.provider).label} (${host || "?"}). Frames: ${st.frames === "never" ? "never sent" : st.frames === "allow" ? "sent whenever the assistant looks at one" : "sent only after you allow it"}. For confidential evidence, use a model on this computer (Ollama, LM Studio).`);
    };
    const sync = () => {
      const info = providerInfo(st.provider);
      url.value = st.baseUrls[st.provider] ?? info.baseUrl;
      url.placeholder = info.baseUrl || "https://your-server/v1";
      key.value = keyOf(st.provider);
      key.placeholder = info.needsKey ? "required" : "optional";
      getKeyLink.hidden = !info.keyUrl; if (info.keyUrl) (getKeyLink as HTMLAnchorElement).href = info.keyUrl;
      model.value = st.models[st.provider] ?? "";
      list.replaceChildren();
      hint.textContent = info.hint ?? "";
      hint.hidden = !info.hint;
      status.textContent = "";
      privacy();
    };
    const test = h("button", { class: "btn", type: "button" }, "Test connection");
    test.addEventListener("click", async () => {
      const c = cfg();
      if (!c.model) { status.textContent = "Choose a model first."; status.className = "ai-set-status small warn"; return; }
      status.textContent = "Testing…"; status.className = "ai-set-status small";
      try {
        const t0 = performance.now();
        const r = await chat(c, { system: "You are a connection test. Reply with the single word OK.", messages: [{ role: "user", text: "Reply with OK." }], tools: [] });
        status.textContent = `Connected: “${r.text.trim().slice(0, 60) || "(empty answer)"}” in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
        status.className = "ai-set-status small ok";
      } catch (e) { status.textContent = (e as Error).message; status.className = "ai-set-status small warn"; }
    });
    const row = (label: string, ...ctl: (HTMLElement | null)[]) => h("div", { class: "form-row" }, h("span", null, label), h("div", { class: "ai-set-ctl" }, ...ctl));
    const body = h("div", { class: "form ai-settings" },
      row("Provider:", prov),
      row("Server address:", url, resetUrl),
      hint,
      row("API key:", key, show, getKeyLink),
      remember.el,
      row("Model:", model, load, list),
      h("div", { class: "form-sep" }, "Behavior"),
      row("Changes:", approval),
      row("Frames:", frames),
      row("Steps per request:", steps.el),
      priv,
      h("div", { class: "ai-set-test" }, test, status));
    sync();
    dialog({
      title: "AI Settings", body, width: 600,
      buttons: [
        { label: "Forget keys", action: async () => { if (await confirmDialog("Forget Keys", "Remove every stored API key from this browser?", "Forget", true)) { forgetKeys(); keys = {}; key.value = ""; toast("API keys forgotten.", "ok"); } return false; } },
        { label: "Cancel" },
        { label: "Save", primary: true, action: () => {
          for (const [p, k] of Object.entries(keys)) setKey(p as ProviderId, k ?? "", st.remember);
          if (st.remember !== cur.remember) for (const p of PROVIDERS) { const k = getKey(p.id); if (k) setKey(p.id, k, st.remember); }
          this.agent.saveSettings(st);
          const problem = this.agent.problem();
          toast(problem ? `${problem} to use the assistant.` : `Assistant ready: ${providerInfo(st.provider).label} · ${st.models[st.provider]}.`, problem ? "info" : "ok");
          this.refreshHead();
        } },
      ],
    });
  }
}
