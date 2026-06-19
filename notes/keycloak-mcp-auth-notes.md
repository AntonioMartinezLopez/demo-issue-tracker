# Keycloak + MCP OAuth — Implementation Notes

Everything done to add OAuth 2.1 authentication to the MCP server using Keycloak,
managed via OpenTofu, orchestrated with Docker Compose.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Docker Compose                                                  │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐  │
│  │  keycloak    │    │  keycloak-setup  │    │     api      │  │
│  │  port 8080   │◄───│  (OpenTofu)      │    │  port 3001   │  │
│  │  (auth       │    │  init container  │    │  (Next.js    │  │
│  │  server)     │    │  exits after     │    │  Issue       │  │
│  └──────────────┘    │  apply ✓)        │    │  Tracker)    │  │
│         ▲            └──────────────────┘    └──────┬───────┘  │
│         │                                           │           │
│         │            ┌──────────────────────────────▼───────┐  │
│         └────────────│  mcp  (port 3002)                    │  │
│      introspection   │  - requireBearerAuth middleware       │  │
│      (server-to-     │  - validates token via Keycloak       │  │
│       server)        │  - proxies to api on port 3001        │  │
│                      └──────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         ▲                          ▲
         │ login (browser)          │ POST /mcp + Bearer token
    ┌────┴────────────────────────────────────────┐
    │  Claude Code (VS Code / CLI)                │
    │  registered: http://127.0.0.1:3002/mcp      │
    │  client-id:  mcp-client                     │
    └─────────────────────────────────────────────┘
```

### What each service does

| Service | Image | Role |
|---|---|---|
| `keycloak` | `quay.io/keycloak/keycloak:26.2` | Auth server — issues tokens, handles login UI, exposes introspection endpoint |
| `keycloak-setup` | `ghcr.io/opentofu/opentofu:1.9` | Init container — runs `tofu apply` once to configure Keycloak, then exits |
| `api` | built from `Dockerfile.api` | Next.js Issue Tracker REST API (the actual business logic) |
| `mcp` | built from `mcp/Dockerfile` | MCP server — validates tokens, exposes tools to AI agents |

---

## 2. File Structure

```
project-root/
├── docker-compose.yml          ← orchestrates all four services
├── Dockerfile.api              ← builds the Next.js API container
│
├── mcp/
│   ├── Dockerfile              ← builds the MCP server container
│   │                             (context must be project root, not mcp/)
│   ├── src/index.ts            ← MCP server with auth middleware
│   └── .env.example            ← env vars for running locally without Docker
│
└── tofu/
    ├── main.tf                 ← provider config (keycloak/keycloak ~> 5.0)
    ├── variables.tf            ← all tunable values with defaults
    ├── keycloak.tf             ← realm, clients, scopes, audience mapper, users
    └── outputs.tf              ← printed after apply (URLs, credentials)
