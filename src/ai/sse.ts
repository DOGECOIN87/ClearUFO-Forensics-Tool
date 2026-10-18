// Server-Sent Events parser (WHATWG "event stream interpretation"): works on any chunking of the byte
// stream, CRLF / LF / CR line endings, multi-line data, comments and a final event without a blank line.

export interface SseEvent { event: string; data: string }

export class SseParser {
  private buf = "";
  private event = "";
  private data: string[] = [];

  /** Feed decoded text; returns the events completed by it. */
  push(text: string): SseEvent[] {
    this.buf += text;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buf);
      if (!m) break;
      // a lone CR at the very end may be the first half of a CRLF split across chunks
      if (m[0] === "\r" && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      this.line(line, out);
    }
    return out;
  }

  /** End of stream: dispatch what is pending. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf) { this.line(this.buf, out); this.buf = ""; }
    this.line("", out);
    return out;
  }

  private line(line: string, out: SseEvent[]) {
    if (line === "") {
      if (this.data.length) out.push({ event: this.event || "message", data: this.data.join("\n") });
      this.event = ""; this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const c = line.indexOf(":");
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? "" : line.slice(c + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
  }
}

/** Events of a fetch() response body. */
export async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const p = new SseParser();
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of p.push(dec.decode(value, { stream: true }))) yield ev;
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    for (const ev of p.push(dec.decode())) yield ev;
    for (const ev of p.end()) yield ev;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
