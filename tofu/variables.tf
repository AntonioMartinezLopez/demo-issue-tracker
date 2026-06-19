variable "keycloak_url" {
  description = "Base URL of the Keycloak server (as seen from OpenTofu's network)."
  type        = string
  default     = "http://keycloak:8080"
  # When running OpenTofu locally (outside Docker), override this:
  #   tofu apply -var keycloak_url=http://localhost:8080
}

variable "keycloak_admin_user" {
  description = "Keycloak bootstrap admin username."
  type        = string
  default     = "admin"
}

variable "keycloak_admin_password" {
  description = "Keycloak bootstrap admin password."
  type        = string
  default     = "admin"
  sensitive   = true
}

variable "mcp_server_url" {
  description = <<-EOT
    External URL of the MCP server — the address that clients (Claude Code,
    browsers) use to reach it. This is embedded into Keycloak tokens as the
    "aud" (audience) claim so the MCP server can verify a token was meant for it.
  EOT
  type    = string
  default = "http://localhost:3002"
}

variable "mcp_server_client_secret" {
  description = "Client secret for the mcp-server Keycloak client (used for token introspection)."
  type        = string
  default     = "mcp-server-secret"
  sensitive   = true
}