```

---

## 3. Keycloak Resources (OpenTofu)

The `tofu/keycloak.tf` file creates these resources in order:

### Realm
```hcl
resource "keycloak_realm" "issue_tracker" {
  realm   = "issue-tracker"
  enabled = true
  access_token_lifespan    = "15m"
  sso_session_max_lifespan = "8h"
}
```
A realm is Keycloak's top-level namespace. All clients, users, and scopes live
inside it. The `master` realm is reserved for Keycloak admin only.

### Client scope: `mcp:tools`
```hcl
resource "keycloak_openid_client_scope" "mcp_tools" {
  realm_id               = keycloak_realm.issue_tracker.id
  name                   = "mcp:tools"
  include_in_token_scope = true
}
```
A scope is a permission label. Agents must explicitly request `mcp:tools` in
their OAuth request to get a token the MCP server will accept.

### Audience mapper on `mcp:tools`
```hcl
resource "keycloak_openid_audience_protocol_mapper" "mcp_tools_audience" {
  realm_id                 = keycloak_realm.issue_tracker.id
  client_scope_id          = keycloak_openid_client_scope.mcp_tools.id
  name                     = "mcp-server-audience"
  included_custom_audience = var.mcp_server_url   # "http://127.0.0.1:3002/mcp"
}
```
This embeds the MCP server's URL into the `aud` claim of every token that
includes the `mcp:tools` scope. The MCP server rejects tokens whose audience
doesn't match its own URL — this prevents token passthrough attacks.

**Critical:** `included_custom_audience` must exactly match `MCP_SERVER_URL` in
the MCP server config AND the URL used in `claude mcp add`.

### Client: `mcp-server` (confidential)
```hcl
resource "keycloak_openid_client" "mcp_server" {
  client_id                = "mcp-server"
  access_type              = "CONFIDENTIAL"
  service_accounts_enabled = true
  standard_flow_enabled    = false
  client_secret            = var.mcp_server_client_secret
}
```
This is the MCP server's identity when it calls Keycloak for token introspection.
Confidential = it has a secret. `service_accounts_enabled` = it can authenticate
as itself (client credentials grant) to call the introspection endpoint.

### Client: `mcp-client` (public)
```hcl
resource "keycloak_openid_client" "mcp_client" {
  client_id                  = "mcp-client"
  access_type                = "PUBLIC"
  standard_flow_enabled      = true
  pkce_code_challenge_method = "S256"
  valid_redirect_uris        = ["http://localhost:*", "http://127.0.0.1:*"]
}
```
This is what Claude Code uses to log in on behalf of a user. Public = no secret
(runs on the user's machine, can't keep secrets). PKCE is mandatory for public
clients to prevent authorization code interception.

`mcp:tools` is added as an **optional scope** on this client — the agent must
explicitly request it, it's not granted automatically.

### Demo users
```hcl
resource "keycloak_user" "alice" {
  username = "alice"
  initial_password { value = "alice123"; temporary = false }
}
```
Two users: `alice` / `alice123` and `bob` / `bob123`.

---

## 4. JWT Claims: `sub`, `aud`, and Protocol Mappers

### What is a JWT?

When a user logs in, Keycloak issues a **JSON Web Token (JWT)** — a base64-encoded
JSON object signed with Keycloak's private key. Anyone can decode and read it;
only Keycloak can produce a valid signature.

A decoded token from this project looks like this:

```json
{
  "iss": "http://localhost:8080/realms/issue-tracker",
  "sub": "4d883ba7-f019-40c8-ba9f-fed48ee4985a",
  "aud": "http://127.0.0.1:3002/mcp",
  "azp": "mcp-client",
  "scope": "mcp:tools",
  "exp": 1750000000,
  "iat": 1749999100,
  "preferred_username": "alice",
  "email": "alice@example.com"
}
```

Each field is a **claim** — a statement about the token or the user it was issued for.

---

### The `sub` claim (Subject)

**What it is in general:**
`sub` identifies WHO the token was issued for — the user or entity that
authenticated. It is defined in RFC 7519 (the JWT standard) and is guaranteed
to be unique and stable within an issuer.

**Important:** `sub` is almost always an opaque internal ID (a UUID), not the
username. This is intentional — usernames can change, UUIDs cannot. Two systems
that store data about a user should both key it on `sub`, not on `preferred_username`.

**What it is in Keycloak specifically:**
Keycloak sets `sub` to the user's internal UUID, generated at account creation.
Alice's `sub` is always `4d883ba7-...` regardless of whether she changes her
username or email.

**What it is used for generally:**
- Identifying the user in your database (foreign key)
- Per-user access control ("only the user who created this resource can delete it")
- Audit logs ("user `sub` X performed action Y at time Z")
- Session tracking

**What it is used for in this project:**
Currently the MCP server reads `sub` from the introspection response but does
not use it — all authenticated users can call all tools equally. A natural next
step would be to log `sub` alongside every tool call for auditability, or to
implement per-user issue ownership.

---

### The `aud` claim (Audience)

**What it is in general:**
`aud` names the intended **recipient(s)** of the token — the service(s) that
should accept it. It is also defined in RFC 7519. A service MUST reject tokens
where `aud` does not include its own identifier.

**Why it matters — the token passthrough attack:**

Without audience validation, this attack is possible:
```
1. Alice logs into Service A  →  gets token (no aud restriction)
2. Attacker intercepts the token
3. Attacker sends the token to Service B
4. Service B accepts it (same issuer, valid signature, not expired)
5. Attacker now has access to Service B as Alice
```

With `aud` set to `https://service-a.example.com`, Service B rejects the token
immediately at step 4 because its own URL is not in `aud`. The token was issued
FOR service A, not for service B.

