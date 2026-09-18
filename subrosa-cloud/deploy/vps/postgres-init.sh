#!/bin/sh
set -eu
psql --username postgres --dbname postgres --no-psqlrc --set ON_ERROR_STOP=1 --file /run/private/roles.sql >/dev/null
