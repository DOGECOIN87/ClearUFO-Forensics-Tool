// A stdio MCP server (official SDK v1) for the bridge-hosted path: LUCID's assistant reaches it through
// the LUCID MCP bridge, which launches it from ~/.lucid-mcp/servers.json.
import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const s = new McpServer({ name: "test-stdio", version: "1.0.0" });
s.registerTool("upper", { description: "Upper-case a text", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: text.toUpperCase() }] }));
await s.connect(new StdioServerTransport());
