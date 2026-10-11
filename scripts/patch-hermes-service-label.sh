#!/usr/bin/env bash
# Give every Hermes home its own gateway service, so Sub Rosa never takes
# over another Hermes' launchd job or Windows task.
#
# Root cause (diagnosed 2026-10-10, docs/qa/parity-1.89.1.md):
#   hermes_cli/gateway.py names the gateway service from _profile_suffix():
#   "" for the default root, the profile name under <root>/profiles/<name>,
#   else a short hash of HERMES_HOME. But get_default_hermes_root() returns
#   HERMES_HOME itself for any home outside ~/.hermes (the Docker layout), so
#   every such home is "the default root" and gets the bare names
#   ai.hermes.gateway (launchd), hermes-gateway (systemd) and Hermes_Gateway
#   (Windows task). Sub Rosa's release home, its debug home and a standalone
#   ~/.hermes all claimed the same service: whichever ran `gateway start` or
#   `gateway install` last rewrote it to point at its own home, and the
#   others lost their routines.
#
# Fix: a home is the default only when it is also the platform's own
#   (~/.hermes, %LOCALAPPDATA%\hermes). Any other home falls through to the
#   hash Hermes already uses for arbitrary paths, ai.hermes.gateway-<8 hex>.
#   The hash is of HERMES_HOME, which every gateway process has (the launchd
#   plist carries it), so the CLI, the daemon and the app agree on the name.
#   ~/.hermes and its profiles keep their names. The other readers of the
#   suffix are the s6 supervisor (containers only) and the multiplexer guard,
#   inert unless gateway.multiplex_profiles is on, which Sub Rosa never sets.
#   Installs that already hold the bare name are moved by the app
#   (src-tauri/src/hermes_bridge/gateway_label.rs). Idempotent.
#
# Mirrored in scripts/bundle-hermes-runtime-windows.ps1 and in both managed
# install scripts (src-tauri/src/hermes_bridge/managed-install.*).
#
# Usage: patch-hermes-service-label.sh <hermes-agent-dir>
set -euo pipefail

agent_dir="${1:?usage: patch-hermes-service-label.sh <hermes-agent-dir>}"

log() { printf '\033[1;34m[patch-service-label]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[patch-service-label]\033[0m %s\n' "$*" >&2; exit 1; }

f="$agent_dir/hermes_cli/gateway.py"
[ -f "$f" ] || die "hermes_cli/gateway.py not found under $agent_dir"

marker='patch-hermes-service-label'
if grep -qF "$marker" "$f"; then
  log "already patched: hermes_cli/gateway.py"
  exit 0
fi

# Only the first `if home == default:` inside _profile_suffix: _profile_arg
# has the same line and must keep it.
tmp="$f.service-label.tmp"
if ! awk -v marker="$marker" '
  $0 == "def _profile_suffix() -> str:" { inside = 1; print; next }
  inside && /^def / { inside = 0 }
  inside && !done && $0 == "    if home == default:" {
    print "    # Sub Rosa (" marker ".sh): only the platform home is the default."
    print "    from hermes_constants import _get_platform_default_hermes_home"
    print "    if home == default and home == _get_platform_default_hermes_home().resolve():"
    done = 1
    next
  }
  { print }
  END { if (!done) exit 3 }
' "$f" > "$tmp"; then
  rm -f "$tmp"
  die "gateway.py: expected _profile_suffix default-root test not found — upstream changed, re-audit the service-label fix"
fi
grep -qF "$marker" "$tmp" || die "gateway.py: replacement did not take"
mv "$tmp" "$f"
log "patched: hermes_cli/gateway.py (a HERMES_HOME of its own names its own service)"
