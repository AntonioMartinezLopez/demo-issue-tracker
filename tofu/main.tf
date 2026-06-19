terraform {
  required_providers {
    # Official Keycloak provider (the mrparkers fork is archived — use this one).
    keycloak = {
      source  = "keycloak/keycloak"
      version = "~> 5.0"
    }
  }
}

# The provider talks to Keycloak's admin API using the built-in admin-cli client.
# These credentials match the KC_BOOTSTRAP_ADMIN_USERNAME / PASSWORD in docker-compose.
# In production, use a dedicated service account with minimal permissions.
provider "keycloak" {
  client_id = "admin-cli"
  username  = var.keycloak_admin_user
  password  = var.keycloak_admin_password
  url       = var.keycloak_url
}
