// Entry point — wires together the app, starts the HTTP server, handles shutdown.

import process from "node:process";

import { CONFIG, mcpServerUrl, keycloakUrls, realmExternal } from "./config.js";
import { resourceMetadataUrl } from "./auth.js";
import { app, closeAllSessions } from "./http.js";

app.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`MCP server:     http://${CONFIG.host}:${CONFIG.port}/mcp`);
  console.log(`Auth metadata:  ${resourceMetadataUrl}`);
  console.log(`Keycloak:       ${realmExternal}`);
  console.log(`Introspection:  ${keycloakUrls.internal.introspection_endpoint}`);
});

process.on("SIGINT", () => {
  console.log("\nShutting down — closing all sessions...");
  closeAllSessions();
  process.exit(0);
});
