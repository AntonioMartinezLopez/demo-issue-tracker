# MCP — Model Context Protocol

Personal learning notes based on building the Issue Tracker MCP server.

---

## 1. What is MCP?

MCP (Model Context Protocol) is an open standard created by Anthropic that defines how AI assistants (like Claude) can talk to external tools and data sources in a structured, safe, and interoperable way.

The core problem it solves: an AI agent cannot just "browse" to your API and figure out how to use it. It needs a structured interface that answers three questions:
- **What can you do?** → tool names and descriptions
- **What do you need from me?** → input schemas
- **What will you give back?** → structured responses

MCP defines a standard protocol for all of this, so any MCP-compatible AI client (Claude Code, custom agents, etc.) can talk to any MCP server without custom integration work.

### Analogy

Think of it like USB-C: the protocol is the port standard. Your app is the device. Any charger (AI client) that speaks the standard can power your device.

---

## 2. Key Concepts

### Server
The `McpServer` object is the brain of an MCP server. It keeps track of all registered tools, handles protocol-level communication, and routes incoming tool calls to the right handler functions.

You create one like this:
```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = new McpServer({
  name: "issue-tracker",   // identifies this server to the client
  version: "1.0.0",
});
```

### Transport
The transport is the communication channel between the MCP server and the AI client. It defines *how* messages travel, not *what* they contain. There are two main options:

| Transport | How it works | Best for |
|---|---|---|
| **stdio** | Messages travel through stdin/stdout | Local dev tools, spawned processes |
| **HTTP (Streamable)** | Messages travel over HTTP POST + SSE | Deployed servers, shared team servers, auth |

The tools and handlers you write are **identical regardless of transport**. Swapping transport is a one-line change in the startup code.

### Tool
A tool is a function that the AI can call. It has four parts:

```typescript
server.registerTool(
  "list_issues",          // 1. name: how the AI refers to it (snake_case)
  {
    description: "...",   // 2. description: tells the AI WHEN to use it
    inputSchema: { ... }, // 3. input schema: what parameters it accepts (Zod)
  },
  async (args) => { ... } // 4. handler: the code that runs when called
);
```

The **description** is crucial — the AI reads it to decide which tool to pick. Write it as if explaining to a smart colleague who can't see your code.

The **input schema** is written with Zod and automatically converted to JSON Schema so the AI knows exactly what to send.

---

## 3. Transport Deep-Dive: stdio vs HTTP

### stdio Transport

```
Claude Code process
    │
    ├── spawns ──► MCP server process
    │                    (communicates via stdin/stdout)
    │◄──────────────────►│
```

- Claude Code **spawns** the MCP server as a child process
- Messages go through **stdin** (Claude → server) and **stdout** (server → Claude)
- The server **dies** when Claude Code closes
- **Critical footgun**: never use `console.log()` — stdout is reserved for JSON-RPC messages. Always use `console.error()` (which goes to stderr). Any accidental `console.log()` silently corrupts the message stream and breaks the connection with no obvious error.

Registered in Claude Code with:
```bash
claude mcp add issue-tracker -- npx tsx /path/to/mcp/src/index.ts
```

### HTTP Transport (Streamable HTTP)

```
Claude Code / any agent
    │
    └── POST http://localhost:3002/mcp ──► MCP server (independent process)
                                              (runs on its own, not spawned)
```

- The MCP server runs as a **standalone HTTP server** on a port
- Any HTTP client can talk to it — Claude Code, your own agent, curl
- The server **lives independently** of any AI client
- `console.log()` is perfectly fine — stdout is just stdout
- Auth middleware (Keycloak, API keys, etc.) fits naturally at the HTTP layer

Registered in Claude Code with:
```bash
claude mcp add --transport http issue-tracker http://127.0.0.1:3002/mcp
```

---

## 4. The Wire Protocol: JSON-RPC 2.0

MCP uses **JSON-RPC 2.0** as its message format. Every interaction is a POST request with a JSON body containing:

| Field | Purpose | Example |
|---|---|---|
| `jsonrpc` | Protocol version marker (always `"2.0"`) | `"2.0"` |
| `id` | A number to match responses to requests | `1`, `2`, `3` |
| `method` | The operation to perform | `"tools/call"` |
| `params` | Arguments for the operation | `{ name: "...", arguments: {} }` |

**Request example:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "list_issues",
    "arguments": {}
  }
}
```

**Response example:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      { "type": "text", "text": "[{ \"id\": \"abc\", \"title\": \"...\" }]" }
    ]
  }
}
```

---

## 5. The Full Request Flow (HTTP Transport)

### When Claude uses a tool, three separate HTTP requests happen:

