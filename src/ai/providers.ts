// Model providers for the assistant. Two wire formats cover them all:
//  - OpenAI Chat Completions (OpenAI, Google Gemini's OpenAI endpoint, OpenRouter, Ollama, LM Studio, any
//    OpenAI-compatible server), and
//  - Anthropic Messages (Claude).
// Requests go straight from the browser to the provider (all of these allow it); nothing passes through a
// LUCID server. Responses are streamed (SSE) so text appears as it is written.
import { BRAND } from "../brand";
import { sseEvents } from "./sse";
import type { AiConfig, ChatRequest, ChatResult, ImagePart, Msg, ProviderId, ToolCall } from "./types";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  kind: "openai" | "anthropic";
  baseUrl: string;
  needsKey: boolean;
  /** Runs on the user's computer by default. */
  local?: boolean;
  keyUrl?: string;
  /** Setup hint shown in AI Settings. */
  hint?: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: "openai", label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", needsKey: true, keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic (Claude)", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", needsKey: true, keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "gemini", label: "Google Gemini", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true, keyUrl: "https://aistudio.google.com/apikey" },
  { id: "openrouter", label: "OpenRouter (many models)", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, keyUrl: "https://openrouter.ai/keys" },
  { id: "ollama", label: "Ollama (on this computer)", kind: "openai", baseUrl: "http://localhost:11434/v1", needsKey: false, local: true,
    hint: "Start Ollama so that it accepts this page: OLLAMA_ORIGINS=* ollama serve. Use a model with tool support (e.g. Qwen, Llama 3.1+, Mistral)." },
  { id: "lmstudio", label: "LM Studio (on this computer)", kind: "openai", baseUrl: "http://localhost:1234/v1", needsKey: false, local: true,
    hint: "In LM Studio: Developer › Start Server, and turn on \"Enable CORS\". Load a model with tool use." },
  { id: "custom", label: "Other OpenAI-compatible server", kind: "openai", baseUrl: "", needsKey: false, hint: "Any server with the OpenAI /chat/completions API and tool calling (vLLM, llama.cpp, LiteLLM, Azure-style gateways…)." },
];

export const providerInfo = (id: ProviderId): ProviderInfo => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];

export class AiError extends Error {
  constructor(message: string, public status = 0, public detail = "") { super(message); }
}

export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost") || h === "0.0.0.0";
  } catch { return false; }
}

const trimSlash = (u: string) => u.trim().replace(/\/+$/, "");
let seq = 0;
export const newCallId = () => `call_${Date.now().toString(36)}${(seq++).toString(36)}`;

function parseArgs(s: string): { args: Record<string, any>; bad?: string } {
  if (!s || !s.trim()) return { args: {} };
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? { args: v } : { args: {}, bad: s };
  } catch { return { args: {}, bad: s }; }
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); }, { once: true });
});

/** The provider's own explanation, from a JSON error body when there is one. */
function providerMessage(detail: string): string {
  try {
    const j = JSON.parse(detail);
    const e = Array.isArray(j) ? j[0]?.error : j.error ?? j;
    const m = typeof e === "string" ? e : e?.message ?? j.message;
    if (m) return String(m).slice(0, 300);
  } catch { /* not JSON */ }
  return detail.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function httpMessage(status: number, detail: string): string {
  const why = providerMessage(detail);
  const tail = why ? ` (${why})` : "";
  if (status === 401 || status === 403) return `The provider rejected the API key${tail}. Check it in AI Settings.`;
  if (status === 404) return `Not found${tail}: check the model name and the server address in AI Settings.`;
  if (status === 413) return `The request is too large for this model${tail}. Start a new chat or share smaller frames.`;
  if (status === 429) return `The provider is rate limiting this key or its credit is used up${tail}. Wait a moment, or check the account.`;
  if (status === 400 || status === 422) return `The provider rejected the request${tail}.`;
  if (status >= 500) return `The provider had a server error (${status})${tail}. Try again.`;
  return `The provider answered ${status}${tail}.`;
}

export function unreachableMessage(url: string): string {
  let host = url;
  try { host = new URL(url).host; } catch { /* keep */ }
  if (isLocalUrl(url)) return `Cannot reach ${host}. Is the server running, and does it accept requests from this page? Ollama: start it with OLLAMA_ORIGINS=* (or this site's address). LM Studio: turn on "Enable CORS". Some browsers also ask for permission to reach local servers.`;
  return `Cannot reach ${host}: the computer is offline, a firewall or extension blocks it, or the address is wrong.`;
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try { res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal }); }
    catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      throw new AiError(unreachableMessage(url), 0, String(e));
    }
    if (res.ok) return res;
    // one retry for transient errors (rate limit, overload)
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt === 0) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Math.min(8000, isFinite(ra) && ra > 0 ? ra * 1000 : 1500), signal);
      continue;
    }
    const detail = await res.text().catch(() => "");
    throw new AiError(httpMessage(res.status, detail), res.status, detail);
  }
}

