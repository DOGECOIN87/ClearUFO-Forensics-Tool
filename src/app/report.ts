// Forensic processing report (self-contained HTML, printable to PDF).
import { encodePNG, rgbFromRGBA } from "../shared/codecs/image";
import { BRAND } from "../brand";
import { FILTERS, formatParam } from "../shared/filters";
import { logoSvg } from "../ui/icons";
import { fmtBytes, fmtTime } from "../ui/dom";
import type { AppCtx } from "./context";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function base64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

async function snap(ctx: AppCtx, chainId: string, filterId: string | null, frame: number, max = 560, lossless = false): Promise<string | null> {
  const r = await ctx.engine.call<{ w: number; h: number; rgba: Uint8ClampedArray } | null>("snapshot", chainId, filterId, frame, max);
  if (!r) return null;
  // lossless: an uncompressed PNG written directly from the engine's pixels (no canvas, no compression)
  if (lossless) return `data:image/png;base64,${base64(encodePNG(r.w, r.h, rgbFromRGBA(r.rgba, r.w, r.h)))}`;
  const c = document.createElement("canvas");
  c.width = r.w; c.height = r.h;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.w, r.h), 0, 0);
  return c.toDataURL("image/jpeg", 0.92);
}

export async function buildReport(ctx: AppCtx, progress: (label: string, v: number) => void): Promise<string> {
  const s = ctx.store, p = s.project;
  const now = new Date();
  // Lossless-only: every image at full resolution as an uncompressed PNG (pixel values identical to the frames).
  const lossless = s.prefs.losslessOnly;
  const stepSize = lossless ? 0 : 520, finalSize = lossless ? 0 : 940;
  // evidence hashes
  const srcIds = Object.keys(p.sources).filter((id) => p.chains.some((c) => c.filters.some((f) => f.params.source === id || f.params.image === id)));
  let k = 0;
  for (const id of srcIds) {
    const ref = p.sources[id], files = s.files.get(id);
    if (!ref.md5 && files?.length === 1) {
      progress(`Hashing ${ref.name}`, k / Math.max(1, srcIds.length) * 0.4);
      try { Object.assign(ref, await ctx.engine.call("hashFile", files[0], `report-hash-${id}`)); } catch { /* keep without hash */ }
    }
    k++;
  }
  const css = `
  body{font:13px/1.45 "Segoe UI",Roboto,Arial,sans-serif;color:#1d2330;margin:0;background:#eef0f4}
  .page{max-width:980px;margin:24px auto;background:#fff;padding:36px 44px;box-shadow:0 2px 14px rgba(0,0,0,.12)}
  header{display:flex;gap:18px;align-items:center;border-bottom:3px solid #0a6fd6;padding-bottom:14px;margin-bottom:18px}
  header h1{font-size:22px;margin:0}header .sub{color:#5a6475}
  h2{font-size:17px;border-bottom:1px solid #d5dae3;padding-bottom:4px;margin-top:30px;color:#0a3e78}
  h3{font-size:14px;margin:18px 0 6px}
  table{border-collapse:collapse;width:100%;margin:6px 0 10px}th,td{border:1px solid #d5dae3;padding:4px 7px;text-align:left;vertical-align:top}
  th{background:#f2f5f9;font-weight:600}td.mono,.mono{font-family:Consolas,"DejaVu Sans Mono",monospace;font-size:11.5px;word-break:break-all}
  .kv td:first-child{width:200px;background:#f8f9fb;font-weight:600}
  .steps{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px}
  figure{margin:0;border:1px solid #d5dae3;padding:6px;background:#fafbfc;break-inside:avoid}figure img{width:100%;image-rendering:pixelated;display:block;background:#000}
  figcaption{font-size:11.5px;color:#3c4556;margin-top:4px}
  .ref{font-size:11.5px;color:#4b5567}.muted{color:#6b7484}.final img{max-width:100%}
  .disabled{color:#9aa1ad;text-decoration:line-through}
  footer{margin-top:30px;border-top:1px solid #d5dae3;padding-top:10px;font-size:11px;color:#6b7484}
  @media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;padding:0}h2{break-after:avoid}figure,table{break-inside:avoid}}`;
  let html = `<!doctype html><html><head><meta charset="utf-8"><title>Report — ${esc(p.name)}</title><style>${css}</style></head><body><div class="page">`;
  html += `<header>${logoSvg(BRAND.letters, 56)}<div><h1>Forensic Image and Video Processing Report</h1><div class="sub">${esc(BRAND.fullName)} ${esc(BRAND.version)} — ${esc(p.name)}</div></div></header>`;
  const ci = p.caseInfo;
  html += `<h2>1. Case Information</h2><table class="kv">` +
    [["Case Number", ci.caseNumber], ["Exhibit / Item", ci.exhibit], ["Examiner", ci.examiner], ["Agency / Laboratory", ci.agency], ["Notes", ci.notes], ["Report Generated", `${now.toISOString()} (local: ${now.toLocaleString()}, ${Intl.DateTimeFormat().resolvedOptions().timeZone})`], ["Project Created", p.created], ["Project Modified", p.modified], ["Software", `${BRAND.fullName} ${BRAND.version} (build ${BRAND.build})`], ["Environment", navigator.userAgent]]
      .map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b) || '<span class="muted">—</span>'}</td></tr>`).join("") + `</table>`;

  html += `<h2>2. Evidence</h2>`;
  if (!srcIds.length) html += `<p class="muted">No file based evidence (synthetic test material only).</p>`;
  for (const id of srcIds) {
    const ref = p.sources[id], info = s.sources.get(id);
    const rows: [string, string][] = [["Name", ref.name], ["Type", ref.kind], ["Files", ref.files.map((f) => `${f.name} (${fmtBytes(f.size)}, ${f.size} bytes, modified ${new Date(f.lastModified).toISOString()})`).slice(0, 20).join("; ") + (ref.files.length > 20 ? ` … (+${ref.files.length - 20})` : "")]];
    if (ref.md5) rows.push(["MD5", ref.md5], ["SHA-1", ref.sha1 ?? ""], ["SHA-256", ref.sha256 ?? ""]);
    else rows.push(["Hashes", ref.files.length > 1 ? "Not computed (multi-file source)" : "Not available (media not loaded)"]);
    if (info?.conversion) rows.push(["Color Conversion", info.conversion]);
    if (info) rows.push(["Format", `${info.container ?? ""} / ${info.codec ?? ""}`], ["Resolution", `${info.width} x ${info.height}${info.par ? `, PAR ${info.par[0]}:${info.par[1]}` : ""}`], ["Frames", `${info.frameCount} @ ${info.fps.toFixed(4)} fps, duration ${fmtTime(info.duration)}`], ["Decoding", info.engine]);
    html += `<h3>${esc(ref.name)}</h3><table class="kv">${rows.map(([a, b]) => `<tr><td>${esc(a)}</td><td class="${/MD5|SHA/.test(a) ? "mono" : ""}">${esc(b)}</td></tr>`).join("")}</table>`;
  }

  html += `<h2>3. Processing</h2><p>Each chain lists, in order, the filters applied to the evidence with their parameters. Disabled filters are shown struck through and do not contribute to the result. Snapshots show the output of each step at the indicated frame.</p>`;
  let ci2 = 0;
  for (const c of p.chains) {
    const frame = s.ui.frame[c.id] ?? 0;
    html += `<h3>Chain ${++ci2}: ${esc(c.name)}</h3><table><tr><th>#</th><th>Filter</th><th>Category</th><th>Parameters</th></tr>`;
    c.filters.forEach((f, i) => {
      const def = FILTERS[f.type];
      const params = def ? def.params.filter((pd) => !["action", "psf", "info", "fileinfo"].includes(pd.type) && (!pd.show || pd.show(f.params))).map((pd) => `${esc(pd.label)}: <b>${esc(pd.type === "source" || pd.type === "image" ? p.sources[f.params[pd.key]]?.name ?? "—" : formatParam(pd, f.params[pd.key], (id) => s.chain(id)?.name ?? "?"))}</b>`).join("<br>") : "";
      html += `<tr class="${f.enabled || i === 0 ? "" : "disabled"}"><td>${i + 1}</td><td><b>${esc(def?.name ?? f.type)}</b><div class="ref">${esc(def?.description ?? "")}</div>${def?.reference ? `<div class="ref"><i>Ref.:</i> ${esc(def.reference)}</div>` : ""}</td><td>${esc(def?.category ?? "")}</td><td>${params || '<span class="muted">—</span>'}</td></tr>`;
    });
    html += `</table><div class="steps">`;
    for (let i = 0; i < c.filters.length; i++) {
      const f = c.filters[i];
      if (i > 0 && !f.enabled) continue;
      progress(`Rendering ${c.name}: ${FILTERS[f.type]?.name ?? f.type}`, 0.4 + (0.55 * ci2) / p.chains.length);
      const img = await snap(ctx, c.id, f.id, frame, stepSize, lossless);
      html += `<figure>${img ? `<img src="${img}" alt="">` : `<div class="muted">(not available)</div>`}<figcaption>Step ${i + 1}: ${esc(FILTERS[f.type]?.name ?? f.type)} — frame ${frame}</figcaption></figure>`;
    }
    html += `</div>`;
    const fin = await snap(ctx, c.id, null, frame, finalSize, true);
    if (fin) html += `<figure class="final" style="margin-top:12px"><img src="${fin}" alt=""><figcaption>Final output of "${esc(c.name)}" — frame ${frame}</figcaption></figure>`;
  }

  const bms = p.bookmarks.filter((b) => p.chains.some((c) => c.id === b.chainId));
  if (bms.length) {
    html += `<h2>4. Bookmarks</h2><div class="steps">`;
    for (const b of bms) {
      const img = await snap(ctx, b.chainId, null, b.frame, stepSize, lossless);
      html += `<figure>${img ? `<img src="${img}" alt="">` : ""}<figcaption><b>${esc(s.chain(b.chainId)?.name)}</b>, frame ${b.frame}${b.note ? ` — ${esc(b.note)}` : ""}</figcaption></figure>`;
    }
    html += `</div>`;
  }
  let sec = bms.length ? 5 : 4;
  const ai = p.aiLog ?? [];
  if (ai.length) {
    const frames = ai.reduce((k, e) => k + (e.framesShared || 0), 0);
    html += `<h2>${sec}. AI Assistance</h2><p>Requests made to the application's built-in AI assistant during this project, in order, with the model that answered and every action it performed in the application. The assistant works through the same documented filters and parameters as the examiner, and its changes are listed in section 3 like any other step. ${frames ? `${frames} frame image${frames === 1 ? " was" : "s were"} shared with the model.` : "No frame images were shared with the model."}</p>`;
    ai.forEach((e, i) => {
      const acts = e.actions.length ? `<ol>${e.actions.map((a) => `<li>${esc(a.summary)}${a.ok ? "" : ` <i class="muted">(${esc(a.note ?? "not completed")})</i>`}</li>`).join("")}</ol>` : `<span class="muted">No action (answer only)</span>`;
      html += `<h3>Request ${i + 1} — ${esc(new Date(e.time).toISOString())}</h3><table class="kv">` +
        `<tr><td>Model</td><td>${esc(e.provider)} · ${esc(e.model)} <span class="muted">(${esc(e.endpoint)})</span></td></tr>` +
        `<tr><td>Mode</td><td>${e.mode === "agent" ? "Agent (allowed to change the project)" : "Ask (read-only)"}</td></tr>` +
        `<tr><td>Request</td><td>${esc(e.request)}</td></tr>` +
        (e.framesShared ? `<tr><td>Frames shared</td><td>${e.framesShared}</td></tr>` : "") +
        `<tr><td>Actions</td><td>${acts}</td></tr>` +
        (e.reply ? `<tr><td>Answer</td><td>${esc(e.reply)}</td></tr>` : "") + `</table>`;
    });
    sec++;
  }
  html += `<h2>${sec}. Methodology and Integrity</h2><ul>
  <li>The original evidence files are never modified: they are read-only inputs and every operation is non-destructive and repeatable from the saved project.</li>
  <li>Decoding: video frames are indexed in presentation order from the container timestamps; ${srcIds.some((id) => s.sources.get(id)?.browserConversion)
    ? `YUV to RGB conversion uses the color matrix and range stated in the Video Loader settings, except for the evidence whose Color Conversion entry states that the browser converted the frames: there the browser's own conversion applies, which may differ slightly from other software.`
    : "YUV to RGB conversion uses the color matrix and range stated in the Video Loader settings."}</li>
  <li>Processing is performed with 32-bit floating point precision; values are rounded to 8 bits per channel for display. Exports keep 8 or 16 bits per channel, or 32-bit floating point, as chosen${lossless ? ", and are written without compression (lossy formats are disabled); written files are read back and compared frame by frame when verification is on" : ""}.</li>
  <li>${lossless ? "Every image in this report is embedded at full resolution as an uncompressed PNG: its pixel values are identical to the processed frame." : "Images in this report are scaled previews (JPEG), except the final output of each chain (lossless PNG)."}</li>
  <li>Processing filters are computed by the application's own code, independently of the browser's graphics engine (Error Level Analysis uses a built-in JPEG model rather than the browser's encoder). Annotations (text, shapes, borders, grids and measurement labels) are drawn with the browser's 2D canvas, so their edge smoothing and fonts may differ slightly between browsers.</li>
  <li>Frame hashes (MD5) are computed on the 8-bit RGB buffer of the displayed frame; file hashes (MD5, SHA-1, SHA-256) on the complete evidence files.</li>
  <li>Proprietary DVR files converted with "Convert DVR" are remuxed (stream copy) without re-encoding.</li>${ai.length ? `
  <li>Some operations were carried out through the AI assistant at the examiner's request (section ${sec - 1}). The assistant cannot alter the evidence or add content to it: it can only apply the application's filters and settings, exactly as recorded above, and every result was available for the examiner's review.</li>` : ""}</ul>`;
  html += `<footer>Generated by ${esc(BRAND.fullName)} ${esc(BRAND.version)} on ${esc(now.toISOString())}. This report was produced automatically from the project "${esc(p.name)}".</footer></div></body></html>`;
  progress("Done", 1);
  return html;
}