```
┌─────────────────────────────────────────────────────────────────────┐
│ REQUEST 1 — initialize (handshake)                                  │
│                                                                     │
│  Claude ──POST /mcp──► { method: "initialize",                      │
│                           clientInfo: { name: "claude-code" },      │
│                           capabilities: {} }                        │
│                                                                     │
│  Inside the server:                                                 │
│    createServer() runs → new McpServer instance                     │
│    transport created  → StreamableHTTPServerTransport               │
│    server.connect()   → SDK wires up protocol handlers              │
│    SDK handles        → "initialize" is a built-in protocol method  │
│                                                                     │
│  Server ──SSE event──► { result: {                                  │
│                            protocolVersion: "2025-03-26",           │
│                            capabilities: { tools: { ... } },       │
│                            serverInfo: { name: "issue-tracker" }    │
│                          }}                                         │
│                                                                     │
│  → Server says: "Hello, I support tools, here's who I am."         │
│  → McpServer + transport instances are destroyed.                   │
│  → Connection closes immediately after this one event.             │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ REQUEST 2 — tools/list (discovery)                                  │
│                                                                     │
│  Claude ──POST /mcp──► { method: "tools/list", params: {} }        │
│                                                                     │
│  Inside the server:                                                 │
│    createServer() runs → new McpServer instance                     │
│    transport created  → StreamableHTTPServerTransport               │
│    server.connect()   → SDK wires up protocol handlers              │
│    SDK handles        → reads all registerTool() calls              │
│                                                                     │
│  Server ──SSE event──► { result: { tools: [                         │
│                            {                                        │
│                              name: "list_issues",                   │
│                              description: "Get all issues...",      │
│                              inputSchema: {                         │
│                                type: "object",                      │
│                                properties: {}                       │
│                              }                                      │
│                            },                                       │
│                            {                                        │
│                              name: "create_issue",                  │
│                              description: "Create a new issue...",  │
│                              inputSchema: {                         │
│                                type: "object",                      │
│                                properties: {                        │
│                                  title: { type: "string" },        │
│                                  status: {                          │
│                                    type: "string",                  │
│                                    enum: ["backlog","todo",...]     │
│                                  }                                  │
│                                },                                   │
│                                required: ["title"]                  │
│                              }                                      │
│                            },                                       │
│                            ... (all 6 tools)                        │
│                          ]}}                                        │
│                                                                     │
│  → Claude reads every tool's schema BEFORE calling anything.        │
│  → This is how it knows which values are valid for "status".        │
│  → McpServer + transport instances are destroyed.                   │
│  → Connection closes immediately after this one event.             │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ REQUEST 3 — tools/call (actual tool use)                            │
│                                                                     │
│  Claude ──POST /mcp──► { method: "tools/call",                      │
│                           params: {                                 │
│                             name: "list_issues",                    │
│                             arguments: {}                           │
│                           }}                                        │
│                                                                     │
│  Inside the server:                                                 │
│    createServer() runs → new McpServer instance                     │
│    transport created  → StreamableHTTPServerTransport               │
│    server.connect()   → wires server ↔ transport                   │
│    tool handler fires → list_issues callback executes               │
│    fetch() called     → GET http://localhost:3001/api/issues        │
│    Next.js responds   → [ { id, title, status, ... }, ... ]        │
│    ok() wraps result  → { content: [{ type: "text", text: "..." }]} │
│                                                                     │
│  Server ──SSE event──► { result: {                                  │
│                            content: [{                              │
│                              type: "text",                          │
│                              text: "[{\"id\":\"...\",\"title\":\"Set │
│                                     up project skeleton\",...}]"    │
│                            }]                                       │
│                          }}                                         │
│                                                                     │
│  → Connection closes immediately after this one event.             │
│  → McpServer + transport instances are destroyed (stateless).      │
└─────────────────────────────────────────────────────────────────────┘
```

### Key insight: stateless means one McpServer per request

In our stateless setup, `createServer()` runs on every single POST. All three requests above each get their own fresh `McpServer` instance that is created, used, and discarded. There is no shared memory between requests.

```typescript
app.post("/mcp", async (req, res) => {
  const server = createServer();      // ← fresh instance every time
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();                // ← cleaned up when HTTP connection closes
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

---

## 6. The "Streamable" in Streamable HTTP

The response format is **Server-Sent Events (SSE)**, not plain JSON:

```
event: message
data: {"result": { ... }, "jsonrpc": "2.0", "id": 1}
```

The HTTP client must signal it can handle both formats:
```
Accept: application/json, text/event-stream
```

Why SSE instead of plain JSON? Because SSE allows the server to send **multiple events** over a single open HTTP connection. For a quick `list_issues` call there is only ever one event — but the format is consistent whether the response is instant or takes 30 seconds and sends progress updates along the way:

```
event: message
data: { "method": "notifications/progress", "params": { "progress": 0.3 } }

event: message
data: { "method": "notifications/progress", "params": { "progress": 0.7 } }

