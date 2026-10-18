// AI assistant core (no browser): SSE parsing under every chunking, streamed tool calls of the OpenAI and
// Anthropic formats, message conversion (pairing, images, alternation), Gemini schema adaptation, parameter
// validation against the real filter schemas, and the tool catalogue's JSON schemas.
import { adaptSchema } from "../src/ai/agent";
import { AnthropicStream, OpenAIStream, httpMessage, isLocalUrl, toAnthropicMessages, toOpenAIMessages } from "../src/ai/providers";
import { compactParams, filterSchema, resolveFilterType, validateParams } from "../src/ai/schema";
import { SseParser } from "../src/ai/sse";
import { TOOLS } from "../src/ai/tools";
import type { Msg } from "../src/ai/types";
import { FILTER_LIST, FILTERS } from "../src/shared/filters";

let fail = 0, pass = 0;
const ok = (c: unknown, m: string) => { if (c) { pass++; if (process.env.VERBOSE) console.log("ok  ", m); } else { fail++; console.log("FAIL", m); } };
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- SSE
{
  const stream = ': comment\r\nevent: message_start\r\ndata: {"a":1}\r\n\r\ndata: line1\ndata: line2\n\nid: 7\ndata: {"b":2}\r\r' + "data: [DONE]";
  const expect = [{ event: "message_start", data: '{"a":1}' }, { event: "message", data: "line1\nline2" }, { event: "message", data: '{"b":2}' }, { event: "message", data: "[DONE]" }];
  // every possible split into two chunks, and byte by byte
  let allOk = true;
  for (let cut = 0; cut <= stream.length; cut++) {
    const p = new SseParser();
    const ev = [...p.push(stream.slice(0, cut)), ...p.push(stream.slice(cut)), ...p.end()];
    if (!eq(ev, expect)) { allOk = false; console.log("split", cut, JSON.stringify(ev)); break; }
  }
  ok(allOk, "SSE: identical events for every split point (CRLF, CR, LF, multi-line data, comments, unterminated last event)");
  const p = new SseParser();
  const ev = [...stream].flatMap((ch) => p.push(ch)).concat(p.end());
  ok(eq(ev, expect), "SSE: byte-by-byte feeding");
}

// ---------------------------------------------------------------- OpenAI stream accumulation
{
  const texts: string[] = [];
  const s = new OpenAIStream((d) => texts.push(d));
  const chunks = [
    { choices: [{ delta: { role: "assistant", content: "Let me " } }] },
    { choices: [{ delta: { content: "check." } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "get_state", arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "add_filter", arguments: '{"type":"lev' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: 'els","params":{"inBlack":10}}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 10 } },
  ];
  chunks.forEach((c) => s.chunk(c));
  const r = s.result();
  ok(r.text === "Let me check." && texts.join("") === "Let me check.", "OpenAI: streamed text");
  ok(r.toolCalls.length === 2 && r.toolCalls[0].name === "get_state" && eq(r.toolCalls[0].args, {}) && r.toolCalls[1].id === "call_b" && eq(r.toolCalls[1].args, { type: "levels", params: { inBlack: 10 } }), "OpenAI: tool calls assembled from fragments");
  ok(r.stop === "tool_calls", "OpenAI: finish reason");
  const g = new OpenAIStream();
  g.chunk({ choices: [{ delta: { tool_calls: [{ id: "x1", function: { name: "go_to_frame", arguments: '{"frame": 5}' } }, { id: "x2", function: { name: "playback", arguments: { action: "play" } } }] } }] });
  const gr = g.result();
  ok(gr.toolCalls.length === 2 && eq(gr.toolCalls[0].args, { frame: 5 }) && eq(gr.toolCalls[1].args, { action: "play" }), "OpenAI: complete calls without index (Gemini) and object arguments (Ollama)");
  const b = new OpenAIStream();
  b.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "z", function: { name: "add_filter", arguments: "{not json" } }] } }] });
  ok(b.result().toolCalls[0].badArgs === "{not json", "OpenAI: invalid argument JSON kept for an error answer");
  let threw = false;
  try { new OpenAIStream().chunk({ error: { message: "quota exceeded" } }); } catch (e) { threw = String((e as Error).message).includes("quota exceeded"); }
  ok(threw, "OpenAI: an error chunk becomes an error with the provider's message");
}