// ---------------------------------------------------------------- OpenAI Chat Completions
export function openaiHeaders(cfg: AiConfig): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.provider === "openrouter") {
    if (typeof location !== "undefined" && /^https?:/.test(location.origin)) h["HTTP-Referer"] = location.origin;
    h["X-Title"] = BRAND.fullName;
  }
  return h;
}

const oaImage = (i: ImagePart) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } });

/** Neutral messages → Chat Completions messages. Tool results cannot carry images there, so images returned by
 *  tools follow the tool messages as a user message. */
export function toOpenAIMessages(system: string, msgs: Msg[]): any[] {
  const out: any[] = [{ role: "system", content: system }];
  let pending: ImagePart[] = [];
  const flush = () => {
    if (!pending.length) return;
    out.push({ role: "user", content: [{ type: "text", text: "Image returned by the tool call above:" }, ...pending.map(oaImage)] });
    pending = [];
  };
  for (const m of msgs) {
    if (m.role !== "tool") flush();
    if (m.role === "user") out.push({ role: "user", content: m.images?.length ? [{ type: "text", text: m.text ?? "" }, ...m.images.map(oaImage)] : m.text ?? "" });
    else if (m.role === "assistant") {
      const calls = m.toolCalls ?? [];
      const o: any = { role: "assistant", content: calls.length && !m.text ? null : m.text ?? "" };
      if (calls.length) o.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.badArgs ?? JSON.stringify(c.args) } }));
      out.push(o);
    } else {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.text || "(no output)" });
      if (m.images?.length) pending.push(...m.images);
    }
  }
  flush();
  return out;
}

/** Accumulates streamed Chat Completions chunks (text and tool-call fragments). */
export class OpenAIStream {
  text = "";
  stop = "";
  private calls: { id: string; name: string; args: string }[] = [];
  constructor(private onText?: (d: string) => void) {}
  chunk(j: any) {
    if (j?.error) throw new AiError(`The provider reported an error: ${providerMessage(JSON.stringify(j))}`);
    const ch = j?.choices?.[0];
    if (!ch) return;
    const d = ch.delta ?? ch.message ?? {};
    if (typeof d.content === "string" && d.content) { this.text += d.content; this.onText?.(d.content); }
    if (Array.isArray(d.tool_calls)) {
      d.tool_calls.forEach((tc: any, k: number) => {
        const i = typeof tc.index === "number" ? tc.index : k;
        const c = (this.calls[i] ??= { id: "", name: "", args: "" });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name && !c.name) c.name = tc.function.name;
        const a = tc.function?.arguments;
        if (typeof a === "string") c.args += a;
        else if (a && typeof a === "object") c.args = JSON.stringify(a);
      });
    }
    if (ch.finish_reason) this.stop = ch.finish_reason;
  }
  result(): ChatResult {
    const toolCalls: ToolCall[] = this.calls.filter((c) => c && c.name).map((c) => {
      const p = parseArgs(c.args);
      return { id: c.id || newCallId(), name: c.name, args: p.args, ...(p.bad !== undefined ? { badArgs: p.bad } : {}) };
    });
    return { text: this.text, toolCalls, stop: this.stop };
  }
}

async function openaiChat(cfg: AiConfig, req: ChatRequest): Promise<ChatResult> {
  const body: any = { model: cfg.model, messages: toOpenAIMessages(req.system, req.messages), stream: true };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = "auto";
  }
  const res = await post(`${trimSlash(cfg.baseUrl)}/chat/completions`, openaiHeaders(cfg), body, req.signal);
  const acc = new OpenAIStream(req.onText);
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    acc.chunk(await res.json()); // a server that ignores "stream"
    return acc.result();
  }
  for await (const ev of sseEvents(res.body!, req.signal)) {
    if (ev.data === "[DONE]") break;
    let j: any;
    try { j = JSON.parse(ev.data); } catch { continue; }
    acc.chunk(j);
  }
  return acc.result();
}

// ---------------------------------------------------------------- Anthropic Messages
export function anthropicHeaders(cfg: AiConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": cfg.apiKey,
    "anthropic-version": "2023-06-01",
    // the API answers browsers only with this header (the key is the user's own, entered on this page)
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

const anImage = (i: ImagePart) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } });

/** Neutral messages → Messages API turns: strictly alternating, tool results (which may carry images) in the
 *  next user turn, before any text. */
export function toAnthropicMessages(msgs: Msg[]): any[] {
  const out: { role: "user" | "assistant"; content: any[] }[] = [];
  const push = (role: "user" | "assistant", blocks: any[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of msgs) {
    if (m.role === "user") push("user", [...(m.text ? [{ type: "text", text: m.text }] : []), ...(m.images ?? []).map(anImage)]);
    else if (m.role === "assistant") push("assistant", [...(m.text ? [{ type: "text", text: m.text }] : []), ...(m.toolCalls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args }))]);
    else push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: [{ type: "text", text: m.text || "(no output)" }, ...(m.images ?? []).map(anImage)], ...(m.isError ? { is_error: true } : {}) }]);
  }
  for (const o of out) if (o.role === "user") o.content.sort((a, b) => (a.type === "tool_result" ? 0 : 1) - (b.type === "tool_result" ? 0 : 1));
  return out;
}

