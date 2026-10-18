// Inlines the Vite build (CSS + JS, worker already inlined as a blob) into ONE portable HTML file
// that can be opened directly from disk (file://), e-mailed or archived with a case.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = "release";
let html = readFileSync(join(dir, "index.html"), "utf8");
const assets = readdirSync(join(dir, "assets"));
html = html.replace(/<link rel="stylesheet"[^>]*href="\.\/assets\/([^"]+\.css)"[^>]*>/, (_, f) => `<style>\n${readFileSync(join(dir, "assets", f), "utf8")}\n</style>`);
html = html.replace(/<script type="module"[^>]*src="\.\/assets\/([^"]+\.js)"[^>]*><\/script>/, (_, f) => {
  const js = readFileSync(join(dir, "assets", f), "utf8").replace(/<\/script/gi, "<\\/script");
  return `<script type="module">\n${js}\n</script>`;
});
if (/src="\.\/assets\//.test(html) || /href="\.\/assets\/.*\.css"/.test(html)) throw new Error("Some assets were not inlined");
const out = join(dir, "LUCID-Forensic-Workbench.html");
writeFileSync(out, html);
console.log(`single-file build: ${out} (${(html.length / 1048576).toFixed(2)} MB), assets: ${assets.join(", ")}`);
