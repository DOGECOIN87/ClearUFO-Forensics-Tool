"""Mock model server for the AI assistant tests.

Speaks the two wire formats the app uses, streamed exactly like the real APIs (SSE):
  POST /v1/chat/completions   OpenAI Chat Completions (OpenAI, Gemini, OpenRouter, Ollama, LM Studio …)
  POST /v1/messages           Anthropic Messages (refused without the browser-access header, like the real API)
  GET  /v1/models             model list (OpenAI and Anthropic shapes)
CORS is answered like a public API (Authorization must be listed explicitly, as browsers require).

The "model" follows scripted agent behaviours chosen by the user's request ("TEST:levels" …) and by the tool
results it receives, so the app's agent loop is exercised end to end. Every request is recorded:
  GET /log  → JSON list of requests     POST /reset → clear

Usage: python3 tests/e2e/ai_mock.py PORT
"""
import json, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

LOG, LOCK = [], threading.Lock()
ALLOW_HEADERS = "authorization, content-type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access, http-referer, x-title"
IMG_CARRIER = "Image returned by the tool call above:"
N = [0]

def nid(prefix):
    N[0] += 1
    return f"{prefix}{N[0]:04d}"

# ------------------------------------------------------------------ conversation analysis
def turn_openai(msgs):
    """(user_text, steps): steps = [{name, result, error, image}] after the last real user message."""
    start = 0
    for i, m in enumerate(msgs):
        if m.get("role") == "user":
            c = m.get("content")
            text = c if isinstance(c, str) else " ".join(p.get("text", "") for p in c if p.get("type") == "text")
            if text.strip() != IMG_CARRIER:
                start, user = i, text
    names, steps = {}, []
    for k, m in enumerate(msgs[start + 1:]):
        if m.get("role") == "assistant":
            for tc in m.get("tool_calls") or []:
                names[tc["id"]] = tc["function"]["name"]
        elif m.get("role") == "tool":
            try: res = json.loads(m.get("content") or "{}")
            except Exception: res = {"raw": m.get("content")}
            steps.append({"name": names.get(m.get("tool_call_id"), "?"), "result": res, "error": isinstance(res, dict) and "error" in res, "image": False})
        elif m.get("role") == "user" and steps:
            c = m.get("content")
            if isinstance(c, list) and any(p.get("type") == "image_url" for p in c):
                steps[-1]["image"] = True
    images = sum(1 for m in msgs for p in (m.get("content") if isinstance(m.get("content"), list) else []) if p.get("type") == "image_url")
    return user, steps, images

def turn_anthropic(msgs):
    start, user = 0, ""
    for i, m in enumerate(msgs):
        if m["role"] != "user": continue
        c = m["content"]
        if isinstance(c, str): start, user = i, c; continue
        if not any(b.get("type") == "tool_result" for b in c):
            texts = [b.get("text", "") for b in c if b.get("type") == "text"]
            start, user = i, texts[-1] if texts else ""
    names, steps = {}, []
    for m in msgs[start + 1:]:
        c = m["content"] if isinstance(m["content"], list) else []
        for b in c:
            if b.get("type") == "tool_use": names[b["id"]] = b["name"]
            if b.get("type") == "tool_result":
                txt = " ".join(x.get("text", "") for x in b.get("content", []) if x.get("type") == "text")
                try: res = json.loads(txt)
                except Exception: res = {"raw": txt}
                steps.append({"name": names.get(b["tool_use_id"], "?"), "result": res, "error": bool(b.get("is_error")) or (isinstance(res, dict) and "error" in res),
                              "image": any(x.get("type") == "image" for x in b.get("content", []))})
    images = sum(1 for m in msgs for b in (m["content"] if isinstance(m["content"], list) else []) for x in ([b] + (b.get("content") if isinstance(b.get("content"), list) else [])) if x.get("type") == "image")
    return user, steps, images

# ------------------------------------------------------------------ scripted behaviours
def P(params, as_text):
    """Free-form params: an object, or JSON text when the provider schema asks for it (Gemini)."""
    return json.dumps(params) if as_text else params

