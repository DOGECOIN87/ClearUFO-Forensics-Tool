// A small, safe Markdown renderer for the assistant's answers: DOM nodes built with textContent only (no
// innerHTML, so nothing in a model's answer can inject markup). Paragraphs, headings, lists, code blocks,
// inline code, bold, italics and http(s) links.

function inline(text: string, parent: HTMLElement) {
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    let el: HTMLElement;
    if (m[1]) { el = document.createElement("code"); el.textContent = t.slice(1, -1); }
    else if (m[2] || m[3]) { el = document.createElement("strong"); inline(t.slice(2, -2), el); }
    else if (m[4]) { el = document.createElement("em"); inline(t.slice(1, -1), el); }
    else {
      const a = document.createElement("a");
      a.href = m[6]; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.textContent = t.slice(1, t.indexOf("]("));
      el = a;
    }
    parent.appendChild(el);
    last = m.index + t.length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

export function renderMarkdown(src: string): DocumentFragment {
  const out = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const p = document.createElement("p");
    para.forEach((l, k) => { if (k) p.appendChild(document.createElement("br")); inline(l, p); });
    out.appendChild(p);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      const pre = document.createElement("pre"), c = document.createElement("code");
      c.textContent = code.join("\n");
      pre.appendChild(c);
      out.appendChild(pre);
      continue;
    }
    const hd = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hd) {
      flush();
      const h = document.createElement(hd[1].length <= 2 ? "h4" : "h5");
      inline(hd[2], h);
      out.appendChild(h);
      i++;
      continue;
    }
    const li = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (i < lines.length) {
        const m = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        const item = document.createElement("li");
        inline(m[2], item);
        list.appendChild(item);
        i++;
        // continuation lines (indented, not a new item)
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) { item.appendChild(document.createTextNode(" ")); inline(lines[i].trim(), item); i++; }
      }
      out.appendChild(list);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line);
    i++;
  }
  flush();
  return out;
}