**What it is in Keycloak specifically:**
Keycloak does not add an audience automatically. You must configure it via a
**Protocol Mapper** (see below). Without a mapper, tokens have no `aud` claim
and your service cannot properly validate them.

**What it is used for in this project:**
The MCP server's `verifyAccessToken` function checks that `aud` contains
`http://127.0.0.1:3002/mcp` before accepting any token:

```typescript
const audienceIsValid = audiences.some((aud) =>
  checkResourceAllowed({ requestedResource: aud, configuredResource: mcpServerUrl })
);
if (!audienceIsValid) throw new Error("Token audience does not match this server");
```

This means a token issued for a different service (say, a future admin panel at
port 4000) cannot be replayed against the MCP server, even if both are protected
by the same Keycloak realm.

---

### Protocol Mappers in Keycloak

**What they are:**
Protocol Mappers are Keycloak's mechanism for controlling what claims appear in
tokens. They run at token issuance time and can add, transform, or remove claims.

Think of them as a pipeline: user logs in → Keycloak collects user data → each
mapper runs and contributes claims → token is signed and returned.

**Where they live:**
Mappers can be attached to:
- A **Client** — applies only to tokens issued to that specific client
- A **Client Scope** — applies to any client that includes that scope

Attaching to a scope (as we do) is better practice: the audience claim is only
added when `mcp:tools` is requested, keeping tokens minimal for other use cases.

**Types of mappers (the most common ones):**

| Mapper type | What it adds | Example use |
|---|---|---|
| **Audience** | `aud` claim with a fixed or dynamic value | Restrict token to a specific API |
| **User Attribute** | Any custom user attribute from Keycloak | Department, employee ID |
| **User Realm Role** | User's realm-level roles | `["editor", "viewer"]` |
| **User Client Role** | Roles specific to a client | Per-app permissions |
| **Hardcoded Claim** | A fixed string for all tokens | API version, tenant ID |
| **Group Membership** | Groups the user belongs to | `/engineering/backend` |
| **Full Name** | `name` claim from first + last name | Display name |

**The mapper in this project:**

```hcl
resource "keycloak_openid_audience_protocol_mapper" "mcp_tools_audience" {
  realm_id        = keycloak_realm.issue_tracker.id
  client_scope_id = keycloak_openid_client_scope.mcp_tools.id  # ← on the scope, not a client
  name            = "mcp-server-audience"
  included_custom_audience = var.mcp_server_url                # "http://127.0.0.1:3002/mcp"
}
```

This is an **Audience mapper** attached to the `mcp:tools` client scope.
Effect: whenever a token is issued that includes the `mcp:tools` scope,
the value `http://127.0.0.1:3002/mcp` is added to the `aud` claim.

Tokens issued WITHOUT the `mcp:tools` scope (e.g. to other services in the same
realm) will have no `aud` claim for the MCP server, so the MCP server rejects
them even though they came from the same Keycloak realm.

**The full claim chain in this project:**

```
User requests scope "mcp:tools"
         ↓
Keycloak finds the mcp:tools client scope
         ↓
Audience mapper runs → adds "http://127.0.0.1:3002/mcp" to aud
         ↓
Token issued with:  aud = "http://127.0.0.1:3002/mcp"
                    scope = "mcp:tools"
                    sub = "<alice's UUID>"
         ↓
MCP server receives token → introspects → checks aud ✓ → checks scope ✓ → allows request
```

---

### When and how the scope is specified

The scope is specified at the very first step of the OAuth flow — before the
user even sees the login screen.

**Step 1** — Claude Code sends a request to the MCP server with no token and
gets a 401. The `WWW-Authenticate` header already contains the required scope:

```
WWW-Authenticate: Bearer
  error="invalid_token",
  scope="mcp:tools",
  resource_metadata="http://127.0.0.1:3002/.well-known/oauth-protected-resource/mcp"
```

**Step 2** — Claude Code fetches the Protected Resource Metadata, which
confirms the supported scopes:

```json
{
  "resource": "http://127.0.0.1:3002/mcp",
  "scopes_supported": ["mcp:tools"]
}
```

**Step 3** — Claude Code constructs the authorization URL with the scope
embedded as a query parameter and opens it in the browser:

