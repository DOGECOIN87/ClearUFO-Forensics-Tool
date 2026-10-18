import { writeFileSync } from "node:fs";
import { CATEGORIES, FILTER_LIST, defaultParams, formatParam } from "../src/shared/filters";
let md = `# Filter Reference\n\n${FILTER_LIST.length} filters in ${CATEGORIES.length} categories (generated from \`src/shared/filters.ts\`).\n`;
for (const c of CATEGORIES) {
  md += `\n## ${c.name}\n\n_${c.description}_\n\n| Filter | Description | Parameters (defaults) |\n|---|---|---|\n`;
  for (const f of FILTER_LIST.filter((x) => x.category === c.name)) {
    const d = defaultParams(f);
    const ps = f.params.filter((p) => !["action", "psf", "info", "fileinfo"].includes(p.type)).map((p) => `${p.label}${p.type === "number" || p.type === "int" ? ` (${p.min}–${p.max})` : ""}: ${formatParam(p, d[p.key]).replace(/\|/g, "/")}`).join("<br>");
    md += `| **${f.name}**${f.slow ? " ⏱" : ""} | ${f.description}${f.reference ? `<br><sub>Ref.: ${f.reference}</sub>` : ""} | ${ps || "—"} |\n`;
  }
}
writeFileSync("docs/FILTERS.md", md);
console.log("docs/FILTERS.md written");
