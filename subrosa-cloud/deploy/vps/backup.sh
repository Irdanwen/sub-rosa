#!/bin/bash
# Produces encrypted logical backups only. Scheduling, offsite upload and a
# successful restore rehearsal are required separately before registration.
set -euo pipefail
umask 077
if [[ $# != 3 ]]; then
  echo 'Usage: backup.sh /private/stack /path/public-age-recipients.txt /private/output-directory' >&2
  exit 2
fi
stack_dir=$1
recipients=$2
output=$3
command -v age >/dev/null
[[ -f "$recipients" && -d "$output" ]]
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
compose=(docker compose --env-file "$stack_dir/stack.env" -f "$script_dir/compose.yaml")
backup_id=$(date -u +%Y%m%dT%H%M%SZ)
# Random suffix avoids overwriting another invocation. No plaintext dump file.
archive=$(mktemp "$output/subrosa-$backup_id.XXXXXXXX.age")
trap 'rm -f -- "$archive"' ERR
{
  "${compose[@]}" exec -T postgres pg_dumpall -U postgres --globals-only --no-role-passwords
  "${compose[@]}" exec -T postgres pg_dump -U postgres --create --clean --if-exists subrosa
  "${compose[@]}" exec -T postgres pg_dump -U postgres --create --clean --if-exists keycloak
} | age -R "$recipients" >"$archive"
chmod 0600 "$archive"
echo 'Encrypted logical backup created. Offsite delivery and restore verification remain required.'