```
http://localhost:8080/realms/issue-tracker/protocol/openid-connect/auth
  ?client_id=mcp-client
  &response_type=code
  &scope=openid mcp:tools        ← specified upfront, before login
  &code_challenge=abc123...
  &code_challenge_method=S256
  &redirect_uri=http://127.0.0.1:PORT/callback
```

**Step 4** — Keycloak reads `scope=mcp:tools` from the URL, the user logs in,
and Keycloak runs the audience mapper because `mcp:tools` was requested.
The issued token contains both `scope: "mcp:tools"` and `aud: "http://127.0.0.1:3002/mcp"`.

**Why this matters:** if Claude Code had omitted `mcp:tools` from the
authorization URL, the audience mapper would never run. The user would still
log in successfully, but the token would arrive without an `aud` claim — and
the MCP server would reject it. The scope is not just a permission label; it
is the trigger that activates the mapper.

---

## 5. MCP Server Auth Implementation

### Key packages added
```bash
npm install cors dotenv
npm install --save-dev @types/cors
```

### How auth works in `mcp/src/index.ts`

**Step 1 — Expose auth metadata (public endpoint)**
```typescript
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl }
  from "@modelcontextprotocol/sdk/server/auth/router.js";

app.use(mcpAuthMetadataRouter({
  oauthMetadata,       // points to Keycloak endpoints
  resourceServerUrl: new URL(CONFIG.mcpServerUrl),
  scopesSupported: ["mcp:tools"],
  resourceName: "Issue Tracker MCP Server",
}));
```
This mounts `GET /.well-known/oauth-protected-resource/mcp` (no auth required).
Clients fetch this to discover Keycloak and know what scope to request.

**Step 2 — Validate Bearer token on every request**
```typescript
import { requireBearerAuth } from
  "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

const authMiddleware = requireBearerAuth({
  verifier: tokenVerifier,        // calls Keycloak introspection
  requiredScopes: ["mcp:tools"],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl),
});

app.post("/mcp", authMiddleware, async (req, res) => { ... });
```
On every POST, this middleware:
1. Reads `Authorization: Bearer <token>` header
2. If missing → `401` with `WWW-Authenticate` header (starts the auth discovery)
3. If present → calls Keycloak's introspection endpoint
4. Validates `aud` claim matches this server's URL
5. If valid → calls next(), request proceeds

**Step 3 — Token introspection (server-to-server)**
```typescript
const tokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const response = await fetch(keycloakUrls.internal.introspection_endpoint, {
      method: "POST",
      body: new URLSearchParams({
        token,
        client_id: CONFIG.oauthClientId,       // "mcp-server"
        client_secret: CONFIG.oauthClientSecret,
      }),
    });
    const data = await response.json();
    if (data.active === false) throw new Error("Token inactive");
    // validate aud claim...
    return { token, clientId: data.client_id, scopes: data.scope.split(" ") };
  }
};
```
Introspection = asking Keycloak "is this token valid?" on every request.
Alternative: local JWT validation (faster, no network call, but needs key
rotation handling). Introspection is simpler for a demo.

**Step 4 — Stateful sessions**

Unlike the previous stateless version (new McpServer per request), auth requires
stateful sessions so the connection context is maintained across tool calls:
```typescript
const sessions = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    // Existing session — reuse transport
    await sessions.get(sessionId)!.handleRequest(req, res, req.body);
  } else if (!sessionId && isInitializeRequest(req.body)) {
    // New session — create server + transport, store in map
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, transport),
    });
    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
});
```

### Two Keycloak URL roles

| Variable | Value (Docker) | Used for |
|---|---|---|
| `KEYCLOAK_URL` | `http://localhost:8080` | Embedded in auth metadata — what clients/browsers use |
| `KEYCLOAK_INTERNAL_URL` | `http://keycloak:8080` | Server-to-server introspection calls inside Docker |

This split is necessary because inside Docker, services reach each other via
container names (`keycloak`), but clients outside Docker use `localhost`.

### Critical URL match

The `MCP_SERVER_URL` environment variable must match **exactly** what
`claude mcp add` used:

```
MCP_SERVER_URL=http://127.0.0.1:3002/mcp   ← must match
claude mcp add ... http://127.0.0.1:3002/mcp  ← registered URL
included_custom_audience = "http://127.0.0.1:3002/mcp"  ← Keycloak audience
```

