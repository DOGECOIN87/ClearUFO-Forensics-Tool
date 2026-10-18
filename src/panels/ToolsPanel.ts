// Tools: pointer/inspector, zoom, histogram, file info, frame analysis, selector, ruler,
// polygon, intensity profile and crosshair.
import type { ViewHandle } from "@danfessler/trellis";
import type { FrameTable, Pt } from "../shared/types";
import type { AppCtx } from "../app/context";
import type { ToolId } from "../app/store";
import { btn, checkBox, selectBox, slider, spinBox } from "../ui/controls";
import { clear, fmtBytes, fmtTime, h, svg } from "../ui/dom";
import { capturePointer, touchText } from "../ui/touch";
import { I } from "../ui/icons";

const TOOLS: { id: ToolId; name: string; icon: string }[] = [
  { id: "pointer", name: "Pointer", icon: I.pointer },
  { id: "zoom", name: "Zoom", icon: I.zoom },
  { id: "histogram", name: "Histogram", icon: I.histogram },
  { id: "fileinfo", name: "File Info", icon: I.fileInfo },
  { id: "clock", name: "Frame Analysis", icon: I.clock },
  { id: "selector", name: "Selector", icon: I.selector },
  { id: "ruler", name: "Ruler", icon: I.ruler },
  { id: "polygon", name: "Polygon", icon: I.polygon },
  { id: "curve", name: "Intensity Profile", icon: I.curve },
  { id: "crosshair", name: "Crosshair", icon: I.crosshair },
];

const ZOOMS = [6.25, 12.5, 25, 33.3, 50, 66.7, 100, 150, 200, 300, 400, 800, 1600, 3200];
const FT_COLORS = ["#8a8f99", "#ff4b4b", "#3d8bff", "#3ad16b", "#c58cff"];

export class ToolsPanel {
  el: HTMLElement;
  private bar: HTMLElement;
  private body: HTMLElement;
  private update: (() => void) | null = null;
  private table: FrameTable | null = null;
  private tableSource: string | null = null;

  constructor(private ctx: AppCtx, private view: ViewHandle) {
    this.bar = h("div", { class: "tool-bar" });
    this.body = h("div", { class: "tool-body" });
    this.el = h("div", { class: "panel tools-panel" }, this.bar, this.body);
    for (const t of TOOLS) {
      const b = h("button", { class: "tool-btn", title: t.name, "aria-label": t.name, dataset: { tool: t.id } }, svg(t.icon));
      b.addEventListener("click", () => ctx.store.setUi({ tool: t.id }));
      this.bar.appendChild(b);
    }
    const s = ctx.store;
    ctx.bus.on("layout", () => this.updateTitle());
    s.on("ui", (k) => {
      if (k.has("tool")) this.build();
      else if (k.has("cursor") || k.has("selection") || k.has("ruler") || k.has("polygon") || k.has("profile") || k.has("crosshair") || k.has("frame") || k.has("histChannel")) this.update?.();
      if (k.has("chainId")) this.build();
    });
    s.on("rendered", () => this.update?.());
    s.on("sources", () => { this.tableSource = null; if (s.ui.tool === "fileinfo" || s.ui.tool === "clock") this.build(); });
    ctx.bus.on("zoom", () => { if (s.ui.tool === "zoom") this.update?.(); });
    ctx.bus.on("view", () => { if (s.ui.tool === "zoom") this.update?.(); });
    ctx.engine.on("source", (info) => { if (info.id === this.tableSource) { this.tableSource = null; if (s.ui.tool === "clock") this.build(); } });
    this.build();
  }

  /** Full title on the desktop; the compact layouts' tab group needs a short one. */
  private updateTitle() {
    const tool = TOOLS.find((t) => t.id === this.ctx.store.ui.tool);
    this.view.setTitle(document.documentElement.dataset.layout && document.documentElement.dataset.layout !== "desktop" ? "Tools" : `Tools (${tool?.name ?? ""})`);
  }

