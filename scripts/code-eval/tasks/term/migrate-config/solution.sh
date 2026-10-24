#!/bin/sh
cat > app.toml <<'T'
[server]
host = "0.0.0.0"
port = 8080
workers = 4

[database]
url = "postgres://report@db.internal:5432/reports"
pool_size = 10
timeout_seconds = 2.5

[features]
exports = true
beta_dashboard = false
T
cat > load_config.py <<'P'
"""Loads the service configuration."""
import tomllib
from pathlib import Path


def load(path=Path(__file__).with_name("app.toml")):
    with open(path, "rb") as handle:
        return tomllib.load(handle)


if __name__ == "__main__":
    print(load())
P
rm app.ini