// ---------------------------------------------------------------- Anthropic stream accumulation
{
  const texts: string[] = [];
  const s = new AnthropicStream((d) => texts.push(d));
  [
    { type: "message_start", message: { id: "m" } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Adding " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a filter." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "add_filter", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"type": "unsharp' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '_masking"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ].forEach((e) => s.event(e));
  const r = s.result();
  ok(r.text === "Adding a filter." && texts.join("") === "Adding a filter.", "Anthropic: streamed text");
  ok(r.toolCalls.length === 1 && r.toolCalls[0].id === "toolu_1" && eq(r.toolCalls[0].args, { type: "unsharp_masking" }) && r.stop === "tool_use", "Anthropic: tool_use assembled from input_json_delta");
  const m = new AnthropicStream();
  m.message({ content: [{ type: "text", text: "Hi" }, { type: "tool_use", id: "t2", name: "get_state", input: { a: 1 } }], stop_reason: "tool_use" });
  ok(eq(m.result(), { text: "Hi", toolCalls: [{ id: "t2", name: "get_state", args: { a: 1 } }], stop: "tool_use" }), "Anthropic: non-streamed message");
  let threw = false;
  try { new AnthropicStream().event({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }); } catch (e) { threw = String((e as Error).message).includes("Overloaded"); }
  ok(threw, "Anthropic: error event");
}

// ---------------------------------------------------------------- message conversion
const conv: Msg[] = [
  { role: "user", text: "Look at the plate", images: [{ mime: "image/jpeg", data: "AAA" }] },
  { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "view_frame", args: {} }, { id: "c2", name: "get_state", args: {} }] },
  { role: "tool", toolCallId: "c1", toolName: "view_frame", text: '{"frame":3}', images: [{ mime: "image/jpeg", data: "BBB" }] },
  { role: "tool", toolCallId: "c2", toolName: "get_state", text: '{"error":"x"}', isError: true },
  { role: "assistant", text: "Done." },
  { role: "user", text: "Thanks" },
];
{
  const o = toOpenAIMessages("SYS", conv);
  ok(o[0].role === "system" && o[0].content === "SYS", "OpenAI messages: system first");
  ok(Array.isArray(o[1].content) && o[1].content[1].image_url.url === "data:image/jpeg;base64,AAA", "OpenAI messages: user image as data URL");
  ok(o[2].role === "assistant" && o[2].content === null && o[2].tool_calls.length === 2 && o[2].tool_calls[0].function.arguments === "{}", "OpenAI messages: assistant tool calls, null content");
  ok(o[3].role === "tool" && o[3].tool_call_id === "c1" && o[4].role === "tool" && o[4].tool_call_id === "c2", "OpenAI messages: tool answers directly after the call, in order");
  ok(o[5].role === "user" && o[5].content[1].image_url.url.endsWith("BBB"), "OpenAI messages: tool images follow ALL tool answers as a user message");
  ok(o[6].role === "assistant" && o[6].content === "Done." && o[7].content === "Thanks", "OpenAI messages: rest of the conversation");
}
{
  const a = toAnthropicMessages(conv);
  const roles = a.map((m) => m.role).join(",");
  ok(roles === "user,assistant,user,assistant,user", `Anthropic messages: strictly alternating (${roles})`);
  ok(a[0].content[1].type === "image" && a[0].content[1].source.data === "AAA", "Anthropic messages: user image block");
  ok(a[1].content.length === 2 && a[1].content.every((b: any) => b.type === "tool_use"), "Anthropic messages: empty text dropped, tool_use blocks kept");
  ok(a[2].content.length === 2 && a[2].content[0].type === "tool_result" && a[2].content[0].content[1].type === "image" && a[2].content[1].is_error === true, "Anthropic messages: both tool results in one user turn, image inside, error flag");
  const b = toAnthropicMessages([{ role: "user", text: "a" }, { role: "assistant", toolCalls: [{ id: "t", name: "x", args: {} }] }, { role: "tool", toolCallId: "t", text: "r" }, { role: "user", text: "more" }]);
  ok(b.length === 3 && b[2].content[0].type === "tool_result" && b[2].content[1].type === "text", "Anthropic messages: a user message after tool results merges into the same turn, tool_result first");
}

// ---------------------------------------------------------------- Gemini schema adaptation
{
  const schema = { type: "object", properties: { type: { type: "string" }, params: { type: "object", description: "values" }, region: { type: "object", properties: { x: { type: "number" } } } }, required: ["type"] };
  const g = adaptSchema(schema, "gemini");
  ok(g.properties.params.type === "string" && g.properties.params.description.includes("JSON") && g.properties.region.type === "object" && g.properties.region.properties.x.type === "number" && eq(g.required, ["type"]), "Gemini: free objects become JSON text, declared objects stay");
  ok(adaptSchema(schema, "openai") === schema, "other providers: schema unchanged");
}

