"""Sub Rosa: one settings change, made outside the sandbox (ADR-0140).

The sandboxed runtime cannot write its own settings any more: config.yaml,
.env, skills/, cron/ and the rest of its home are read-only to the jail,
because processes outside the jail read them. So the app makes each change
itself, here: this script loads the pinned runtime's own dashboard
application in process, sends it the one request the Settings screen asked
for, and exits. The route that runs is the runtime's own (validation,
atomic writes, installers), so a change made here is the change the
dashboard would have made, only written from outside the jail.

Input (stdin, JSON): {"method": "PUT", "path": "/api/skills/toggle", "body": {...}},
or {"op": "sync_skills"} to copy the runtime's bundled skills into the home.
Environment: HERMES_HOME and HERMES_DASHBOARD_SESSION_TOKEN, set by the app.
Output (the file after --out, JSON): the route's status and body, and the
runtime's config.yaml as it stands after the change (the app keeps the
settings a person owns from it, so they survive the next start). The
runtime's own chatter goes to stdout and stderr, which the app logs.
"""

import argparse
import json
import os
import sys


def _config_after(home):
    path = os.path.join(home, "config.yaml")
    try:
        import yaml

        with open(path, encoding="utf-8") as handle:
            loaded = yaml.safe_load(handle)
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return None


def _env_schema(home):
    """The keys Settings can write into .env, from the pinned runtime: the
    credentials it declares, the messaging platforms' settings, the tool
    providers' keys, the keys installed skills ask for, and the MCP servers'
    bearer tokens. The app keeps nothing else (ADR-0140)."""
    keys = set()
    try:
        from hermes_cli.config import OPTIONAL_ENV_VARS

        for key, meta in OPTIONAL_ENV_VARS.items():
            if isinstance(meta, dict) and meta.get("password"):
                keys.add(key)
    except Exception:
        pass
    try:
        from hermes_cli import web_server

        for entry in web_server._messaging_platform_catalog():
            keys.update(str(key) for key in entry.get("env_vars") or ())
    except Exception:
        pass
    try:
        from hermes_cli.tools_config import TOOL_CATEGORIES

        for category in TOOL_CATEGORIES.values():
            for provider in category.get("providers") or ():
                for var in provider.get("env_vars") or ():
                    keys.add(str(var.get("key") if isinstance(var, dict) else var))
    except Exception:
        pass
    try:
        import glob

        from hermes_cli.config import load_config
        from hermes_cli.mcp_config import _env_key_for_server
        from tools.skills_tool import _get_required_environment_variables, _parse_frontmatter

        config = load_config()
        for name in (config.get("mcp_servers") or {}):
            keys.add(_env_key_for_server(str(name)))
        dirs = [os.path.join(home, "skills")]
        dirs += [str(d) for d in ((config.get("skills") or {}).get("external_dirs") or [])]
        for root in dirs:
            for path in glob.glob(os.path.join(root, "**", "SKILL.md"), recursive=True):
                try:
                    with open(path, encoding="utf-8") as handle:
                        frontmatter, _ = _parse_frontmatter(handle.read())
                    for entry in _get_required_environment_variables(frontmatter):
                        keys.add(str(entry.get("name")))
                except Exception:
                    continue
    except Exception:
        pass
    return sorted(key for key in keys if key and key.replace("_", "").isalnum())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    request = json.loads(sys.stdin.read() or "{}")
    home = os.environ["HERMES_HOME"]
    if request.get("op") == "sync_skills":
        # The runtime copies its bundled skills into the home when it starts;
        # the sandboxed one no longer can, so the app does it first.
        from tools.skills_sync import sync_skills

        synced = sync_skills(quiet=True)
        counts = {k: len(v) if isinstance(v, list) else v for k, v in synced.items()}
        _write(
            args.out,
            {"status": 200, "body": counts, "config": None, "env_schema": _env_schema(home)},
        )
        return
    method = str(request.get("method") or "GET").upper()
    path = str(request.get("path") or "/")
    body = request.get("body")
    token = os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN", "")

    from fastapi.testclient import TestClient
    from hermes_cli import web_server

    client = TestClient(
        web_server.app, base_url="http://127.0.0.1", raise_server_exceptions=False
    )
    headers = {"X-Hermes-Session-Token": token, "Content-Type": "application/json"}
    if body is None:
        response = client.request(method, path, headers=headers)
    else:
        response = client.request(method, path, headers=headers, json=body)
    try:
        payload = response.json()
    except ValueError:
        payload = response.text
    result = {
        "status": response.status_code,
        "body": payload,
        "config": _config_after(home),
        "env_schema": _env_schema(home),
    }
    _write(args.out, result)


def _write(out, result):
    temp = out + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(result, handle, default=str)
    os.replace(temp, out)


if __name__ == "__main__":
    main()
