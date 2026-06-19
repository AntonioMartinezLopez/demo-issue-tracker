// MCP tool definitions and server factory.
//
// createServer() is a factory — it must be called once per session (not once at startup)
// because each McpServer holds session-local state. See http.ts for where it's called.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Issue, Status } from "../../lib/types.js";
import { apiRequest, ok, err } from "./api-client.js";

// `satisfies` keeps the Zod enum in sync with the TypeScript Status type at compile time:
// if you add a status to the Status union without updating this array, TypeScript errors here.
const statusEnum = z.enum(
  ["backlog", "todo", "in_progress", "done"] satisfies [Status, ...Status[]]
);

export function createServer(): McpServer {
  const server = new McpServer({ name: "issue-tracker", version: "1.0.0" });

  server.registerTool(
    "list_issues",
    {
      description:
        "Get all issues from the board. Returns an array of issues with " +
        "their id, title, description, status (backlog | todo | in_progress | done), order, and createdAt.",
    },
    async () => {
      const result = await apiRequest<Issue[]>("/issues");
      if (result.error) return err(result.error);
      return ok(result.data);
    }
  );

  server.registerTool(
    "get_issue",
    {
      description: "Get a single issue by its ID.",
      inputSchema: { id: z.string().describe("The UUID of the issue to fetch") },
    },
    async ({ id }) => {
      const result = await apiRequest<Issue>(`/issues/${id}`);
      if (result.error) return err(`${result.error} (status ${result.status})`);
      return ok(result.data);
    }
  );

  server.registerTool(
    "create_issue",
    {
      description: "Create a new issue on the board. Only 'title' is required.",
      inputSchema: {
        title: z.string().describe("The issue title (required)"),
        description: z.string().optional().describe("Optional longer description"),
        status: statusEnum
          .optional()
          .describe("Which column to place the issue in. Defaults to 'backlog'."),
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

  server.registerTool(
    "update_issue",
    {
      description:
        "Update one or more fields of an existing issue. Only send the fields you want to change.",
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

  server.registerTool(
    "delete_issue",
    {
      description: "Permanently delete an issue by its ID.",
      inputSchema: { id: z.string().describe("The UUID of the issue to delete") },
    },
    async ({ id }) => {
      const result = await apiRequest<never>(`/issues/${id}`, { method: "DELETE" });
      if (result.error) return err(`${result.error} (status ${result.status})`);
      return ok({ message: `Issue ${id} deleted successfully.` });
    }
  );

  server.registerTool(
    "reorder_column",
    {
      description:
        "Reorder issues within a column. Provide the status (column name) " +
        "and the full ordered list of issue IDs for that column.",
      inputSchema: {
        status: statusEnum.describe("The column to reorder"),
        orderedIds: z
          .array(z.string())
          .describe("All issue IDs in the column, in the desired order (first = top)"),
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
