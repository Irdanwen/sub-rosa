#!/bin/bash
set -euo pipefail
export KC_DB_PASSWORD="$(< /run/private/keycloak-password)"
# Temporary administrator only: create a permanent passkey/TOTP-protected admin,
# remove the bootstrap account, then delete this private file before next start.
if [[ -s /run/private/keycloak-admin-password ]]; then
  export KC_BOOTSTRAP_ADMIN_USERNAME=subrosa-bootstrap
  export KC_BOOTSTRAP_ADMIN_PASSWORD="$(< /run/private/keycloak-admin-password)"
fi
mkdir -p /opt/keycloak/data/import
cp /run/private/subrosa-realm.json /opt/keycloak/data/import/subrosa-realm.json
exec /opt/keycloak/bin/kc.sh start --optimized --import-realm