// ---------------------------------------------------------------- filter types and parameter validation
{
  ok(resolveFilterType("levels")?.id === "levels" && resolveFilterType("Levels")?.id === "levels" && resolveFilterType("unsharp masking")?.id === resolveFilterType("Unsharp Masking")?.id, "filter types by id or name");
  ok(resolveFilterType("warp drive") === null, "unknown filter type");
  let schemaOk = true;
  for (const f of FILTER_LIST) { const s = filterSchema(f); if (!s.params.every((p: any) => p.key && p.type)) { schemaOk = false; console.log("schema", f.id); } }
  ok(schemaOk, `filter schema for all ${FILTER_LIST.length} filters`);
  const lev = FILTERS.levels;
  const keys = lev.params.map((p) => p.key);
  const numKey = lev.params.find((p) => p.type === "number" || p.type === "int")!;
  const v1 = validateParams(lev, { [numKey.key]: 99999 }, { chains: [] });
  ok(v1.errors.length === 0 && v1.params[numKey.key] === (numKey as any).max && v1.warnings.length === 1, `numbers clamped to the range with a warning (${numKey.key})`);
  const v2 = validateParams(lev, { gammaa: 1 }, { chains: [] });
  ok(v2.errors.length === 1 && keys.every((k) => v2.errors[0].includes(k) || !lev.params.find((p) => p.key === k && !["action", "psf", "info", "fileinfo"].includes(p.type))), "unknown parameter: error listing the valid keys");
  const selDef = FILTER_LIST.flatMap((f) => f.params.filter((p) => p.type === "select").map((p) => ({ f, p }))).find(({ p }) => (p as any).options.some(([v, l]: [string, string]) => v !== l))!;
  const [val, label] = (selDef.p as any).options.find(([v, l]: [string, string]) => v !== l);
  ok(validateParams(selDef.f, { [selDef.p.key]: label.toUpperCase() }, { chains: [] }).params[selDef.p.key] === val, `select accepts the option label (${selDef.f.id}.${selDef.p.key}: "${label}" → ${val})`);
  ok(validateParams(selDef.f, { [selDef.p.key]: "nonsense-value" }, { chains: [] }).errors.length === 1, "select rejects other values");
  const vl = FILTERS.video_loader;
  ok(validateParams(vl, { source: "x" }, { chains: [] }).errors[0]?.includes("open_media"), "file parameters cannot be set by the assistant");
  ok(validateParams(vl, { chroma: "Bilinear", matrix: "bt709" }, { chains: [] }).params.chroma === "bilinear", "video loader options by label");
  const crop = FILTERS.crop, rectKey = crop.params.find((p) => p.type === "rect")!.key;
  ok(eq(validateParams(crop, { [rectKey]: [10, 20, 100, 50] }, { chains: [] }).params[rectKey], { x: 10, y: 20, w: 100, h: 50 }), "rect from [x, y, w, h]");
  ok(validateParams(crop, { [rectKey]: { x: 1, y: 1, w: 0, h: 5 } }, { chains: [] }).errors.length === 1, "rect with zero width rejected");
  const colorF = FILTER_LIST.find((f) => f.params.some((p) => p.type === "color"))!, ck = colorF.params.find((p) => p.type === "color")!.key;
  ok(validateParams(colorF, { [ck]: "F80" }, { chains: [] }).params[ck] === "#ff8800", "color normalized (#rrggbb)");
  const chainF = FILTER_LIST.find((f) => f.params.some((p) => p.type === "chain"))!, chk = chainF.params.find((p) => p.type === "chain")!.key;
  ok(validateParams(chainF, { [chk]: "Second Chain" }, { chains: [{ id: "c9", name: "Second Chain" }] }).params[chk] === "c9", "chain by name → id");
  const curveF = FILTER_LIST.find((f) => f.params.some((p) => p.type === "curve"));
  if (curveF) { const k = curveF.params.find((p) => p.type === "curve")!.key; ok(eq(validateParams(curveF, { [k]: [{ x: 300, y: 10 }, { x: 0, y: -5 }] }, { chains: [] }).params[k], [{ x: 0, y: 0 }, { x: 255, y: 10 }]), "curve clamped and sorted"); }
  const boolF = FILTER_LIST.find((f) => f.params.some((p) => p.type === "bool"))!, bk = boolF.params.find((p) => p.type === "bool")!.key;
  ok(validateParams(boolF, { [bk]: "true" }, { chains: [] }).params[bk] === true && validateParams(boolF, { [bk]: "maybe" }, { chains: [] }).errors.length === 1, "booleans");
  ok(eq(compactParams(lev, { ...Object.fromEntries(keys.map((k) => [k, 1])) }).constructor, Object), "compact parameters");
}

// ---------------------------------------------------------------- tool catalogue
{
  const names = new Set<string>();
  let good = true;
  for (const t of TOOLS) {
    const p = t.parameters as any;
    const why = !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name) ? "name" : names.has(t.name) ? "duplicate" : !t.description || t.description.length > 1000 ? "description" : p.type !== "object" || typeof p.properties !== "object" ? "schema" : (p.required ?? []).some((r: string) => !(r in p.properties)) ? "required" : "";
    names.add(t.name);
    if (why) { good = false; console.log("tool", t.name, why); }
  }
  ok(good && TOOLS.length >= 30, `tool catalogue: ${TOOLS.length} tools, valid names and JSON schemas`);
  ok(["read", "nav", "write", "ui"].every((k) => TOOLS.some((t) => t.kind === k)), "tools of every kind");
}

// ---------------------------------------------------------------- misc
ok(isLocalUrl("http://localhost:11434/v1") && isLocalUrl("http://127.0.0.1:1234/v1") && isLocalUrl("http://[::1]:8080") && !isLocalUrl("https://api.openai.com/v1"), "local server detection");
ok(httpMessage(401, '{"error":{"message":"Incorrect API key"}}').includes("Incorrect API key") && httpMessage(429, "").includes("rate"), "HTTP errors explained with the provider's message");

console.log(`ai: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
