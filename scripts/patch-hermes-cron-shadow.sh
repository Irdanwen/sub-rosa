#!/usr/bin/env bash
# Fix a bundled-Hermes import-hygiene bug that makes the Routines page fail
# with "Hermes API returned 500 Internal Server Error".
#
# Root cause (reproduced end to end, 2026-07-06):
#   plugins/platforms/raft/adapter.py  and  plugins/platforms/discord/adapter.py
#   both run, at import time:
#       sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
#   For an adapter at plugins/platforms/<name>/adapter.py, parents[2] is the
#   hermes-agent/plugins directory. Inserting THAT at sys.path[0] makes the
#   top-level name `cron` resolve to the plugins/cron scheduler-provider
#   package (which has no `jobs` submodule) instead of the core cron/ package.
#   Every dashboard cron endpoint then does `from cron import jobs` and dies
#   with `ImportError: cannot import name 'jobs' from 'cron'` -> HTTP 500.
#   It is intermittent because it only bites once a platform adapter loads and
#   its insert wins the sys.path[0] slot after web_server put the project root
#   there. The sibling gateway/platforms/*.py files are one directory shallower,
#   so THEIR parents[2] is already the hermes-agent root and they are harmless.
#
# Fix: point the two offending inserts at parents[3] (the hermes-agent root),
# matching what the gateway/platforms/*.py adapters already do. The root covers
# both `gateway.*` and `plugins.*` imports the adapter needs, and core `cron`
# stops being shadowed. Idempotent and verified; a no-op if upstream fixes it.
#
# Usage: patch-hermes-cron-shadow.sh <hermes-agent-dir>
set -euo pipefail

agent_dir="${1:?usage: patch-hermes-cron-shadow.sh <hermes-agent-dir>}"

log() { printf '\033[1;34m[patch-cron-shadow]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[patch-cron-shadow]\033[0m %s\n' "$*" >&2; exit 1; }

# The exact offending line, shared verbatim by both adapters.
bad='sys.path.insert(0, str(_Path(__file__).resolve().parents[2]))'
good='sys.path.insert(0, str(_Path(__file__).resolve().parents[3]))'

patched_any=0
for rel in plugins/platforms/raft/adapter.py plugins/platforms/discord/adapter.py; do
  f="$agent_dir/$rel"
  # Upstream may drop or rename an adapter; absence is not fatal.
  [ -f "$f" ] || { log "skip (absent): $rel"; continue; }

  if grep -qF "$good" "$f"; then
    log "already patched: $rel"
    patched_any=1
    continue
  fi
  grep -qF "$bad" "$f" || die "$rel: expected insert line not found — upstream changed, re-audit the cron-shadow fix"

  # Both adapters carry the insert as a full, unindented line, so match on
  # whole-line equality — no regex, so the brackets/parens in the line can't be
  # misread as metacharacters (awk sub() would treat them as a pattern).
  tmp="$f.cron-shadow.tmp"
  awk -v bad="$bad" -v good="$good" '{ if ($0 == bad) { print good } else { print } }' "$f" > "$tmp"
  grep -qF "$good" "$tmp" || die "$rel: replacement did not take"
  mv "$tmp" "$f"
  log "patched: $rel (parents[2] -> parents[3])"
  patched_any=1
done

[ "$patched_any" = 1 ] || die "no adapter files present to patch — hermes layout changed"
