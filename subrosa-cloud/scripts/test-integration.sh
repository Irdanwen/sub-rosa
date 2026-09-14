#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${SUBROSA_TEST_DATABASE_URL:-}" ]]; then
    cargo test --workspace
    exit
fi
if ! command -v initdb >/dev/null || ! command -v pg_ctl >/dev/null; then
    echo 'Install PostgreSQL or set SUBROSA_TEST_DATABASE_URL to an isolated test database admin URL.' >&2
    exit 1
fi
cluster="$(mktemp -d "${TMPDIR:-/tmp}/subrosa-tests.XXXXXX")"
port="${SUBROSA_TEST_PORT:-55439}"
cleanup() {
    pg_ctl -D "$cluster/data" -m fast stop >/dev/null 2>&1 || true
    rm -rf "$cluster"
}
trap cleanup EXIT INT TERM
initdb -D "$cluster/data" -A trust -U postgres >/dev/null
pg_ctl -D "$cluster/data" -l "$cluster/postgres.log" -o "-p $port -h 127.0.0.1" start >/dev/null
SUBROSA_TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$port/postgres" cargo test --workspace
