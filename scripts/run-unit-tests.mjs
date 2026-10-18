// Bundles each tests/*.test.ts with esbuild and runs it with Node.
import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

let failed = 0;
for (const f of readdirSync("tests").filter((x) => x.endsWith(".test.ts"))) {
  // inside the project, so external packages (mediabunny, utif2) resolve from node_modules
  const out = `node_modules/.lucid-tests/${f.replace(/\.ts$/, ".mjs")}`;
  await build({ entryPoints: [`tests/${f}`], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "warning", external: ["mediabunny", "utif2"] });
  try { process.stdout.write(execFileSync("node", [out], { encoding: "utf8" })); }
  catch (e) { failed++; process.stdout.write(e.stdout ?? ""); console.error(`✖ ${f} failed`); }
}
console.log(failed ? `\n${failed} test file(s) failed` : "\nAll unit tests passed");
process.exit(failed ? 1 : 0);
