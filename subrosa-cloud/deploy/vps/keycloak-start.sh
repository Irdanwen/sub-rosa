#!/bin/bash
set -euo pipefail
export KC_DB_PASSWORD="$(< /run/private/keycloak-password)"
# Temporary administrator only, until `stack.py admin-rotate` creates the
# permanent one, deletes the bootstrap account and removes this private file.
if [[ -s /run/private/keycloak-admin-password ]]; then
  export KC_BOOTSTRAP_ADMIN_USERNAME=subrosa-bootstrap
  export KC_BOOTSTRAP_ADMIN_PASSWORD="$(< /run/private/keycloak-admin-password)"
fi
mkdir -p /opt/keycloak/data/import
cp /run/private/subrosa-realm.json /opt/keycloak/data/import/subrosa-realm.json
exec /opt/keycloak/bin/kc.sh start --optimized --import-realm