All three must be identical. Claude Code validates the `resource` field in
`/.well-known/oauth-protected-resource/mcp` against the URL it connected to.
`localhost` ≠ `127.0.0.1` — they resolve to the same IP but fail the string
comparison.

---

## 6. Docker Compose

### Starting everything
```bash
docker compose up -d
```

Order of operations Docker Compose enforces:
1. `keycloak` starts
2. `keycloak` healthcheck passes (`/health/ready` on port 9000 returns `"status": "UP"`)
3. `keycloak-setup` starts, runs `tofu init && tofu apply`, exits with code 0
4. `mcp` starts (waits for `keycloak-setup` to complete successfully)
5. `api` starts immediately (no dependency on keycloak)

### Stopping
```bash
docker compose down          # stop containers, keep images
docker compose down -v       # also remove volumes (full reset)
docker compose down --rmi local  # also remove built images (force rebuild next time)
```

### Viewing logs
```bash
docker compose logs keycloak        # Keycloak startup
docker compose logs keycloak-setup  # OpenTofu apply output
docker compose logs mcp             # MCP server (auth errors appear here)
docker compose logs api             # Next.js
docker compose logs -f mcp          # follow / tail
```

### Rebuilding after code changes
```bash
docker compose build mcp    # rebuild only the MCP image
docker compose up -d mcp    # restart only the MCP container
```

### Healthcheck note
Keycloak 26 requires HTTP/1.1 with a `Host` header. The raw TCP healthcheck
must use `printf` with `\r\n` and include `Host:`:
```yaml
test: ["CMD-SHELL", "exec 3<>/dev/tcp/localhost/9000 && printf 'GET /health/ready HTTP/1.1\\r\\nHost: localhost:9000\\r\\nConnection: close\\r\\n\\r\\n' >&3 && cat <&3 | grep -q 'UP'"]
```
`KC_HEALTH_ENABLED: "true"` must be set to expose the `/health/ready` endpoint.

### OpenTofu entrypoint note
The `ghcr.io/opentofu/opentofu` image sets `tofu` as its Docker ENTRYPOINT.
To run a shell script, override the entrypoint:
```yaml
keycloak-setup:
  image: ghcr.io/opentofu/opentofu:1.9
  entrypoint: ["/bin/sh", "-c"]   # ← required, otherwise "tofu sh -c ..." fails
  command:
    - |
      tofu init && tofu apply -auto-approve \
        -var='keycloak_url=http://keycloak:8080' \
        ...
```

---

## 7. OpenTofu Commands

### Running locally (outside Docker)

```bash
cd tofu/

# Initialize — downloads the keycloak provider
tofu init

# Preview what will be created/changed (no changes applied)
tofu plan \
  -var='keycloak_url=http://localhost:8080' \
  -var='mcp_server_url=http://127.0.0.1:3002/mcp'

# Apply — create/update all resources
tofu apply \
  -var='keycloak_url=http://localhost:8080' \
  -var='mcp_server_url=http://127.0.0.1:3002/mcp'

# Destroy — remove all managed resources from Keycloak
tofu destroy \
  -var='keycloak_url=http://localhost:8080' \
  -var='mcp_server_url=http://127.0.0.1:3002/mcp'

# Show current state
tofu show

# Show outputs (realm name, client IDs, user credentials)
tofu output
```

Keycloak must be running before any tofu command. When running inside Docker,
use `-var='keycloak_url=http://keycloak:8080'` (container hostname).

### State file

OpenTofu stores what it created in `tofu/terraform.tfstate`. This file:
- Is written after every `apply`
- Is used by the next `apply` to detect changes (only update what changed)
- Should NOT be committed to git (add `tofu/terraform.tfstate*` to `.gitignore`)
- Is ephemeral in Docker (recreated on every `docker compose up`)

### Provider

```hcl
terraform {
  required_providers {
    keycloak = {
      source  = "keycloak/keycloak"   # official — NOT mrparkers/keycloak (archived)
      version = "~> 5.0"
    }
  }
}
```

---

## 8. Registering the MCP Server with Claude Code

### With OAuth (correct for this setup)
```bash
claude mcp add \
  --transport http \
  --client-id mcp-client \        # skip DCR, use pre-registered client
  issue-tracker \
  http://127.0.0.1:3002/mcp
```