/** Accumulates streamed Messages API events. */
export class AnthropicStream {
  stop = "";
  private blocks: ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; json: string } | null)[] = [];
  constructor(private onText?: (d: string) => void) {}
  event(j: any) {
    switch (j?.type) {
      case "content_block_start": {
        const cb = j.content_block ?? {};
        if (cb.type === "text") { this.blocks[j.index] = { type: "text", text: cb.text ?? "" }; if (cb.text) this.onText?.(cb.text); }
        else if (cb.type === "tool_use") this.blocks[j.index] = { type: "tool_use", id: cb.id, name: cb.name, json: cb.input && Object.keys(cb.input).length ? JSON.stringify(cb.input) : "" };
        else this.blocks[j.index] = null; // thinking etc.
        break;
      }
      case "content_block_delta": {
        const b = this.blocks[j.index], d = j.delta ?? {};
        if (d.type === "text_delta" && b?.type === "text") { b.text += d.text; this.onText?.(d.text); }
        else if (d.type === "input_json_delta" && b?.type === "tool_use") b.json += d.partial_json ?? "";
        break;
      }
      case "message_delta": if (j.delta?.stop_reason) this.stop = j.delta.stop_reason; break;
      case "error": throw new AiError(`The provider reported an error: ${providerMessage(JSON.stringify(j))}`);
    }
  }
  /** A complete (non-streamed) response. */
  message(j: any) {
    (j.content ?? []).forEach((cb: any, i: number) => {
      this.event({ type: "content_block_start", index: i, content_block: cb.type === "tool_use" ? { ...cb, input: {} } : { ...cb, text: "" } });
      if (cb.type === "text") this.event({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: cb.text } });
      if (cb.type === "tool_use") this.event({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(cb.input ?? {}) } });
    });
    this.stop = j.stop_reason ?? "";
  }
  result(): ChatResult {
    const text = this.blocks.filter((b): b is { type: "text"; text: string } => b?.type === "text").map((b) => b.text).join("\n\n");
    const toolCalls: ToolCall[] = this.blocks.filter((b): b is { type: "tool_use"; id: string; name: string; json: string } => b?.type === "tool_use").map((b) => {
      const p = parseArgs(b.json);
      return { id: b.id || newCallId(), name: b.name, args: p.args, ...(p.bad !== undefined ? { badArgs: p.bad } : {}) };
    });
    return { text, toolCalls, stop: this.stop };
  }
}

async function anthropicChat(cfg: AiConfig, req: ChatRequest): Promise<ChatResult> {
  const body: any = { model: cfg.model, max_tokens: 8192, system: req.system, messages: toAnthropicMessages(req.messages), stream: true };
  if (req.tools.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const res = await post(`${trimSlash(cfg.baseUrl)}/messages`, anthropicHeaders(cfg), body, req.signal);
  const acc = new AnthropicStream(req.onText);
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) { acc.message(await res.json()); return acc.result(); }
  for await (const ev of sseEvents(res.body!, req.signal)) {
    let j: any;
    try { j = JSON.parse(ev.data); } catch { continue; }
    acc.event(j);
  }
  return acc.result();
}

// ---------------------------------------------------------------- public API
export function chat(cfg: AiConfig, req: ChatRequest): Promise<ChatResult> {
  return providerInfo(cfg.provider).kind === "anthropic" ? anthropicChat(cfg, req) : openaiChat(cfg, req);
}

/** Models that are not chat models (embeddings, speech, images…). */
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|transcribe|audio|realtime|^image|imagen|veo|aqa|-search|computer-use|rerank|guard/i;

/** The provider's model list, newest first, chat models only. */
export async function listModels(cfg: AiConfig, signal?: AbortSignal): Promise<string[]> {
  const url = `${trimSlash(cfg.baseUrl)}/models`;
  const headers = providerInfo(cfg.provider).kind === "anthropic" ? anthropicHeaders(cfg) : openaiHeaders(cfg);
  delete headers["content-type"];
  let res: Response;
  try { res = await fetch(url, { headers, signal }); }
  catch (e) { if ((e as Error)?.name === "AbortError") throw e; throw new AiError(unreachableMessage(url), 0, String(e)); }
  if (!res.ok) { const d = await res.text().catch(() => ""); throw new AiError(httpMessage(res.status, d), res.status, d); }
  const j = await res.json();
  const items = ((j.data ?? j.models ?? []) as any[]).map((m) => ({
    id: String(m.id ?? m.name ?? "").replace(/^models\//, ""),
    t: Number(m.created ?? (m.created_at ? Date.parse(m.created_at) / 1000 : 0)) || 0,
  })).filter((m) => m.id && !NOT_CHAT.test(m.id));
  items.sort((a, b) => b.t - a.t || a.id.localeCompare(b.id));
  return [...new Set(items.map((m) => m.id))];
}
