// Writes mcp/catalog.json (LUCID's MCP tools, resources and prompts) for the bridge, so MCP clients can list
// them before a LUCID tab is linked. Run by `npm run build` (bundled with esbuild, executed with node).
import { writeFileSync } from "node:fs";
import { catalogJson } from "../src/mcp/catalog";
const c = catalogJson();
writeFileSync("mcp/catalog.json", JSON.stringify(c, null, 1) + "\n");
console.log(`mcp/catalog.json written: ${c.tools.length} tools, ${c.resources.length} resources, ${c.prompts.length} prompts`);
