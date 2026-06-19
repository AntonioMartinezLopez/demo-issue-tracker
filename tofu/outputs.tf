# Outputs are printed after "tofu apply" and useful for verifying the setup.

output "realm" {
  value       = keycloak_realm.issue_tracker.realm
  description = "The Keycloak realm name."
}

output "mcp_server_client_id" {
  value       = keycloak_openid_client.mcp_server.client_id
  description = "Client ID for the MCP server (used for token introspection)."
}

output "mcp_client_client_id" {
  value       = keycloak_openid_client.mcp_client.client_id
  description = "Client ID for agents (Claude Code) to use in the OAuth flow."
}

output "oidc_discovery_url" {
  value       = "http://localhost:8080/realms/issue-tracker/.well-known/openid-configuration"
  description = "OIDC discovery endpoint — contains all Keycloak URLs for this realm."
}

output "demo_users" {
  value = {
    alice = { username = "alice", password = "alice123" }
    bob   = { username = "bob",   password = "bob123"  }
  }
  description = "Demo user credentials."
}
