#!/bin/sh
# Certbot deploy hook: pick up renewed certificates only with valid nginx config.
set -eu
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
