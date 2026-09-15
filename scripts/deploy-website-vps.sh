#!/usr/bin/env bash
# Publish an already-built English /subrosa website without touching application
# containers. Keep every prior release for an explicit, atomic rollback.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_host="${SUBROSA_DEPLOY_HOST:-root@178.104.103.33}"
deploy_key="${SUBROSA_DEPLOY_KEY:-$HOME/.ssh/id_ed25519}"
deploy_id="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$repo_root" rev-parse --short HEAD)-$(openssl rand -hex 6)"
deploy_root="/srv/subrosa"
ssh_args=(-i "$deploy_key" -o BatchMode=yes -o ConnectTimeout=15)

test -s "$repo_root/website/dist/index.html"
if ! rg -q '/subrosa/assets/' "$repo_root/website/dist/index.html"; then
  echo 'Build the website with VITE_SITE_BASE=/subrosa/ before deployment.' >&2
  exit 1
fi

ssh "${ssh_args[@]}" "$deploy_host" \
  "install -d -m 755 '$deploy_root/releases' '$deploy_root/www' && mkdir -m 755 '$deploy_root/releases/$deploy_id'"
# Only public build output is sent; repository configuration and secrets are not.
rsync -az -e "ssh -i '$deploy_key' -o BatchMode=yes" \
  "$repo_root/website/dist/" "$deploy_host:$deploy_root/releases/$deploy_id/"

ssh "${ssh_args[@]}" "$deploy_host" bash -s -- "$deploy_id" <<'REMOTE'
set -euo pipefail
deploy_id="$1"
deploy_root=/srv/subrosa
previous="$(readlink "$deploy_root/www/subrosa" || true)"
test -s "$deploy_root/releases/$deploy_id/index.html"
chmod -R a+rX "$deploy_root/releases/$deploy_id"
ln -s "$deploy_root/releases/$deploy_id" "$deploy_root/www/.subrosa-$deploy_id"
mv -Tf "$deploy_root/www/.subrosa-$deploy_id" "$deploy_root/www/subrosa"
if ! curl --fail --silent --show-error --resolve furetier.com:443:127.0.0.1 \
  https://furetier.com/subrosa/ -o /dev/null; then
  if [ -n "$previous" ] && [ "$(readlink "$deploy_root/www/subrosa")" = "$deploy_root/releases/$deploy_id" ]; then
    ln -s "$previous" "$deploy_root/www/.subrosa-rollback-$deploy_id"
    mv -Tf "$deploy_root/www/.subrosa-rollback-$deploy_id" "$deploy_root/www/subrosa"
  fi
  echo 'Website verification failed; prior release restored when available.' >&2
  exit 1
fi
echo "Published $deploy_id at https://furetier.com/subrosa/"
REMOTE
