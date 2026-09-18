#!/usr/bin/env python3
"""Explicit local Compose actions. No credentials are placed in argv or printed."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import bootstrap


def environment(directory):
    result = {}
    for line in bootstrap.read_private(directory / "stack.env").splitlines():
        if line and not line.startswith("#"):
            key, value = line.split("=", 1)
            result[key] = value.strip("'")
    return result


def check_resources(env, application, running=()):
    def mib(name, default):
        match = re.fullmatch(r"([0-9]+)([mg])", env.get(name, default), re.I)
        if not match:
            raise ValueError("Use memory caps in whole MiB or GiB")
        return int(match[1]) * (1024 if match[2].lower() == "g" else 1)
    kc, pg, api = mib("KEYCLOAK_MEMORY", "2048m"), mib("POSTGRES_MEMORY", "384m"), mib("API_MEMORY", "384m")
    if kc < 768 or pg < 256 or api < 256:
        raise ValueError("Memory caps are below the deployment safety floor")
    wanted = {"keycloak": kc, "postgres": pg, **({"api": api} if application else {})}
    required = sum(cap for service, cap in wanted.items() if service not in running) + 256
    memory = Path("/proc/meminfo")
    if not memory.exists():
        raise ValueError("Resource preflight must run on the Linux deployment host")
    available = int(re.search(r"MemAvailable:\s+(\d+)", memory.read_text())[1]) // 1024
    if available < required:
        raise ValueError(f"Insufficient memory headroom: need {required} MiB available for the configured caps")
    # Preserve room for DB growth and image updates; this is not a backup policy.
    disk = os.statvfs("/var/lib/docker")
    if disk.f_bavail * disk.f_frsize < 12 * 1024**3:
        raise ValueError("At least 12 GiB free Docker storage is required before starting")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["validate", "identity", "migrate", "start", "maintenance", "restore-sanitize"])
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    directory = args.directory.resolve()
    application = args.action not in ("validate", "identity")
    try:
        bootstrap.check(directory, application, require_rehearsal=args.action == "start")
        bootstrap.render(directory)
        compose = ["docker", "compose", "--env-file", str(directory / "stack.env"), "-f", str(Path(__file__).with_name("compose.yaml"))]
        subprocess.run(compose + ["config", "--quiet"], check=True)
        if args.action == "validate":
            print("Configuration syntax checked; no service was started.")
            return 0
        if args.action in ("identity", "start"):
            state = subprocess.run(compose + ["ps", "--format", "json"], check=True, capture_output=True, text=True).stdout.strip()
            rows = json.loads(state) if state.startswith("[") else [json.loads(line) for line in state.splitlines() if line]
            running = {row.get("Service") for row in rows if row.get("State") == "running"}
            check_resources(environment(directory), application, running)
        # Operations have their own container caps and may run while the stack
        # already occupies its budget; they must not demand that budget twice.
        if args.action == "identity":
            subprocess.run(compose + ["up", "--no-build", "-d", "keycloak"], check=True)
        else:
            # Refresh protected files, including rotated credentials, before using
            # the profiles. Existing database credentials still need SQL rotation.
            subprocess.run(compose + ["run", "--rm", "prepare-secrets"], check=True)
            if args.action == "migrate":
                subprocess.run(compose + ["run", "--rm", "migrate"], check=True)
                subprocess.run(compose + ["run", "--rm", "grant-runtime"], check=True)
            elif args.action == "start":
                subprocess.run(compose + ["up", "-d", "api"], check=True)
            else:
                subprocess.run(compose + ["run", "--rm", "api", args.action], check=True)
    except ValueError as error:
        print(str(error), file=sys.stderr)  # Only locally authored prerequisite messages.
        return 1
    except (OSError, subprocess.CalledProcessError, KeyError):
        print("Deployment action failed; inspect redacted service diagnostics.", file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