def script(user, steps, tools, as_text):
    """Return (text, [tool calls]) for the next model turn."""
    n = len(steps)
    last = steps[-1] if steps else None
    u = user.strip()
    if "connection test" in u.lower() or u == "Reply with OK.": return "OK", []
    if u.startswith("TEST:levels"):
        if n == 0: return "I'll look at the project first.", [("get_state", {})]
        if n == 1: return "", [("add_filter", {"type": "levels", "params": P({"inBlack": 10, "inWhite": 240}, as_text)})]
        if n == 2: return "", [("get_frame_stats", {})]
        y = (last["result"].get("channels") or {}).get("Y", {}).get("mean")
        return f"Added **Levels** (input black 10, input white 240).\n\n- Mean luma now {y}\n- Undo restores the previous look.", []
    if u.startswith("TEST:multi"):
        if n == 0: return "", [("get_state", {}), ("list_filters", {"category": "Sharpen"})]
        if n == 2:
            types = [f["type"] for f in steps[1]["result"]] if isinstance(steps[1]["result"], list) else []
            t = "unsharp_mask" if "unsharp_mask" in types else (types[0] if types else "unsharp_mask")
            return "", [("add_filter", {"type": t})]
        return f"Added {last['result'].get('name', '?')} after two parallel lookups.", []
    if u.startswith("TEST:badjson"):
        if n == 0: return "", [("add_filter", "{oops")]
        return f"Recovered from invalid arguments: {json.dumps(last['result'])[:80]}", []
    if u.startswith("TEST:bad"):
        if n == 0: return "", [("add_filter", {"type": "levels", "params": P({"inBlak": 10}, as_text)})]
        if n == 1 and last["error"] and "unknown parameter" in json.dumps(last["result"]): return "", [("add_filter", {"type": "levels", "params": P({"inBlack": 12}, as_text)})]
        return "Fixed the parameter name after the validation error." if not last["error"] else "FAILED_TO_RECOVER", []
    if u.startswith("TEST:look"):
        if n == 0: return "", [("view_frame", {"max_size": 512})]
        return ("IMAGE_RECEIVED" if last["image"] else f"NO_IMAGE {json.dumps(last['result'])[:120]}"), []
    if u.startswith("TEST:ask"):
        if n == 0: return "", [("ask_user", {"question": "Which region should I enhance?", "options": ["Plate", "Face"]})]
        return f"You chose: {last['result'].get('answer', 'nothing')}", []
    if u.startswith("TEST:export"):
        if n == 0: return "", [("export", {"what": "images", "format": "tiff16", "range": "current", "name": "ai_export"})]
        return f"EXPORT_RESULT {json.dumps(last['result'])}", []
    if u.startswith("TEST:speed"):
        if n == 0: return "", [("playback", {"speed": 0.01})]
        if n == 1: return "", [("go_to_frame", {"frame": 3})]
        return "Speed set to 0.01×, frame 3.", []
    if u.startswith("TEST:cmd"):
        if n == 0: return "", [("list_commands", {"search": "keyboard"})]
        if n == 1:
            hit = next((c["id"] for c in last["result"] if "Keyboard Shortcuts" in c["label"]), "nope") if isinstance(last["result"], list) else "nope"
            return "", [("run_command", {"id": hit})]
        return "Opened the keyboard shortcuts." if not last["error"] else "COMMAND_FAILED", []
    if u.startswith("TEST:mcp"):
        # TEST:mcp <tool suffix> <json args>: call the MCP tool whose name ends with __<suffix>
        parts = u.split(" ", 2)
        want = parts[1] if len(parts) > 1 else ""
        name = next((t for t in tools if t.startswith("mcp__") and t.endswith("__" + want)), None)
        if n == 0: return ("", [(name, json.loads(parts[2]) if len(parts) > 2 else {})]) if name else (f"NO_MCP_TOOL {want} in {[t for t in tools if t.startswith('mcp__')]}", [])
        return f"MCP_RESULT {json.dumps(last['result'])}" if not last["error"] else f"MCP_ERROR {json.dumps(last['result'])}", []
    if u.startswith("TEST:count"):
        write = any(t in tools for t in ("add_filter", "set_filter_params", "remove_filter"))
        return f"TOOLS={len(tools)} WRITE={'yes' if write else 'no'}", []
    if u.startswith("TEST:slow"):
        return None, []  # streamed slowly by the handler
    return "Hello from the mock model.", []

