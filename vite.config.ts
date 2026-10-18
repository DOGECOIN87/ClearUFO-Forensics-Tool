import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { build as esbuild } from "esbuild";
import { defineConfig, type Plugin } from "vite";

// LUCID Forensic Workbench — Vite build.
// `npm run build` emits a hostable multi-file app to ./release
// `npm run build:single` additionally inlines everything into one portable HTML file.

/**
 * `import code from "virtual:engine-code"`: the processing engine (src/engine/worker.ts and everything it
 * imports) bundled into one self-contained script, as a string. The page starts its Web Worker from it,
 * and can run the same code in place when a browser forbids file access in workers (Safari, file://).
 */
function engineCode(): Plugin {
  const id = "virtual:engine-code", resolved = "\0" + id;
  let minify = false;
  return {
    name: "lucid-engine-code",
    configResolved(c) { minify = c.command === "build"; },
    resolveId: (s) => (s === id ? resolved : null),
    async load(s) {
      if (s !== resolved) return null;
      const cwd = process.cwd();
      const r = await esbuild({
        entryPoints: [resolve(cwd, "src/engine/worker.ts")], absWorkingDir: cwd, bundle: true, format: "iife",
        platform: "browser", target: "es2022", minify, write: false, metafile: true, legalComments: "none", logLevel: "warning",
      });
      // watch the real inputs only: esbuild lists modules disabled by a package's "browser" field as
      // "(disabled):path", which Vite's dev server would otherwise try to resolve as imports
      for (const f of Object.keys(r.metafile?.inputs ?? {})) { const file = resolve(cwd, f); if (!f.startsWith("(disabled)") && existsSync(file)) this.addWatchFile(file); }
      return `export default ${JSON.stringify(r.outputFiles[0].text)};`;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [engineCode()],
  server: { host: "0.0.0.0", port: 5173, allowedHosts: true, cors: true },
  preview: { host: "0.0.0.0", port: 4173, allowedHosts: true },
  build: {
    outDir: "release",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 100000000,
  },
});