event: message
data: { "result": { "content": [...] }, "id": 1 }    ← final result
```

In stateless mode (our setup), the connection is short-lived: it opens with the POST, one event is sent, and it closes. The SSE format is used for consistency, not because we need the streaming capability right now.

### The GET /mcp endpoint (why we return 405)

In **stateful mode** there is a long-lived `GET /mcp` endpoint where the client opens a persistent SSE connection. The server can then push unsolicited notifications over it at any time — e.g. "a new issue was created", "issue #5 status changed". This requires a persistent server instance per client session.

In our stateless setup there is no persistent server instance, so there is nothing to push from. That is why we return `405 Method Not Allowed` for `GET /mcp`.

---

## 7. What the SDK Handles Automatically

You never write handlers for the protocol-level methods. The SDK wires them up internally the moment you call `server.connect(transport)`:

| Method | Handled by | What it does |
|---|---|---|
| `initialize` | SDK | Responds with server name, version, capabilities |
| `notifications/initialized` | SDK | Acknowledges the handshake is complete |
| `ping` | SDK | Responds to keep-alive checks from the client |
| `tools/list` | SDK | Reads all `registerTool()` calls and returns their schemas |
| `tools/call` | SDK (routes to your handler) | Validates input, calls your function, formats the response |

**You are only responsible for:**
```typescript
server.registerTool(name, config, handler)
server.registerResource(...)   // if you have resources
server.registerPrompt(...)     // if you have prompts
```

This is the distinction between `McpServer` (high-level, what we use) and the low-level `Server` class that also exists in the SDK. With the raw `Server` class you would have to set up all of the above yourself.

---

## 8. Tool Response Format

Every tool handler must return an object with a `content` array. Each item in the array is a typed piece of content:

### Text (what we use)
```typescript
return {
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
};
```

### Error
```typescript
return {
  isError: true,
  content: [{ type: "text", text: "Error: not found" }]
};
```

### Image
```typescript
return {
  content: [{ type: "image", data: "<base64>", mimeType: "image/png" }]
};
```

### Structured output (advanced)
```typescript
// define outputSchema in registerTool config, then return:
return {
  structuredContent: { issues: [...] }  // typed object matching the schema
};
```

For most API integrations, returning JSON serialized as a `text` string is the right choice. The AI reads and understands JSON perfectly well. Structured output is more useful when another program (not an AI) is consuming the tool result and needs a guaranteed schema.

---

## 9. Shared Types Between the Next.js App and MCP Server

The `Issue` and `Status` types defined in `lib/types.ts` are reused in the MCP server without copying them.

**Why this works:**  
Both live in the same git repository. The MCP server's `tsconfig.json` sets `rootDir: ".."` (the project root), which allows TypeScript to import from sibling directories.

**The import:**
```typescript
import type { Issue, Status } from "../../lib/types.js";
```

`import type` means these are erased at compile time — zero runtime cost, zero extra files to ship. Pure compile-time safety.

**The `satisfies` trick for keeping Zod in sync with the type:**
```typescript
const statusEnum = z.enum(
  ["backlog", "todo", "in_progress", "done"] satisfies [Status, ...Status[]]
);
```

If someone adds a new status to `lib/types.ts`, TypeScript will immediately error here — you can't forget to update the MCP server.

---

## 10. Where Auth Will Plug In (Keycloak)

Because we're on HTTP transport, auth is a standard Express middleware that runs before the MCP handler:

```typescript
// Future: validate Keycloak JWT before any tool can be called
app.use("/mcp", verifyKeycloakToken);

app.post("/mcp", async (req, res) => {
  // only reached if token is valid
  const server = createServer();
  ...
});
```

The `verifyKeycloakToken` middleware would:
1. Read the `Authorization: Bearer <token>` header
2. Verify the JWT signature against the Keycloak public key
3. Check claims (audience, expiry, roles)
4. Either call `next()` (valid) or return `401 Unauthorized` (invalid)

The MCP tools themselves never change. Auth is entirely handled at the HTTP layer before the MCP protocol even starts.

---

## 11. Project File Structure

```
demo-issue-tracker-2/
├── app/
│   └── api/
│       ├── issues/
│       │   ├── route.ts          GET /api/issues, POST /api/issues
│       │   └── [id]/route.ts     GET/PATCH/DELETE /api/issues/:id
│       └── columns/
│           └── [status]/reorder/route.ts   PUT /api/columns/:status/reorder
├── lib/
│   ├── types.ts                  Issue, Status — shared by Next.js AND MCP server
│   └── store.ts                  In-memory issue store
└── mcp/                          ← separate Node.js project (not Next.js)
    ├── package.json              own dependencies: MCP SDK, express, zod
    ├── tsconfig.json             rootDir: ".." to allow importing lib/types.ts
    └── src/
        └── index.ts              the entire MCP server
```

---

## 12. Running the MCP Server

```bash
# Development (no compile step, just run TypeScript directly)
cd mcp
npm run dev
# → Server listening at http://127.0.0.1:3002/mcp

# The Next.js app must also be running for tools to work
cd ..
npm run dev
# → Next.js app at http://localhost:3001

# Override defaults with env vars
PORT=4000 HOST=0.0.0.0 ISSUE_TRACKER_URL=https://myapp.example.com npm run dev
```

### Testing with curl (mimicking what Claude does)

```bash
# Step 1 — Handshake
curl -X POST http://127.0.0.1:3002/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"test","version":"1.0"},"capabilities":{}}}'

# Step 2 — Discover tools
curl -X POST http://127.0.0.1:3002/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# Step 3 — Call a tool
curl -X POST http://127.0.0.1:3002/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_issues","arguments":{}}}'
```
