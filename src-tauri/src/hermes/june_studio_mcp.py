#!/usr/bin/env python3
"""MCP server exposing Sub Rosa's local film production (`june_studio`).

Six tools, each with an `action` discriminator, rather than thirty granular
ones. The whole surface is always in the model's context, so its size is a
running cost on every turn of every conversation - a granular surface for this
much capability runs to thousands of tokens before anybody asks for a film.
Action-discriminated, it is a few hundred. What each action expects in detail
lives in the `subrosa-production` skill, which costs nothing until it is read.

Everything goes through the app's local provider proxy (loopback only), which
forwards a named action to a command the app already exposes to its own
webview. This server sees no API key, no file path and no gallery file.

The proxy's coordinates (base URL + token) are NOT baked in at spawn time:
argv[1] is the path to a JSON file the app rewrites on every runtime spawn,
and this server re-reads it on every tool call (same contract as `june_web`
and `june_media`).

Standard library only, so it runs inside the Hermes runtime venv untouched.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "june-studio", "version": "0.1.0"}
TOKEN_ENV_VAR = "JUNE_MEDIA_PROXY_TOKEN"
REQUEST_TIMEOUT_SECONDS = 180

TOOLS: list[dict[str, Any]] = [
    {
        "name": "bible",
        "description": (
            "The persistent identities of a production: characters, locations, props, "
            "the look. Actions: list, save (name + kind + traits, id to update), "
            "delete (id), attach (entryId + artifactId + role), detach (id). "
            "Roles: portrait, profile, wide, medium, detail, voice. Their order "
            "matters - the first image is the identity the model holds."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["list", "save", "delete", "attach", "detach"],
                },
                "id": {"type": "string"},
                "kind": {
                    "type": "string",
                    "enum": ["character", "location", "prop", "look"],
                },
                "name": {"type": "string"},
                "traits": {
                    "type": "string",
                    "description": "What must not drift between shots. Restated on every shot.",
                },
                "note": {"type": "string"},
                "entryId": {"type": "string"},
                "artifactId": {"type": "string"},
                "role": {"type": "string"},
                "label": {"type": "string"},
            },
            "required": ["action"],
        },
    },
    {
        "name": "shots",
        "description": (
            "Read a note as the shots a film is made of. Actions: plan (what it "
            "would cost to read, and whether it can be), build (start reading - it "
            "runs in the background and survives the app closing), read (the current "
            "state and the shots), forget (stop and discard). Always plan before you "
            "build, and tell the user what it will take."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["plan", "build", "read", "forget"]},
                "noteId": {"type": "string"},
            },
            "required": ["action", "noteId"],
        },
    },
]


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: june_studio_mcp.py <coordinates_json_path>")

    target = sys.argv[1]
    while True:
        message = read_message()
        if message is None:
            return
        response_message = handle_message(target, message)
        if response_message is not None:
            write_message(response_message)


def handle_message(target: str, message: dict[str, Any]) -> dict[str, Any] | None:
    method = message.get("method")
    request_id = message.get("id")

    if method == "initialize":
        return response(
            request_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            },
        )
    if method == "notifications/initialized":
        return None
    if method == "ping":
        return response(request_id, {})
    if method == "tools/list":
        return response(request_id, {"tools": TOOLS})
    if method == "tools/call":
        return call_tool(target, request_id, message.get("params") or {})

    if request_id is None:
        return None
    return error_response(request_id, -32601, f"Unknown method: {method}")


# Tool name plus its action, mapped to the app-side action the proxy dispatches.
ACTIONS: dict[tuple[str, str], str] = {
    ("bible", "list"): "bible.list",
    ("bible", "save"): "bible.save",
    ("bible", "delete"): "bible.delete",
    ("bible", "attach"): "bible.attach",
    ("bible", "detach"): "bible.detach",
    ("shots", "plan"): "shots.plan",
    ("shots", "build"): "shots.build",
    ("shots", "read"): "shots.read",
    ("shots", "forget"): "shots.forget",
}


def call_tool(target: str, request_id: Any, params: dict[str, Any]) -> dict[str, Any]:
    name = str(params.get("name") or "")
    arguments = dict(params.get("arguments") or {})
    action = str(arguments.pop("action", "") or "")
    try:
        dispatched = ACTIONS.get((name, action))
        if dispatched is None:
            return error_response(
                request_id, -32602, f"Unknown action: {name}.{action or '(none)'}"
            )
        # Resolved inside the try so a missing or corrupt coordinates file
        # surfaces as a tool error the agent can report, not a dead server.
        base_url, token = resolve_coordinates(target)
        result = studio_request(base_url, token, dispatched, arguments)
    except Exception as exc:
        return response(
            request_id,
            {
                "isError": True,
                "content": [
                    {"type": "text", "text": json.dumps({"error": str(exc)}, indent=2)}
                ],
            },
        )
    return response(
        request_id,
        {
            "content": [
                {"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}
            ],
            "structuredContent": result if isinstance(result, dict) else {"result": result},
        },
    )


def studio_request(
    base_url: str, token: str, action: str, params: dict[str, Any]
) -> Any:
    """One typed action through the app's proxy. Secrets stay in the app."""
    body = json.dumps({"action": action, "params": params}).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/v1/studio/request",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as handle:
            return json.loads(handle.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(detail)
            message = parsed.get("error", {}).get("message") or detail
        except json.JSONDecodeError:
            message = detail
        raise RuntimeError(message or f"The app returned status {exc.code}.")

def resolve_coordinates(target: str) -> tuple[str, str]:
    """Resolve the proxy base URL and token for THIS call (re-read per call so
    a gateway-hosted server keeps working across app restarts)."""
    if target.startswith("http://") or target.startswith("https://"):
        return target.rstrip("/"), os.environ.get(TOKEN_ENV_VAR, "")

    try:
        with open(target, encoding="utf-8") as handle:
            coordinates = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "Could not read the June media proxy coordinates "
            f"({target}): {exc}. The June app rewrites this file at "
            "startup; is the app running?"
        )

    base_url = str(coordinates.get("base_url") or "").rstrip("/")
    token = str(coordinates.get("token") or "")
    if not base_url:
        raise RuntimeError(
            f"The June media proxy coordinates file ({target}) has no base_url."
        )
    return base_url, token

def read_message() -> dict[str, Any] | None:
    while True:
        first = sys.stdin.buffer.readline()
        if first == b"":
            return None
        if first.strip():
            break
    if not first.lower().startswith(b"content-length:"):
        stripped = first.strip()
        return json.loads(stripped.decode("utf-8"))

    headers: dict[str, str] = {}
    name, _, value = first.decode("ascii", "replace").partition(":")
    headers[name.lower()] = value.strip()
    while True:
        line = sys.stdin.buffer.readline()
        if line == b"":
            return None
        if line in (b"\r\n", b"\n"):
            break
        name, _, value = line.decode("ascii", "replace").partition(":")
        headers[name.lower()] = value.strip()

    length = int(headers.get("content-length", "0"))
    if length <= 0:
        return None
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode("utf-8"))

def write_message(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()

def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}

def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


if __name__ == "__main__":
    main()


if __name__ == "__main__":
    main()
