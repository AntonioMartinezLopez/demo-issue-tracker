// dotenv must load before any process.env reads, so this side-effect import
// goes first. All other modules import CONFIG from here rather than reading
// process.env directly.
import "dotenv/config";
import process from "node:process";

export const CONFIG = {
  // Network binding
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3002),

  // The external URL of THIS server — what clients type in to reach us.
  // Also embedded in Keycloak tokens as the "aud" (audience) claim.
  // Must match the audience configured in tofu/keycloak.tf.
  mcpServerUrl: process.env.MCP_SERVER_URL ?? "http://localhost:3002",

  // External Keycloak URL (what clients/browsers use to reach Keycloak).
  // Embedded in the auth metadata we expose so agents can find the auth endpoints.
  keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:8080",

  // Internal Keycloak URL (what THIS server uses to call Keycloak for introspection).
  // Inside Docker this is "http://keycloak:8080" even though clients reach it at localhost:8080.
  keycloakInternalUrl:
    process.env.KEYCLOAK_INTERNAL_URL ??
    process.env.KEYCLOAK_URL ??
    "http://localhost:8080",

  keycloakRealm: process.env.KEYCLOAK_REALM ?? "issue-tracker",

  // Credentials for the "mcp-server" Keycloak client (used for token introspection).
  oauthClientId: process.env.OAUTH_CLIENT_ID ?? "mcp-server",
  oauthClientSecret: process.env.OAUTH_CLIENT_SECRET ?? "",

  // Issue Tracker API base URL (internal Docker address in Docker mode).
  issueTrackerUrl: process.env.ISSUE_TRACKER_URL ?? "http://localhost:3001/api",
};

// Parsed URL object for the MCP server — needed by SDK helpers that accept URL, not string.
export const mcpServerUrl = new URL(CONFIG.mcpServerUrl);

// Keycloak realm base paths, split into external (clients use) and internal (server uses).
const realmExternal = `${CONFIG.keycloakUrl}/realms/${CONFIG.keycloakRealm}`;
const realmInternal = `${CONFIG.keycloakInternalUrl}/realms/${CONFIG.keycloakRealm}`;

export const keycloakUrls = {
  // Exposed in our auth metadata so clients can discover the authorization server.
  external: {
    issuer:                  realmExternal + "/",
    authorization_endpoint:  realmExternal + "/protocol/openid-connect/auth",
    token_endpoint:          realmExternal + "/protocol/openid-connect/token",
    introspection_endpoint:  realmExternal + "/protocol/openid-connect/token/introspect",
  },
  // Used server-to-server to avoid Docker DNS issues.
  internal: {
    introspection_endpoint: realmInternal + "/protocol/openid-connect/token/introspect",
  },
};

// Exported for the startup log in index.ts.
export { realmExternal };
