#!/usr/bin/env bash
# Fix the bundled-Hermes WebSocket Origin guard that breaks the chat on
# Windows with "Could not connect to Hermes gateway."
#
# Root cause (diagnosed on a user machine, 2026-07-09):
#   hermes_cli/web_server.py guards /api/ws (and /api/pty) upgrades against
#   DNS rebinding: when the handshake carries an http(s) Origin header, its
#   host must be in _LOOPBACK_HOST_VALUES = {localhost, 127.0.0.1, ::1}.
#   On Windows the Tauri v2 webview serves the app from http://tauri.localhost
#   (WebView2 has no custom-scheme pages), so every chat WebSocket presents
#   Origin: http://tauri.localhost -> origin_mismatch -> ws.close(4403)
#   BEFORE accept -> the browser sees a failed handshake and June shows the
#   connection banner. macOS is unaffected because WKWebView pages live on
#   tauri://localhost, a non-web scheme the guard deliberately exempts. All
#   HTTP traffic is proxied through Rust, so only the WebSocket breaks --
#   which is why the model/credits work while the chat does not.
#
# Fix: add "tauri.localhost" to _LOOPBACK_HOST_VALUES. RFC 6761 requires
# *.localhost to resolve to loopback (Chromium hard-enforces this), so the
# entry adds no rebinding surface: an attacker page cannot present Origin
# http://tauri.localhost without already being served from loopback. The
# evil.test rebinding case stays rejected (verified against the pinned
# guard logic before shipping). Idempotent; a no-op if upstream adds it.
#
# Usage: patch-hermes-ws-origin.sh <hermes-agent-dir>
set -euo pipefail

agent_dir="${1:?usage: patch-hermes-ws-origin.sh <hermes-agent-dir>}"

log() { printf '\033[1;34m[patch-ws-origin]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[patch-ws-origin]\033[0m %s\n' "$*" >&2; exit 1; }

f="$agent_dir/hermes_cli/web_server.py"
[ -f "$f" ] || die "hermes_cli/web_server.py not found under $agent_dir"

# The exact member line of the _LOOPBACK_HOST_VALUES frozenset (unique in the
# file; the similarly-shaped _LOOPBACK_HOSTS literal lists its members in a
# different order on one line, so it cannot match).
bad='    "localhost", "127.0.0.1", "::1",'
good='    "localhost", "127.0.0.1", "::1", "tauri.localhost",'

if grep -qF '"tauri.localhost"' "$f"; then
  log "already patched: hermes_cli/web_server.py"
  exit 0
fi
grep -qF "$bad" "$f" || die "web_server.py: expected _LOOPBACK_HOST_VALUES line not found — upstream changed, re-audit the ws-origin fix"

# Whole-line equality via awk, like patch-hermes-cron-shadow.sh — no regex, so
# the quotes/dots in the line cannot be misread as metacharacters.
tmp="$f.ws-origin.tmp"
awk -v bad="$bad" -v good="$good" '{ if ($0 == bad) { print good } else { print } }' "$f" > "$tmp"
grep -qF '"tauri.localhost"' "$tmp" || die "web_server.py: replacement did not take"
mv "$tmp" "$f"
log "patched: hermes_cli/web_server.py (_LOOPBACK_HOST_VALUES += tauri.localhost)"
