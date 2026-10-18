import "@danfessler/trellis/style.css";
import "./styles/app.css";
import { App } from "./app/App";
import { handleOAuthRedirect } from "./mcp/oauth";

// a sign-in popup returning from an MCP server's authorization page only hands the code back and closes
if (!handleOAuthRedirect()) {
  const host = document.getElementById("app")!;
  const app = new App(host);
  (window as unknown as { lucid: App }).lucid = app;
}