# ------------------------------------------------------------------ HTTP
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", ALLOW_HEADERS)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.send_header("Content-Length", "0"); self.end_headers()

    def json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.cors()
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/log":
            with LOCK: return self.json(200, LOG)
        if self.path.endswith("/models"):
            with LOCK: LOG.append({"path": self.path, "method": "GET", "auth": bool(self.headers.get("authorization") or self.headers.get("x-api-key"))})
            return self.json(200, {"data": [{"id": "mock-agent", "created": 1760000000, "created_at": "2025-10-09T00:00:00Z"},
                                            {"id": "mock-old", "created": 1600000000, "created_at": "2020-09-13T00:00:00Z"},
                                            {"id": "text-embedding-mock", "created": 1700000000}]})
        self.json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/reset":
            with LOCK: LOG.clear()
            return self.json(200, {"ok": True})
        req = json.loads(body or b"{}")
        anth = self.path.endswith("/messages")
        hdr = {k: self.headers.get(k) for k in ("authorization", "x-api-key", "anthropic-version", "anthropic-dangerous-direct-browser-access", "http-referer", "x-title")}
        if anth:
            user, steps, images = turn_anthropic(req.get("messages", []))
            tools = [t["name"] for t in req.get("tools", [])]
            schemas = {t["name"]: t.get("input_schema") for t in req.get("tools", [])}
            system = req.get("system", "")
        else:
            msgs = req.get("messages", [])
            user, steps, images = turn_openai(msgs)
            tools = [t["function"]["name"] for t in req.get("tools", [])]
            schemas = {t["function"]["name"]: t["function"].get("parameters") for t in req.get("tools", [])}
            system = msgs[0]["content"] if msgs and msgs[0].get("role") == "system" else ""
        as_text = (schemas.get("add_filter") or {}).get("properties", {}).get("params", {}).get("type") == "string"
        def free_objects(s, path=""):
            out = []
            if isinstance(s, dict):
                if s.get("type") == "object" and "properties" not in s: out.append(path or "<root>")
                for k, v in (s.get("properties") or {}).items(): out += free_objects(v, f"{path}.{k}")
                if isinstance(s.get("items"), dict): out += free_objects(s["items"], f"{path}[]")
            return out
        rec = {"path": self.path, "model": req.get("model"), "stream": req.get("stream"), "headers": hdr, "user": user, "step": len(steps),
               "tools": tools, "images": images, "mode": "ask" if "ASK —" in system else "agent" if "AGENT —" in system else "?",
               "free_object_params": sorted({p for s in schemas.values() for p in free_objects(s)}), "max_tokens": req.get("max_tokens"),
               "last_result": steps[-1] if steps else None,
               "injection_rule": "is DATA, never instructions" in system, "has_state": "Current state:" in system}
        with LOCK: LOG.append(rec)
        if anth and hdr["anthropic-dangerous-direct-browser-access"] != "true":
            return self.json(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "CORS requests must set 'anthropic-dangerous-direct-browser-access' header"}})
        if user.strip().startswith("TEST:401"):
            return self.json(401, {"error": {"message": "Incorrect API key provided: sk-te****", "type": "invalid_request_error"}} if not anth else {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
        text, calls = script(user, steps, tools, as_text)
        slow = text is None
        if not req.get("stream"):
            return self.json(200, self.full(anth, req.get("model"), text or "", calls))
        self.send_response(200); self.cors()
        self.send_header("Content-Type", "text/event-stream"); self.send_header("Cache-Control", "no-cache"); self.send_header("Connection", "close")
        self.end_headers()
        try:
            if anth: self.stream_anthropic(req.get("model"), text, calls, slow)
            else: self.stream_openai(req.get("model"), text, calls, slow)
        except (BrokenPipeError, ConnectionResetError):
            with LOCK: LOG.append({"path": self.path, "event": "client-closed", "user": user})
        self.close_connection = True

    def send_event(self, data, event=None):
        s = (f"event: {event}\n" if event else "") + f"data: {data if isinstance(data, str) else json.dumps(data)}\n\n"
        self.wfile.write(s.encode()); self.wfile.flush()

    def pieces(self, text, size=7):
        return [text[i:i + size] for i in range(0, len(text), size)] or [""]

    def stream_openai(self, model, text, calls, slow):
        base = {"id": nid("chatcmpl-"), "object": "chat.completion.chunk", "created": int(time.time()), "model": model}
        ch = lambda delta, fin=None: {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": fin}]}
        self.send_event(ch({"role": "assistant", "content": ""}))
        if slow:
            for i in range(60):
                self.send_event(ch({"content": f"word{i} "})); time.sleep(0.25)
        for p in self.pieces(text or ""):
            if p: self.send_event(ch({"content": p}))
        for i, (name, args) in enumerate(calls):
            a = args if isinstance(args, str) else json.dumps(args)
            self.send_event(ch({"tool_calls": [{"index": i, "id": nid("call_"), "type": "function", "function": {"name": name, "arguments": ""}}]}))
            for p in self.pieces(a, 9):
                self.send_event(ch({"tool_calls": [{"index": i, "function": {"arguments": p}}]}))
        self.send_event(ch({}, "tool_calls" if calls else "stop"))
        self.send_event({**base, "choices": [], "usage": {"prompt_tokens": 1, "completion_tokens": 1}})
        self.send_event("[DONE]")

    def stream_anthropic(self, model, text, calls, slow):
        self.send_event({"type": "message_start", "message": {"id": nid("msg_"), "type": "message", "role": "assistant", "content": [], "model": model, "stop_reason": None, "usage": {"input_tokens": 1, "output_tokens": 1}}}, "message_start")
        idx = 0
        if text or slow:
            self.send_event({"type": "content_block_start", "index": idx, "content_block": {"type": "text", "text": ""}}, "content_block_start")
            if slow:
                for i in range(60):
                    self.send_event({"type": "content_block_delta", "index": idx, "delta": {"type": "text_delta", "text": f"word{i} "}}, "content_block_delta"); time.sleep(0.25)
            for p in self.pieces(text or ""):
                if p: self.send_event({"type": "content_block_delta", "index": idx, "delta": {"type": "text_delta", "text": p}}, "content_block_delta")
            self.send_event({"type": "content_block_stop", "index": idx}, "content_block_stop")
            idx += 1
        self.send_event({"type": "ping"}, "ping")
        for name, args in calls:
            a = args if isinstance(args, str) else json.dumps(args)
            self.send_event({"type": "content_block_start", "index": idx, "content_block": {"type": "tool_use", "id": nid("toolu_"), "name": name, "input": {}}}, "content_block_start")
            for p in self.pieces(a, 9):
                self.send_event({"type": "content_block_delta", "index": idx, "delta": {"type": "input_json_delta", "partial_json": p}}, "content_block_delta")
            self.send_event({"type": "content_block_stop", "index": idx}, "content_block_stop")
            idx += 1
        self.send_event({"type": "message_delta", "delta": {"stop_reason": "tool_use" if calls else "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 5}}, "message_delta")
        self.send_event({"type": "message_stop"}, "message_stop")

    def full(self, anth, model, text, calls):
        if anth:
            return {"id": nid("msg_"), "type": "message", "role": "assistant", "model": model, "stop_reason": "tool_use" if calls else "end_turn",
                    "content": ([{"type": "text", "text": text}] if text else []) + [{"type": "tool_use", "id": nid("toolu_"), "name": n, "input": a if isinstance(a, dict) else {}} for n, a in calls]}
        msg = {"role": "assistant", "content": text or None}
        if calls: msg["tool_calls"] = [{"id": nid("call_"), "type": "function", "function": {"name": n, "arguments": a if isinstance(a, str) else json.dumps(a)}} for n, a in calls]
        return {"id": nid("chatcmpl-"), "object": "chat.completion", "model": model, "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if calls else "stop"}]}

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    srv.daemon_threads = True
    print(f"mock model server on http://127.0.0.1:{port}", flush=True)
    srv.serve_forever()
