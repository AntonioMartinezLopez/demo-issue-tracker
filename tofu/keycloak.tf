# ============================================================
# REALM
# ============================================================
# A realm is Keycloak's top-level namespace — users, clients,
# and scopes all live inside a realm. We create a dedicated
# "issue-tracker" realm so it's isolated from the built-in
# "master" realm (which should only be used for Keycloak admin).
resource "keycloak_realm" "issue_tracker" {
  realm   = "issue-tracker"
  enabled = true

  display_name = "Issue Tracker"

  # Token lifetimes — short for security, longer for demo convenience.
  access_token_lifespan = "15m"
  sso_session_max_lifespan = "8h"
}

# ============================================================
# CLIENT SCOPE: mcp:tools
# ============================================================
# A scope represents a permission that a client can request.
# We use "mcp:tools" to gate access to all MCP tools.
# Clients (agents) must include this scope in their OAuth request
# to receive a token that the MCP server will accept.
resource "keycloak_openid_client_scope" "mcp_tools" {
  realm_id    = keycloak_realm.issue_tracker.id
  name        = "mcp:tools"
  description = "Grants access to all Issue Tracker MCP tools."

  # "Include in token scope" = the scope name appears in the token's "scope" claim.
  # Required so the MCP server can verify the token has the right permission.
  include_in_token_scope = true
}

# ============================================================
# AUDIENCE MAPPER on the mcp:tools scope
# ============================================================
# The "aud" (audience) claim in a JWT names the intended recipient.
# The MCP server rejects tokens whose audience doesn't match its own URL.
# This mapper adds the MCP server URL to "aud" whenever the mcp:tools
# scope is included in a token — which is exactly when we want it.
resource "keycloak_openid_audience_protocol_mapper" "mcp_tools_audience" {
  realm_id        = keycloak_realm.issue_tracker.id
  client_scope_id = keycloak_openid_client_scope.mcp_tools.id
  name            = "mcp-server-audience"

  # The value that will appear in the token's "aud" claim.
  # Must match MCP_SERVER_URL in the MCP server's config.
  included_custom_audience = var.mcp_server_url
}

# ============================================================
# CLIENT: mcp-server (confidential)
# ============================================================
# This client represents the MCP server itself when it talks
# back to Keycloak — specifically for token introspection
# (verifying that a token an agent sent is valid).
#
# It is "confidential" because it holds a client secret.
# The secret is known only to the MCP server process.
resource "keycloak_openid_client" "mcp_server" {
  realm_id  = keycloak_realm.issue_tracker.id
  client_id = "mcp-server"
  name      = "MCP Server (resource server)"
  enabled   = true

  # CONFIDENTIAL = server-side app that can keep a secret.
  access_type = "CONFIDENTIAL"

  # service_accounts_enabled lets this client authenticate as itself
  # (client_credentials grant) — needed for introspection.
  service_accounts_enabled = true

  # Standard flows are not needed for the resource server itself.
  standard_flow_enabled = false

  # Pin the client secret to a known value so docker-compose can pass it
  # to the MCP server as an env var without a dynamic lookup step.
  # In production, use a secrets manager and rotate regularly.
  client_secret = var.mcp_server_client_secret
}

# ============================================================
# CLIENT: mcp-client (public, for agents / Claude Code)
# ============================================================
# This client is what Claude Code (or any other MCP agent) uses
# to go through the OAuth flow on behalf of a user.
#
# It is "PUBLIC" because there is no server-side component that
# can keep a secret — the agent runs on the user's machine.
# Public clients must use PKCE (Proof Key for Code Exchange)
# to prevent authorization code interception attacks.
resource "keycloak_openid_client" "mcp_client" {
  realm_id  = keycloak_realm.issue_tracker.id
  client_id = "mcp-client"
  name      = "MCP Client (agent)"
  enabled   = true

  access_type           = "PUBLIC"
  standard_flow_enabled = true  # authorization code flow

  # PKCE is enforced by requiring S256 — the only secure method.
  pkce_code_challenge_method = "S256"

  # Where Keycloak is allowed to redirect after login.
  # Claude Code uses localhost callbacks during the OAuth dance.
  valid_redirect_uris = [
    "http://localhost:*",
    "http://127.0.0.1:*",
  ]

  # Allow requests from these origins (for browser-based flows).
  web_origins = ["+"]  # "+" means: allow all valid_redirect_uri origins
}

# Add mcp:tools as an optional scope on the public client.
# "Optional" means the agent explicitly requests it; it's not added automatically.
# This is safer than making it a default scope.
resource "keycloak_openid_client_optional_scopes" "mcp_client_optional_scopes" {
  realm_id  = keycloak_realm.issue_tracker.id
  client_id = keycloak_openid_client.mcp_client.id

  optional_scopes = [
    "mcp:tools",
    "offline_access",
  ]
}

# ============================================================
# DEMO USERS
# ============================================================
# Two users for testing different access scenarios.

resource "keycloak_user" "alice" {
  realm_id   = keycloak_realm.issue_tracker.id
  username   = "alice"
  enabled    = true
  email      = "alice@example.com"
  first_name = "Alice"
  last_name  = "Developer"

  initial_password {
    value     = "alice123"
    temporary = false  # user won't be forced to change on first login
  }
}

resource "keycloak_user" "bob" {
  realm_id   = keycloak_realm.issue_tracker.id
  username   = "bob"
  enabled    = true
  email      = "bob@example.com"
  first_name = "Bob"
  last_name  = "Developer"

  initial_password {
    value     = "bob123"
    temporary = false
  }
}
