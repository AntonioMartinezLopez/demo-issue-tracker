/**
 * ============================================================
 * Issue Tracker — MCP Server (HTTP transport)
 * ============================================================
 *
 * TRANSPORT CHOICE: HTTP instead of stdio
 * ----------------------------------------
 * We use HTTP so the MCP server runs as a standalone process —
 * independent of any AI client. Benefits:
 *   • The server can keep running even when Claude Code is closed
 *   • Multiple clients can connect to the same server
 *   • Auth middleware (e.g. Keycloak JWT validation) can sit in
 *     front of the /mcp endpoint, just like any other web API
 *
 * HOW STATELESS HTTP WORKS
 * -------------------------
 * Each POST request to /mcp is treated as a fresh interaction:
 *   1. Claude sends a JSON-RPC request in the POST body
 *   2. We create a new McpServer + transport just for that request
 *   3. We handle the request and send the response
 *   4. We clean up and discard the server/transport instances
 *
 * Why create a new server per request?
 * Because "stateless" means no shared state between requests.
 * The tools are cheap to re-register on every request — it's
 * just function registration, no database calls or heavy setup.
 *
 * (The alternative is "stateful" mode with session IDs, where
 * one server instance is kept alive per connected client. That's
 * better for streaming/notifications but needs more infra.)
 *
 * NOTE: console.log is fine here!
 * Unlike stdio transport, stdout is not used for JSON-RPC framing
 * in HTTP mode. Log whatever you like.
 * ============================================================
 */

// ── Imports ──────────────────────────────────────────────────
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
// createMcpExpressApp: SDK helper that creates an Express app pre-configured
// for MCP — includes JSON body parsing and DNS-rebinding protection for localhost.
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import process from "node:process";
import { z } from "zod";
import type { Issue, Status } from "../../lib/types.js";

// ── Configuration ─────────────────────────────────────────────
// PORT: the HTTP port the server listens on.
//   Override: PORT=4000 npm run dev
const PORT = Number(process.env.PORT ?? 3002);

// HOST: the network interface to bind to.
//   "127.0.0.1" (default) = only reachable from this machine (safe for local dev)
//   "0.0.0.0"             = reachable from the network (needed for Docker / cloud)
//   Override: HOST=0.0.0.0 npm run dev
const HOST = process.env.HOST ?? "127.0.0.1";

// The base URL of your Next.js Issue Tracker API.
const API_BASE = process.env.ISSUE_TRACKER_URL ?? "http://localhost:3001/api";

// ── Status enum (reused across tools) ─────────────────────────
// "satisfies" ensures these values stay in sync with the Status type in lib/types.ts.
const statusEnum = z.enum(["backlog", "todo", "in_progress", "done"] satisfies [Status, ...Status[]]);

// ── HTTP helpers ───────────────────────────────────────────────
async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<{ data?: T; error?: string; status: number }> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json" },
  });

  if (response.status === 204) return { status: 204 };

  const data = await response.json();
  if (!response.ok) return { error: data.error ?? "Unknown error", status: response.status };
  return { data: data as T, status: response.status };
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