`--client-id mcp-client` is critical. Without it, Claude Code attempts Dynamic
Client Registration (DCR), which Keycloak blocks for anonymous clients by
default. Since `mcp-client` is already registered in Keycloak via OpenTofu,
we tell Claude Code to use it directly.

### Checking status
```bash
claude mcp list
# issue-tracker: http://127.0.0.1:3002/mcp (HTTP) - ! Needs authentication
# → not yet logged in

# After /mcp authentication:
# issue-tracker: http://127.0.0.1:3002/mcp (HTTP) - ✓ Connected
```

### Authenticating (first time per session)
In any Claude Code session (CLI or VS Code):
```
/mcp
```
Select `issue-tracker` → browser opens to Keycloak login → log in as
`alice` / `alice123` or `bob` / `bob123` → token is cached.

After this, all MCP tool calls work transparently. Token refreshes happen
silently (access token expires after 15min, session lasts 8h).

---

## 9. Verifying the Setup Manually

```bash
# 1. Keycloak health
curl http://localhost:8080/realms/issue-tracker/.well-known/openid-configuration \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['issuer'])"
# → http://localhost:8080/realms/issue-tracker

# 2. MCP auth metadata (no token needed — public)
curl http://127.0.0.1:3002/.well-known/oauth-protected-resource/mcp | python3 -m json.tool
# → { "resource": "http://127.0.0.1:3002/mcp", "authorization_servers": [...], ... }

# 3. MCP 401 challenge (no token)
curl -si -X POST http://127.0.0.1:3002/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"test","version":"1.0"},"capabilities":{}}}' \
  | grep "WWW-Authenticate"
# → WWW-Authenticate: Bearer error="invalid_token" ... resource_metadata="..."

# 4. Get a token (password grant — for testing only, not for production)
TOKEN=$(curl -s -X POST \
  http://localhost:8080/realms/issue-tracker/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=mcp-client&username=alice&password=alice123&scope=mcp:tools" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# 5. Call MCP with token
curl -s -X POST http://127.0.0.1:3002/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"test","version":"1.0"},"capabilities":{}}}' \
  2>&1 | grep "^data:"
```

---

## 10. Bugs Hit and Fixes

| Bug | Cause | Fix |
|---|---|---|
| `NullPointerException: authority() is null` | Keycloak 26 requires HTTP/1.1 `Host` header; healthcheck sent HTTP/1.0 | Rewrote healthcheck using `printf` with `\r\n` and `Host:` header |
| Healthcheck stuck on `health: starting` | `grep -q '"status":"UP"'` didn't match `"status": "UP"` (space after colon) | Changed to `grep -q 'UP'` |
| `tofu: command not found / no command named "sh"` | OpenTofu image has `tofu` as entrypoint; `command: sh -c "..."` became `tofu sh -c "..."` | Added `entrypoint: ["/bin/sh", "-c"]` to override the image entrypoint |
| `Protected resource does not match expected` | `MCP_SERVER_URL=http://localhost:3002` but Claude Code registered `http://127.0.0.1:3002/mcp` — host and path mismatch | Changed to `MCP_SERVER_URL=http://127.0.0.1:3002/mcp` + updated tofu audience variable |
| `Incompatible auth server: does not support dynamic client registration` | Claude Code tried DCR; Keycloak blocks anonymous DCR by default | Re-registered with `claude mcp add --client-id mcp-client` to use pre-registered client |

---

## 11. Next Steps (Not Yet Implemented)

- **Roles/RBAC**: add Keycloak roles (e.g. `viewer`, `editor`) and check them in
  the MCP tool handlers to restrict who can create/delete issues
- **Persistent storage**: current Next.js store is in-memory and resets on restart;
  replace with a real database to make tool actions durable
- **HTTPS**: for any deployment beyond localhost, Keycloak and the MCP server must
  use HTTPS — Keycloak will refuse to issue tokens over HTTP in production mode
- **Secret management**: `mcp_server_client_secret` is currently hardcoded in
  `docker-compose.yml`; use Docker secrets or a vault in production
- **Token caching**: current implementation calls Keycloak introspection on every
  single request; add a short TTL cache keyed on token hash to reduce latency
