// Express app: CORS, auth metadata (public), auth guard, session management,
// and the three MCP endpoints (POST / GET / DELETE /mcp).

import { randomUUID } from "node:crypto";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";

import { CONFIG } from "./config.js";
import { authMetadataMiddleware, authMiddleware } from "./auth.js";
import { createServer } from "./tools.js";

// createMcpExpressApp already adds express.json() and DNS-rebinding protection.
export const app = createMcpExpressApp({ host: CONFIG.host });

// CORS — allow any origin so Claude Code (and other clients) can reach us.
// In production, restrict this to known client origins.
app.use(cors({ origin: "*", exposedHeaders: ["Mcp-Session-Id"] }));

// Public: serves /.well-known/oauth-protected-resource/mcp
// Must be mounted BEFORE authMiddleware — unauthenticated clients need this to start auth.
app.use(authMetadataMiddleware);

// ── Session management ─────────────────────────────────────────
//
// Stateful mode: one transport per session, kept alive across requests.
// Sessions are keyed by the "Mcp-Session-Id" header:
//   initialize request → new session, ID returned in response header
//   subsequent requests → ID looked up, existing transport reused
//   transport.onclose  → session removed from the map
//
const sessions = new Map<string, StreamableHTTPServerTransport>();

export function closeAllSessions(): void {
  sessions.forEach((t) => t.close());
}

// ── MCP endpoints ──────────────────────────────────────────────

app.post("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Case 1: existing session — route to its transport
  if (sessionId && sessions.has(sessionId)) {
    await sessions.get(sessionId)!.handleRequest(req, res, req.body);
    return;
  }

  // Case 2: no session yet — must be an initialize request
  if (!sessionId && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, transport);
        console.log(`[session] created: ${newSessionId}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        console.log(`[session] closed: ${transport.sessionId}`);
      }
    };

    // createServer() must be called here (per-session), not at module load time.
    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // Case 3: invalid state
  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: send initialize first, or include Mcp-Session-Id" },
    id: null,
  });
});

// GET /mcp — SSE stream for server-initiated notifications (stateful sessions only).
app.get("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: "Missing or unknown Mcp-Session-Id" });
    return;
  }
  await sessions.get(sessionId)!.handleRequest(req, res);
});

// DELETE /mcp — client signals it's done and the session should be cleaned up.
app.delete("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: "Missing or unknown Mcp-Session-Id" });
    return;
  }
  await sessions.get(sessionId)!.handleRequest(req, res);
});
