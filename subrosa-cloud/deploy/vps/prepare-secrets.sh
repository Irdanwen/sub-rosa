#!/bin/sh
set -eu
# Compose bind-file secrets ignore uid/gid remapping. A one-shot root container
# installs each file for its actual runtime UID; no credential is printed.
umask 077
install -d -m 0755 /prepared
install -d -o 10001 -g 10001 -m 0700 /prepared/runtime
install -d -o 10002 -g 10002 -m 0700 /prepared/migration
for file in /source/*; do
  [ -f "$file" ] || continue
  name=$(basename "$file")
  case "$name" in
    postgres-password|roles.sql|postgres.key) owner=999 ;;
    keycloak-password|keycloak-admin-password|subrosa-realm.json) owner=1000 ;;
    runtime.toml) owner=10001 ;;
    migration.toml|migrator.pgpass) owner=10002 ;;
    postgres.crt|postgres-ca.crt) owner=0 ;;
    *) continue ;;
  esac
  case "$name" in
    runtime.toml) destination=/prepared/runtime/config.toml ;;
    migration.toml) destination=/prepared/migration/config.toml ;;
    *) destination="/prepared/$name" ;;
  esac
  install -o "$owner" -g "$owner" -m 0600 "$file" "$destination"
done
# Public certificates are deliberately readable by all three TLS clients.
chmod 0644 /prepared/postgres.crt /prepared/postgres-ca.crt
# Removing the source bootstrap password must remove the previously copied one.
if [ ! -f /source/keycloak-admin-password ]; then rm -f /prepared/keycloak-admin-password; fi
