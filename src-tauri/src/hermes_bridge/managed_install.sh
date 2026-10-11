
set -euo pipefail

runtime_dir="${JUNE_HERMES_RUNTIME_DIR:?}"
install_dir="${JUNE_HERMES_INSTALL_DIR:?}"
hermes_home="${JUNE_HERMES_HOME:?}"
install_commit="${JUNE_HERMES_INSTALL_COMMIT:?}"
source_tarball_url="${JUNE_HERMES_SOURCE_TARBALL_URL:?}"
source_tarball_sha256="${JUNE_HERMES_SOURCE_TARBALL_SHA256:?}"

mkdir -p "$runtime_dir" "$hermes_home"

if [ ! -f "$install_dir/pyproject.toml" ] || [ ! -f "$install_dir/scripts/install.sh" ]; then
  tmp_dir="$(mktemp -d "$runtime_dir/download.XXXXXX")"
  cleanup() { rm -rf "$tmp_dir"; }
  trap cleanup EXIT
  curl -LsSf "$source_tarball_url" -o "$tmp_dir/hermes-agent.tar.gz"
  actual_sha256="$(shasum -a 256 "$tmp_dir/hermes-agent.tar.gz" | awk '{print $1}')"
  if [ "$actual_sha256" != "$source_tarball_sha256" ]; then
    echo "Hermes source archive checksum mismatch." >&2
    echo "expected: $source_tarball_sha256" >&2
    echo "actual:   $actual_sha256" >&2
    exit 1
  fi
  tar -xzf "$tmp_dir/hermes-agent.tar.gz" -C "$tmp_dir"
  unpacked_dir="$(find "$tmp_dir" -maxdepth 1 -type d -name 'hermes-agent-*' | head -n 1)"
  if [ -z "$unpacked_dir" ]; then
    echo "Hermes source archive did not contain a hermes-agent directory." >&2
    exit 1
  fi
  rm -rf "$install_dir"
  mkdir -p "$(dirname "$install_dir")"
  mv "$unpacked_dir" "$install_dir"
fi

# Upstream's install.sh (v2026.7.20) runs $UV_CMD unquoted in the venv-create,
# uv-sync, and pip-install-tier calls. The managed uv it installs lives under
# the app data dir — "Application Support" on macOS — so the space word-splits
# the path and every one of those calls fails with "/Users/…/Library/
# Application: No such file or directory". Quote the bare uses after
# extraction. Idempotent (an already-quoted $UV_CMD is preceded by a quote,
# which the pattern excludes) and applied outside the download guard so a
# previously extracted tree gets patched on retry too.
sed -e 's/^\$UV_CMD/"$UV_CMD"/g' \
  -e 's/\([^"]\)\$UV_CMD/\1"$UV_CMD"/g' "$install_dir/scripts/install.sh" \
  > "$install_dir/scripts/install.sh.quoted"
mv "$install_dir/scripts/install.sh.quoted" "$install_dir/scripts/install.sh"

# Fix the plugins/cron sys.path shadow that 500s the Routines page (mirror of
# scripts/patch-hermes-cron-shadow.sh). The raft and discord platform adapters
# insert their grandparent (hermes-agent/plugins) at sys.path[0], so top-level
# `import cron` finds the plugins/cron plugin instead of the core cron package
# and every dashboard cron endpoint raises ImportError -> HTTP 500. Point the
# insert at the hermes-agent root (parents[3]) instead. Scoped to just these
# two files (the gateway/platforms/*.py inserts are one level shallower, so
# their parents[2] is already the root and must be left alone). Idempotent and
# applied outside the download guard so a retry re-patches an existing tree.
for cron_shadow_rel in plugins/platforms/raft/adapter.py plugins/platforms/discord/adapter.py; do
  cron_shadow_file="$install_dir/$cron_shadow_rel"
  [ -f "$cron_shadow_file" ] || continue
  sed -e 's/resolve()\.parents\[2\]))/resolve().parents[3]))/g' \
    "$cron_shadow_file" > "$cron_shadow_file.cron-shadow"
  mv "$cron_shadow_file.cron-shadow" "$cron_shadow_file"
done

# Accept the Windows webview origin (http://tauri.localhost) on WebSocket
# upgrades (mirror of scripts/patch-hermes-ws-origin.sh — see it for the root
# cause). The /api/ws DNS-rebinding guard only accepts http(s) Origins whose
# host is in _LOOPBACK_HOST_VALUES; the Windows Tauri webview lives on
# http://tauri.localhost, so every chat WebSocket handshake was refused.
# *.localhost is loopback-only per RFC 6761, so no rebinding surface is added.
# Anchored to the indented member line (the unindented twin inside
# _local_dashboard_request must stay untouched). Idempotent (a patched line no
# longer matches) and outside the download guard so retries re-patch.
ws_origin_file="$install_dir/hermes_cli/web_server.py"
if [ -f "$ws_origin_file" ]; then
  sed -e 's/^    "localhost", "127\.0\.0\.1", "::1",$/    "localhost", "127.0.0.1", "::1", "tauri.localhost",/' \
    "$ws_origin_file" > "$ws_origin_file.ws-origin"
  mv "$ws_origin_file.ws-origin" "$ws_origin_file"
fi

# Give this Hermes home its own gateway service (mirror of
# scripts/patch-hermes-service-label.sh, see it for the root cause): any home
# outside ~/.hermes counted as the default root and claimed the bare
# ai.hermes.gateway / Hermes_Gateway names, so Sub Rosa's homes and a
# standalone Hermes took over one another's gateway. Only the first
# `if home == default:` inside _profile_suffix (_profile_arg has the same
# line). Idempotent and outside the download guard so retries re-patch.
service_label_file="$install_dir/hermes_cli/gateway.py"
if [ -f "$service_label_file" ] && ! grep -qF 'patch-hermes-service-label' "$service_label_file"; then
  awk '
    $0 == "def _profile_suffix() -> str:" { inside = 1; print; next }
    inside && /^def / { inside = 0 }
    inside && !done && $0 == "    if home == default:" {
      print "    # Sub Rosa (patch-hermes-service-label.sh): only the platform home is the default."
      print "    from hermes_constants import _get_platform_default_hermes_home"
      print "    if home == default and home == _get_platform_default_hermes_home().resolve():"
      done = 1
      next
    }
    { print }
    END { if (!done) exit 3 }
  ' "$service_label_file" > "$service_label_file.service-label"
  mv "$service_label_file.service-label" "$service_label_file"
fi

run_stage() {
  local stage="$1"
  HERMES_HOME="$hermes_home" HERMES_INSTALL_DIR="$install_dir" \
    bash "$install_dir/scripts/install.sh" \
      --dir "$install_dir" \
      --hermes-home "$hermes_home" \
      --stage "$stage" \
      --json \
      --non-interactive
}

run_stage venv
run_stage python-deps
run_stage node-deps
run_stage config
run_stage complete

cat > "$runtime_dir/runtime.json" <<EOF
{"source":"NousResearch/hermes-agent","commit":"$install_commit","patches":"${JUNE_HERMES_PATCHES:?}","installDir":"$install_dir"}
EOF