  private build() {
    const s = this.ctx.store;
    const tool = TOOLS.find((t) => t.id === s.ui.tool)!;
    this.updateTitle();
    this.bar.querySelectorAll<HTMLElement>(".tool-btn").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool.id));
    clear(this.body);
    this.update = null;
    const fn = (this as unknown as Record<string, () => void>)[`build_${tool.id}`];
    fn.call(this);
    (this.update as (() => void) | null)?.();
  }

  private row(label: string, value: HTMLElement | string) { return h("div", { class: "kv" }, h("span", { class: "kv-k" }, label), typeof value === "string" ? h("span", { class: "kv-v" }, value) : value); }

  // ------------------------------------------------------------ pointer (inspector)
  build_pointer() {
    const v = (id: string) => h("span", { class: "kv-v mono", dataset: { k: id } }, "—");
    const grid = h("div", { class: "insp-grid" },
      h("span", null, "x:"), v("x"), h("span", null, "y:"), v("y"),
      h("span", null, "R:"), v("r"), h("span", null, "G:"), v("g"),
      h("span", null, "B:"), v("b"), h("span", null, "Y:"), v("Y"));
    const swatch = h("div", { class: "insp-swatch" });
    const det = h("fieldset", { class: "group" }, h("legend", null, "Details"));
    const dv = (k: string) => { const e = h("span", { class: "kv-v mono" }, "—"); det.appendChild(this.row(k, e)); return e; };
    const pos = dv("Position"), ft = dv("Frame Type"), ts = dv("Timestamp"), wd = dv("Width"), hg = dv("Height"), ty = dv("Type"), hs = dv("Hash (MD5)");
    hs.classList.add("copyable");
    hs.addEventListener("click", () => { const r = this.ctx.store.lastRender; if (r?.md5) void navigator.clipboard?.writeText(r.md5).then(() => this.ctx.store.status("Frame MD5 copied to the clipboard.")); });
    this.body.append(h("div", { class: "insp" }, grid, swatch), det);
    this.update = () => {
      const s = this.ctx.store, c = s.ui.cursor, r = s.lastRender;
      const set = (k: string, t: string) => { const e = grid.querySelector<HTMLElement>(`[data-k="${k}"]`); if (e) e.textContent = t; };
      if (c) { set("x", c.x.toFixed(1)); set("y", c.y.toFixed(1)); } else { set("x", "—"); set("y", "—"); }
      if (c?.rgba) {
        const [R, G, B] = c.rgba;
        set("r", String(R)); set("g", String(G)); set("b", String(B)); set("Y", (0.299 * R + 0.587 * G + 0.114 * B).toFixed(1));
        swatch.style.background = `rgb(${R},${G},${B})`;
      } else { for (const k of ["r", "g", "b", "Y"]) set(k, "—"); swatch.style.background = "transparent"; }
      if (r) {
        pos.textContent = String(r.frame);
        ft.textContent = r.meta.type && r.meta.type !== "?" ? r.meta.type : "—";
        ts.textContent = r.meta.pts !== undefined ? fmtTime(r.meta.pts) : "—";
        wd.textContent = String(r.width); hg.textContent = String(r.height);
        let gray = true;
        for (let i = 0; i < Math.min(r.rgba.length, 400000); i += 16) if (r.rgba[i] !== r.rgba[i + 1] || r.rgba[i + 1] !== r.rgba[i + 2]) { gray = false; break; }
        ty.textContent = gray ? "Grayscale (8-bit/ch)" : "Color RGB (8-bit/ch)";
        hs.textContent = r.md5 ? `${r.md5.slice(0, 4)}...${r.md5.slice(-4)}` : s.prefs.frameHash ? "(paused)" : "(disabled)";
        hs.title = r.md5 ? `MD5 of the ${r.width}x${r.height} 8-bit RGB frame buffer:\n${r.md5}\n(click to copy)` : "";
      }
    };
  }

  // ------------------------------------------------------------ zoom
  build_zoom() {
    const viewer = () => this.ctx.viewer();
    const sel = selectBox(ZOOMS.map((z) => [String(z), `${z}%`]), "100", (v) => viewer()?.setZoom(+v / 100));
    sel.classList.add("zoom-sel");
    const fitCb = checkBox("Fit Window", true, (on) => { if (on) viewer()?.fit(); else viewer()?.setZoom(viewer()!.zoom); });
    const sl = slider({ min: 0.0625, max: 32, value: 1, log: true, labels: false, ticks: 8, onInput: (v) => viewer()?.setZoom(v) });
    const nav = h("canvas", { class: "navigator", width: "240", height: "160" });
    const pct = h("span", { class: "kv-v mono" }, "100%");
    this.body.append(
      h("div", { class: "tool-row" }, h("span", null, "Zoom:"), sel, btn("+", () => viewer()?.setZoom(viewer()!.zoom * 1.25), "btn sq"), btn("−", () => viewer()?.setZoom(viewer()!.zoom / 1.25), "btn sq"), btn("100", () => viewer()?.setZoom(1), "btn sm")),
      h("div", { class: "tool-row" }, fitCb.el, h("span", { class: "flex1" }), pct),
      sl.el, nav, h("div", { class: "muted small" }, touchText("Click or drag on the navigator to move the view. Mouse wheel on the Viewer zooms around the cursor.")));
    const navTo = (e: PointerEvent) => {
      const v = viewer(), r = this.ctx.store.lastRender;
      if (!v || !r) return;
      const b = nav.getBoundingClientRect();
      const k = Math.min(nav.width / r.width, nav.height / r.height);
      const ox = (nav.width - r.width * k) / 2, oy = (nav.height - r.height * k) / 2;
      const sx = ((e.clientX - b.left) * nav.width) / b.width, sy = ((e.clientY - b.top) * nav.height) / b.height;
      v.centerOn({ x: (sx - ox) / k, y: (sy - oy) / k });
    };
    nav.addEventListener("pointerdown", (e) => { capturePointer(nav, e.pointerId); navTo(e); });
    nav.addEventListener("pointermove", (e) => { if (e.buttons) navTo(e); });
    this.update = () => {
      const v = viewer(), r = this.ctx.store.lastRender;
      if (!v) return;
      const z = v.zoom * 100;
      pct.textContent = `${z.toFixed(2)}%`;
      fitCb.set(v.isFit);
      sl.set(v.zoom);
      const near = ZOOMS.reduce((a, b) => (Math.abs(b - z) < Math.abs(a - z) ? b : a));
      sel.value = String(near);
      const c = nav.getContext("2d")!;
      c.fillStyle = "#0b0d12"; c.fillRect(0, 0, nav.width, nav.height);
      if (!r) return;
      const k = Math.min(nav.width / r.width, nav.height / r.height);
      const ox = (nav.width - r.width * k) / 2, oy = (nav.height - r.height * k) / 2;
      c.imageSmoothingQuality = "high";
      c.drawImage(v.frameCanvasEl(), ox, oy, r.width * k, r.height * k);
      const vp = v.viewport();
      if (vp) { c.strokeStyle = "#ff3030"; c.lineWidth = 1.5; c.strokeRect(ox + vp.x * k, oy + vp.y * k, vp.w * k, vp.h * k); }
    };
  }

  // ------------------------------------------------------------ histogram
  build_histogram() {
    const s = this.ctx.store;
    const sat = checkBox("Show Saturated Pixels", s.ui.showSaturated, (v) => s.setUi({ showSaturated: v }));
    const ch = selectBox([["all", "All"], ["y", "Luminance (Y)"], ["r", "Red"], ["g", "Green"], ["b", "Blue"]], s.ui.histChannel, (v) => s.setUi({ histChannel: v as any }));
    const cv = h("canvas", { class: "hist-canvas", width: "512", height: "300" });
    const stats = h("table", { class: "stats" });
    const satInfo = h("div", { class: "muted small" });
    this.body.append(sat.el, h("fieldset", { class: "group" }, h("legend", null, "Histogram"), h("div", { class: "tool-row" }, h("span", null, "Channel:"), ch), cv, stats, satInfo));
    if (!s.lastRender?.hist) this.ctx.viewer()?.requestRender();
    this.update = () => {
      const r = s.lastRender;
      const c = cv.getContext("2d")!;
      const W = cv.width, H = cv.height;
      c.fillStyle = "#8fa3bd"; c.fillRect(0, 0, W, H);
      c.strokeStyle = "rgba(255,255,255,0.55)"; c.lineWidth = 1;
      for (let i = 1; i < 5; i++) { c.beginPath(); c.moveTo((i * W) / 5, 0); c.lineTo((i * W) / 5, H); c.moveTo(0, (i * H) / 5); c.lineTo(W, (i * H) / 5); c.stroke(); }
      if (!r?.hist) { stats.innerHTML = ""; return; }
      const sel = s.ui.histChannel;
      const chans = sel === "all" ? [0, 1, 2] : sel === "y" ? [3] : [{ r: 0, g: 1, b: 2 }[sel]!];
      const cols = ["#ff1e1e", "#16e016", "#1e3cff", "#30343c"];
      let mx = 1;
      for (const k of chans) for (let v = 1; v < 255; v++) mx = Math.max(mx, r.hist[k * 256 + v]);
      for (const k of chans) {
        c.beginPath();
        c.moveTo(0, H);
        for (let v = 0; v < 256; v++) c.lineTo((v / 255) * W, H - Math.min(1, r.hist[k * 256 + v] / mx) * (H - 4));
        c.lineTo(W, H);
        c.closePath();
        c.fillStyle = chans.length === 1 ? "rgba(40,60,110,0.55)" : "rgba(40,60,110,0.18)";
        c.fill();
        c.strokeStyle = cols[k]; c.lineWidth = 2.2;
        c.beginPath();
        for (let v = 0; v < 256; v++) { const x = (v / 255) * W, y = H - Math.min(1, r.hist[k * 256 + v] / mx) * (H - 4); v ? c.lineTo(x, y) : c.moveTo(x, y); }
        c.stroke();
      }
      const st = r.stats!;
      const show = sel === "all" ? [0, 1, 2] : chans;
      const md5 = (k: number) => (k < 3 && r.chMd5 ? `..${r.chMd5[k].slice(-4)}` : "—");
      const row = (name: string, fn: (k: number) => string) => `<tr><th>${name}</th>${show.map((k) => `<td>${fn(k)}</td>`).join("")}</tr>`;
      stats.innerHTML = row("Min:", (k) => String(st[k].min)) + row("Max:", (k) => String(st[k].max)) + row("Mean:", (k) => st[k].mean.toFixed(0)) + row("StdDev:", (k) => st[k].std.toFixed(0)) + row("MD5 Hash:", md5);
      stats.title = r.chMd5 ? `MD5 per channel\nR: ${r.chMd5[0]}\nG: ${r.chMd5[1]}\nB: ${r.chMd5[2]}` : "";
      const total = r.width * r.height;
      satInfo.textContent = r.saturated ? `Clipped: ${((r.saturated.high / total) * 100).toFixed(2)}% at 255, ${((r.saturated.low / total) * 100).toFixed(2)}% at 0` : "";
    };
  }

  // ------------------------------------------------------------ file info
  build_fileinfo() {
    const s = this.ctx.store, c = s.chain();
    const sid = c?.filters[0]?.params?.source;
    const info = sid ? s.sources.get(sid) : undefined;
    if (!info) {
      this.body.append(h("div", { class: "muted pad" }, c ? (c.filters[0]?.type === "test_pattern" ? "Synthetic test pattern (no file)." : "The media file of the current chain is not loaded.") : "No chain."));
      const live = h("div");
      this.body.append(live);
      this.update = () => { const r = s.lastRender; clear(live); if (r) live.append(this.row("Stream", `${r.info.width} x ${r.info.height}, ${r.info.frameCount} frames, ${r.info.fps.toFixed(3)} fps`)); };
      return;
    }
    const table = this.ctx.actions.sourceInfoTable(info);
    const copy = btn("Copy to Clipboard", () => {
      const txt = [...table.querySelectorAll("tr")].map((tr) => [...tr.children].map((td) => td.textContent).join("\t")).join("\n");
      void navigator.clipboard?.writeText(txt).then(() => s.status("File information copied to the clipboard."));
    }, "btn sm");
    const hashB = btn("Compute Hashes", () => void this.ctx.actions.hashSource(info.id), "btn sm");
    this.body.append(h("div", { class: "tool-row" }, copy, hashB), table);
  }

  // ------------------------------------------------------------ frame analysis (GOP)
  build_clock() {
    const s = this.ctx.store, c = s.chain();
    const sid = c?.filters[0]?.params?.source;
    const info = sid ? s.sources.get(sid) : undefined;
    if (!info) { this.body.append(h("div", { class: "muted pad" }, "Frame analysis is available for chains loaded from a video file.")); return; }
    const summary = h("div", { class: "fa-summary" }, "Loading frame table…");
    const chart = h("canvas", { class: "fa-chart", width: "520", height: "150" });
    const legend = h("div", { class: "fa-legend" }, ...["I", "P", "B"].map((t, i) => h("span", null, h("i", { style: { background: FT_COLORS[i + 1] } }), `${t} frames`)));
    const tbl = h("table", { class: "fa-table" });
    this.body.append(summary, chart, legend, tbl);
    const load = async () => {
      if (this.tableSource !== sid) {
        this.table = await this.ctx.engine.call<FrameTable | null>("frameTable", sid);
        this.tableSource = sid;
      }
      this.update?.();
    };
    let hoverIdx = -1;
    chart.addEventListener("pointermove", (e) => { const t = this.table; if (!t) return; const b = chart.getBoundingClientRect(); hoverIdx = Math.floor(((e.clientX - b.left) / b.width) * t.count); this.update?.(); });
    chart.addEventListener("pointerleave", () => { hoverIdx = -1; this.update?.(); });
    chart.addEventListener("click", (e) => {
      const t = this.table;
      if (!t) return;
      const b = chart.getBoundingClientRect();
      const i = Math.floor(((e.clientX - b.left) / b.width) * t.count);
      if (c && c.filters.length === 1) s.setFrame(i);
      else s.status(`Source frame ${i}: select the loader in History to navigate source frames.`);
    });
    this.update = () => {
      const t = this.table;
      if (!t) return;
      const n = t.count;
      const counts = [0, 0, 0, 0, 0];
      let total = 0, maxB = 1, keys = 0, sumI = 0, sumP = 0, sumB = 0;
      for (let i = 0; i < n; i++) { counts[t.types[i]]++; total += t.bytes[i]; maxB = Math.max(maxB, t.bytes[i]); if (t.types[i] === 1) { keys++; sumI += t.bytes[i]; } else if (t.types[i] === 2) sumP += t.bytes[i]; else if (t.types[i] === 3) sumB += t.bytes[i]; }
      const gops: number[] = [];
      let last = -1;
      for (let i = 0; i < n; i++) if (t.types[i] === 1) { if (last >= 0) gops.push(i - last); last = i; }
      const avgGop = gops.length ? gops.reduce((a, b) => a + b, 0) / gops.length : n;
      const dts: number[] = [];
      for (let i = 1; i < n; i++) dts.push(t.pts[i] - t.pts[i - 1]);
      const dmin = dts.length ? Math.min(...dts) : 0, dmax = dts.length ? Math.max(...dts) : 0;
      const dup = dts.filter((d) => d <= 1e-6).length;
      summary.innerHTML = `<b>${n}</b> frames — I: <b>${counts[1]}</b>, P: <b>${counts[2]}</b>, B: <b>${counts[3]}</b>${counts[0] ? `, unknown: ${counts[0]}` : ""}${t.ready ? "" : " <span class='muted'>(analysis in progress…)</span>"}<br>` +
        `GOP: avg ${avgGop.toFixed(1)}, min ${gops.length ? Math.min(...gops) : "—"}, max ${gops.length ? Math.max(...gops) : "—"} · Data ${fmtBytes(total)}<br>` +
        `Avg size I ${fmtBytes(Math.round(sumI / Math.max(1, counts[1])))}, P ${fmtBytes(Math.round(sumP / Math.max(1, counts[2])))}${counts[3] ? `, B ${fmtBytes(Math.round(sumB / Math.max(1, counts[3])))}` : ""}<br>` +
        `Frame interval: ${(dmin * 1000).toFixed(2)}–${(dmax * 1000).toFixed(2)} ms${dmax - dmin > 0.002 ? " <span class='warn'>(variable)</span>" : " (constant)"}${dup ? ` · <span class='warn'>${dup} duplicate timestamps</span>` : ""}`;
      const g = chart.getContext("2d")!;
      const W = chart.width, H = chart.height;
      g.fillStyle = "#0e1118"; g.fillRect(0, 0, W, H);
      const bw = W / n;
      for (let i = 0; i < n; i++) {
        const v = t.bytes[i] / maxB;
        g.fillStyle = FT_COLORS[t.types[i]] ?? FT_COLORS[0];
        g.fillRect(i * bw, H - v * (H - 6), Math.max(1, bw - (bw > 3 ? 1 : 0)), v * (H - 6));
      }
      const r = s.lastRender;
      const cur = r && c && c.filters.length >= 1 ? r.meta.src ?? r.frame : -1;
      if (cur >= 0) { g.fillStyle = "#ffd400"; g.fillRect(cur * bw - 0.5, 0, Math.max(1.5, bw), H); }
      if (hoverIdx >= 0 && hoverIdx < n) { g.fillStyle = "rgba(255,255,255,0.5)"; g.fillRect(hoverIdx * bw, 0, Math.max(1, bw), H); }
      const center = hoverIdx >= 0 ? hoverIdx : Math.max(0, cur);
      const a = Math.max(0, center - 6), b = Math.min(n - 1, center + 6);
      let rows = "<tr><th>Frame</th><th>Type</th><th>PTS</th><th>Size</th></tr>";
      for (let i = a; i <= b; i++) rows += `<tr class="${i === cur ? "cur" : ""}"><td>${i}</td><td style="color:${FT_COLORS[t.types[i]]}">${"?IPBS"[t.types[i]]}</td><td>${fmtTime(t.pts[i])}</td><td>${fmtBytes(t.bytes[i])}</td></tr>`;
      tbl.innerHTML = rows;
    };
    void load();
  }

  // ------------------------------------------------------------ selector
  build_selector() {
    const s = this.ctx.store;
    const mk = (k: "x" | "y" | "w" | "h") => spinBox({ value: 0, min: 0, max: 100000, width: 92, onChange: (v) => { const r = s.ui.selection ?? { x: 0, y: 0, w: 0, h: 0 }; s.setUi({ selection: { ...r, [k]: v } }); } });
    const sx = mk("x"), sy = mk("y"), sw = mk("w"), sh = mk("h");
    const grid = h("div", { class: "sel-grid" }, h("span", null, "x:"), sx.el, h("span", null, "y:"), sy.el, h("span", null, "w:"), sw.el, h("span", null, "h:"), sh.el);
    const v = () => this.ctx.viewer();
    this.body.append(grid,
      h("div", { class: "btn-grid" },
        btn("Select All", () => { const r = s.lastRender; if (r) s.setUi({ selection: { x: 0, y: 0, w: r.width, h: r.height } }); }),
        btn("Deselect", () => s.setUi({ selection: null })),
        btn("Zoom", () => { if (s.ui.selection) v()?.zoomToRect(s.ui.selection); }),
        btn("Center", () => { const r = s.ui.selection; if (r) v()?.centerOn({ x: r.x + r.w / 2, y: r.y + r.h / 2 }); })),
      h("div", { class: "btn-grid" }, btn("Crop to Selection", () => { if (s.ui.selection) this.ctx.actions.addFilter("crop", { rect: { ...s.ui.selection } }); }), btn("Hide Selection", () => { if (s.ui.selection) this.ctx.actions.addFilter("hide_selection", { rect: { ...s.ui.selection } }); })),
      h("div", { class: "muted small pad" }, "Drag on the Viewer to select a region. The selection can be used by filters (Crop, Hide Selection, Local Stabilization…)."));
    this.update = () => { const r = s.ui.selection ?? { x: 0, y: 0, w: 0, h: 0 }; sx.set(r.x); sy.set(r.y); sw.set(r.w); sh.set(r.h); };
  }

  // ------------------------------------------------------------ ruler
  build_ruler() {
    const s = this.ctx.store;
    const out = h("div", { class: "kvs" });
    this.body.append(out, h("div", { class: "btn-grid" }, btn("Clear", () => s.setUi({ ruler: null })), btn("Use in Measure 1D", () => { if (s.ui.ruler) this.ctx.actions.addFilter("measure_1d", { refLine: s.ui.ruler }); })), h("div", { class: "muted small pad" }, "Drag on the Viewer to measure distances in pixels. Use Measure 1D/2D filters for calibrated measurements."));
    this.update = () => {
      clear(out);
      const l = s.ui.ruler;
      if (!l) { out.append(h("div", { class: "muted" }, "No measurement.")); return; }
      const dx = l[1].x - l[0].x, dy = l[1].y - l[0].y;
      out.append(this.row("Point 1", `${l[0].x.toFixed(1)}, ${l[0].y.toFixed(1)}`), this.row("Point 2", `${l[1].x.toFixed(1)}, ${l[1].y.toFixed(1)}`), this.row("Δx, Δy", `${dx.toFixed(1)}, ${dy.toFixed(1)}`), this.row("Length", `${Math.hypot(dx, dy).toFixed(2)} px`), this.row("Angle", `${((Math.atan2(-dy, dx) * 180) / Math.PI).toFixed(2)}°`));
    };
  }

  // ------------------------------------------------------------ polygon
  build_polygon() {
    const s = this.ctx.store;
    const out = h("div", { class: "kvs" });
    this.body.append(out, h("div", { class: "btn-grid" }, btn("Undo Point", () => s.setUi({ polygon: s.ui.polygon.slice(0, -1) })), btn("Clear", () => s.setUi({ polygon: [] }))), h("div", { class: "muted small pad" }, touchText("Click on the Viewer to add vertices. Area and perimeter are computed in pixels.")));
    this.update = () => {
      clear(out);
      const p = s.ui.polygon;
      let area = 0, per = 0;
      for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; area += a.x * b.y - b.x * a.y; if (i < p.length - 1 || p.length > 2) per += Math.hypot(b.x - a.x, b.y - a.y); }
      out.append(this.row("Vertices", String(p.length)), this.row("Perimeter", `${per.toFixed(2)} px`), this.row("Area", `${(Math.abs(area) / 2).toFixed(1)} px²`));
    };
  }

  // ------------------------------------------------------------ intensity profile
  build_curve() {
    const s = this.ctx.store;
    const cv = h("canvas", { class: "profile-canvas", width: "520", height: "220" });
    const info = h("div", { class: "muted small" });
    this.body.append(cv, info, h("div", { class: "btn-grid" }, btn("Clear", () => s.setUi({ profile: null }))), h("div", { class: "muted small pad" }, "Drag a line on the Viewer to plot the R, G, B values along it."));
    this.update = () => {
      const g = cv.getContext("2d")!, W = cv.width, H = cv.height;
      g.fillStyle = "#0e1118"; g.fillRect(0, 0, W, H);
      g.strokeStyle = "rgba(255,255,255,0.08)";
      for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, (i * H) / 4); g.lineTo(W, (i * H) / 4); g.stroke(); }
      const l = s.ui.profile, r = s.lastRender;
      if (!l || !r) { info.textContent = ""; return; }
      const len = Math.hypot(l[1].x - l[0].x, l[1].y - l[0].y), n = Math.max(2, Math.round(len));
      const vals: number[][] = [[], [], []];
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const x = Math.round(l[0].x + (l[1].x - l[0].x) * t), y = Math.round(l[0].y + (l[1].y - l[0].y) * t);
        if (x < 0 || y < 0 || x >= r.width || y >= r.height) { vals.forEach((v) => v.push(NaN)); continue; }
        const k = (y * r.width + x) * 4;
        vals[0].push(r.rgba[k]); vals[1].push(r.rgba[k + 1]); vals[2].push(r.rgba[k + 2]);
      }
      ["#ff3b3b", "#36d16a", "#4a8dff"].forEach((col, ci) => {
        g.strokeStyle = col; g.lineWidth = 1.6; g.beginPath();
        vals[ci].forEach((v, i) => { const x = (i / (n - 1)) * W, y = H - (v / 255) * (H - 4) - 2; if (isNaN(v)) return; i ? g.lineTo(x, y) : g.moveTo(x, y); });
        g.stroke();
      });
      info.textContent = `${n} samples along ${len.toFixed(1)} px`;
    };
  }

  // ------------------------------------------------------------ crosshair
  build_crosshair() {
    const s = this.ctx.store;
    const out = h("div", { class: "kvs" });
    this.body.append(out, h("div", { class: "btn-grid" }, btn("Clear", () => s.setUi({ crosshair: null }))), h("div", { class: "muted small pad" }, touchText("Move over the Viewer to show the crosshair; click to lock it (useful to compare positions across frames).")));
    this.update = () => {
      clear(out);
      const c: Pt | null = s.ui.crosshair ?? (s.ui.cursor ? { x: s.ui.cursor.x, y: s.ui.cursor.y } : null);
      out.append(this.row("Locked", s.ui.crosshair ? "Yes" : "No"), this.row("Position", c ? `${c.x.toFixed(1)}, ${c.y.toFixed(1)}` : "—"));
    };
  }
}
