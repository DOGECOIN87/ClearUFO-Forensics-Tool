// Bundles generate.ts with esbuild (as the browser workbench's own unit tests do) and runs it with Node.
// Run from the repository root after `npm ci`.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";

const out = "node_modules/.lucid-tests/conformance.mjs";
await build({ entryPoints: ["android/conformance/generate.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "warning", external: ["mediabunny", "utif2"] });
process.stdout.write(execFileSync("node", [out], { encoding: "utf8" }));
