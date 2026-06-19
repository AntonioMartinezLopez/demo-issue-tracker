// Auth layer: token verification via Keycloak introspection, OAuth metadata,
// and the two Express middlewares used in http.ts.
//
// TWO KEYCLOAK URL ROLES
// ----------------------
// - keycloakUrls.external  → embedded in metadata for clients (browsers must reach this)
// - keycloakUrls.internal  → used here for introspection (server-to-server, Docker-safe)
//
// AUTH FLOW OVERVIEW
// ------------------
// 1. Agent sends POST /mcp with no token
// 2. Server returns 401 + WWW-Authenticate pointing to /.well-known/oauth-protected-resource/mcp
// 3. Agent fetches that URL and learns: "Keycloak is the auth server, request mcp:tools scope"
// 4. Agent fetches Keycloak OIDC discovery to find authorization_endpoint and token_endpoint
// 5. Agent opens browser → user logs in via PKCE
// 6. Agent gets an access token
// 7. Agent sends POST /mcp with "Authorization: Bearer <token>"
// 8. Server calls Keycloak introspection endpoint to validate the token
// 9. Valid → request processed. Invalid → 401 again.

import {
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";

import { CONFIG, mcpServerUrl, keycloakUrls } from "./config.js";

// What we advertise to clients at /.well-known/oauth-protected-resource/mcp.
// Clients read this to discover Keycloak and start the OAuth flow.
const oauthMetadata: OAuthMetadata = {
  ...keycloakUrls.external,
  response_types_supported: ["code"],
};

// OAuthTokenVerifier implementation: validates tokens via Keycloak introspection (RFC 7662).
//
// Alternative: local JWT validation using Keycloak's public key — faster but requires
// key rotation handling. Introspection is simpler and correct for a demo.
const tokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const response = await fetch(keycloakUrls.internal.introspection_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        client_id: CONFIG.oauthClientId,
        client_secret: CONFIG.oauthClientSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Introspection request failed: ${response.status}`);
    }

    const data = (await response.json()) as Record<string, unknown>;

    // "active: false" means the token is expired, revoked, or invalid.
    if (data.active === false) {
      throw new Error("Token is inactive or expired");
    }

    // Validate audience — the token must have been issued FOR this server.
    // This prevents "token passthrough" attacks where a valid token issued
    // for a different service is replayed against our server.
    const audiences = Array.isArray(data.aud)
      ? (data.aud as string[])
      : typeof data.aud === "string"
      ? [data.aud]
      : [];

    const audienceIsValid = audiences.some((aud) =>
      checkResourceAllowed({ requestedResource: aud, configuredResource: mcpServerUrl })
    );

    if (!audienceIsValid) {
      throw new Error(
        `Token audience [${audiences.join(", ")}] does not match this server (${CONFIG.mcpServerUrl})`
      );
    }

    return {
      token,
      clientId: String(data.client_id ?? ""),
      scopes: typeof data.scope === "string" ? data.scope.split(" ") : [],
      expiresAt: typeof data.exp === "number" ? data.exp : undefined,
    };
  },
};

// URL of the protected-resource metadata endpoint — included in 401 WWW-Authenticate headers.
export const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpServerUrl);

// Public middleware: serves /.well-known/oauth-protected-resource/mcp
// Must be mounted BEFORE authMiddleware so unauthenticated clients can discover auth.
export const authMetadataMiddleware = mcpAuthMetadataRouter({
  oauthMetadata,
  resourceServerUrl: mcpServerUrl,
  scopesSupported: ["mcp:tools"],
  resourceName: "Issue Tracker MCP Server",
});

// Protected middleware: requires a valid Bearer token with the mcp:tools scope.
// Calls tokenVerifier.verifyAccessToken on every request.
export const authMiddleware = requireBearerAuth({
  verifier: tokenVerifier,
  requiredScopes: ["mcp:tools"],
  resourceMetadataUrl,
});