// ── Server factory ─────────────────────────────────────────────
//
// We use a factory function instead of a module-level singleton because
// stateless HTTP mode creates a fresh McpServer per request.
//
// Think of it like an Express route handler: each request gets its own
// context, handles itself, and is cleaned up afterwards.
//
function createServer(): McpServer {
  const server = new McpServer({ name: "issue-tracker", version: "1.0.0" });

  // ── TOOL: list_issues ───────────────────────────────────────
  server.registerTool(
    "list_issues",
    {
      description:
        "Get all issues from the board. Returns an array of issues with " +
        "their id, title, description, status (backlog | todo | in_progress | done), " +
        "order, and createdAt.",
    },
    async () => {
      const result = await apiRequest<Issue[]>("/issues");
      if (result.error) return err(result.error);
      return ok(result.data);
    }
  );

  // ── TOOL: get_issue ─────────────────────────────────────────
  server.registerTool(
    "get_issue",
    {
      description: "Get a single issue by its ID.",
      inputSchema: {
        id: z.string().describe("The UUID of the issue to fetch"),
      },
    },
    async ({ id }) => {
      const result = await apiRequest<Issue>(`/issues/${id}`);
      if (result.error) return err(`${result.error} (status ${result.status})`);
      return ok(result.data);
    }
  );

  // ── TOOL: create_issue ──────────────────────────────────────
  server.registerTool(
    "create_issue",
    {
      description: "Create a new issue on the board. Only 'title' is required.",
      inputSchema: {
        title: z.string().describe("The issue title (required)"),
        description: z.string().optional().describe("Optional longer description"),
        status: statusEnum.optional().describe("Which column to place the issue in. Defaults to 'backlog'."),
      },
    },
    async ({ title, description, status }) => {
      const result = await apiRequest<Issue>("/issues", {
        method: "POST",
        body: JSON.stringify({ title, description, status }),
      });
      if (result.error) return err(result.error);
      return ok(result.data);
    }
  );

  // ── TOOL: update_issue ──────────────────────────────────────
  server.registerTool(
    "update_issue",
    {
      description: "Update one or more fields of an existing issue. Only send the fields you want to change.",
      inputSchema: {
        id: z.string().describe("The UUID of the issue to update"),
        title: z.string().optional().describe("New title"),
        description: z.string().optional().describe("New description"),
        status: statusEnum.optional().describe("New status / column for the issue"),
      },
    },
    async ({ id, title, description, status }) => {
      const patch: Record<string, unknown> = {};
      if (title !== undefined) patch.title = title;
      if (description !== undefined) patch.description = description;
      if (status !== undefined) patch.status = status;

      const result = await apiRequest<Issue>(`/issues/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (result.error) return err(`${result.error} (status ${result.status})`);
      return ok(result.data);
    }
  );

  // ── TOOL: delete_issue ──────────────────────────────────────
  server.registerTool(
    "delete_issue",
    {
      description: "Permanently delete an issue by its ID.",
      inputSchema: {
        id: z.string().describe("The UUID of the issue to delete"),
      },
    },
    async ({ id }) => {
      const result = await apiRequest<never>(`/issues/${id}`, { method: "DELETE" });
      if (result.error) return err(`${result.error} (status ${result.status})`);
      return ok({ message: `Issue ${id} deleted successfully.` });
    }
  );

  // ── TOOL: reorder_column ────────────────────────────────────
  server.registerTool(
    "reorder_column",
    {
      description:
        "Reorder issues within a column. Provide the status (column name) " +
        "and the full ordered list of issue IDs for that column.",
      inputSchema: {
        status: statusEnum.describe("The column to reorder"),
        orderedIds: z.array(z.string()).describe("All issue IDs in the column, in the desired order (first = top)"),
      },
    },
    async ({ status, orderedIds }) => {
      const result = await apiRequest<Issue[]>(`/columns/${status}/reorder`, {
        method: "PUT",
        body: JSON.stringify({ orderedIds }),
      });
      if (result.error) return err(result.error);
      return ok(result.data);
    }
  );

  return server;
}

// ── HTTP server setup ──────────────────────────────────────────
//
// createMcpExpressApp() returns a standard Express app that already has:
//   - express.json() body parsing
//   - DNS-rebinding protection when binding to localhost
//
// We pass `host` so it knows whether to apply that protection.
//
const app = createMcpExpressApp({ host: HOST });

// POST /mcp — the main MCP endpoint.
//
// Each request goes through the full lifecycle:
//   1. Create a fresh server + transport
//   2. Connect them
//   3. Handle the request (tool call, tool list, etc.)
//   4. Clean up when the HTTP connection closes
//
app.post("/mcp", async (req, res) => {
  const server = createServer();

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session tracking
    });

    // Clean up both transport and server when the HTTP connection closes.
    // This prevents memory leaks if a client disconnects mid-request.
    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET and DELETE on /mcp are not used in stateless mode.
// Return 405 Method Not Allowed so clients get a clear error
// instead of a confusing timeout.
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST." },
    id: null,
  });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST." },
    id: null,
  });
});

// ── Start listening ────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`Issue Tracker MCP server running at http://${HOST}:${PORT}/mcp`);
  console.log(`Issue Tracker API expected at: ${API_BASE}`);
});

process.on("SIGINT", () => {
  console.log("\nShutting down MCP server...");
  process.exit(0);
});
