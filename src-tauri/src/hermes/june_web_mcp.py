#!/usr/bin/env python3
"""MCP server exposing June web search and fetch tools.

The June app writes this script into the managed Hermes home and registers it
as the built-in `june_web` MCP server. The tools call the June app's local
provider proxy (loopback only), which adds the user's access token and forwards
to the June API's `/v1/web/search` and `/v1/web/fetch` endpoints. Those run on
Venice's privacy-preserving augment endpoints, so the agent never talks to a
third party directly and the access token never leaves the Rust process.

The proxy's coordinates (base URL + token) are NOT baked in at spawn time:
argv[1] is the path to a JSON file the app rewrites on every runtime spawn,
and this server re-reads it on every tool call. The proxy binds an ephemeral
port per app launch while this MCP server can be hosted by the long-lived
Hermes gateway (launchd) that survives app restarts — spawn-time coordinates
would go stale after the first app relaunch and every web tool call would hit
a dead port (this is exactly what broke cron routines). A legacy spawn from a
pre-coordinates-file config passes the base URL itself as argv[1] with the
token in the environment; that mode is kept so old config + new script still
works until the gateway respawns its MCP servers.

It depends only on the Python standard library so it can run inside the Hermes
runtime venv without extra packaging.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from typing import Any


PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-web", "version": "0.1.0"}
MAX_LIMIT = 20
DEFAULT_LIMIT = 8
REQUEST_TIMEOUT_SECONDS = 25
TOKEN_ENV_VAR = "JUNE_WEB_PROXY_TOKEN"


TOOLS: list[dict[str, Any]] = [
    {
        "name": "web_search",
        "description": (
            "Search the web for current information. Use this when the user "
            "asks about recent events, facts you are unsure of, or anything "
            "that may have changed since your training. Returns titles, URLs, "
            "and snippets; follow up with web_fetch to read a result in full."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What to search for.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_LIMIT,
                    "default": DEFAULT_LIMIT,
                    "description": "How many results to return.",
                },
                "provider": {
                    "type": "string",
                    "enum": ["brave", "google"],
                    "description": "Search engine to use. Defaults to brave.",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "places_search",
        "description": (
            "Search for real-world places (businesses, offices, restaurants, "
            "landmarks) by name or kind, optionally near a point. Returns "
            "names, coordinates, addresses and categories as JSON. When you "
            "answer with these results, embed them for the user as a "
            "subrosa:places chat block, copying the JSON fields verbatim."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "What to look for, including the area when known "
                        "(e.g. 'expert comptable Annemasse')."
                    ),
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 8,
                    "default": 6,
                    "description": "How many places to return.",
                },
                "near": {
                    "type": "object",
                    "properties": {
                        "lat": {"type": "number"},
                        "lng": {"type": "number"},
                    },
                    "required": ["lat", "lng"],
                    "description": "Bias results toward this point.",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "web_fetch",
        "description": (
            "Fetch a single web page and return its content as markdown. Use "
            "this to read a specific URL, including ones surfaced by web_search. "
            "Some sites that block automated access cannot be fetched."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The http(s) URL to read.",
                },
            },
            "required": ["url"],
        },
    },
]


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: june_web_mcp.py <coordinates_json_path | proxy_base_url>")

    target = sys.argv[1]
    while True:
        message = read_message()
        if message is None:
            return
        response_message = handle_message(target, message)
        if response_message is not None:
            write_message(response_message)


def resolve_coordinates(target: str) -> tuple[str, str]:
    """Resolve the proxy base URL and token for THIS call.

    `target` is normally the coordinates JSON file the app rewrites on every
    runtime spawn; reading it per call is what keeps a gateway-hosted server
    working across app restarts. A literal http(s) URL is the legacy spawn
    shape (token in the environment).
    """
    if target.startswith("http://") or target.startswith("https://"):
        return target.rstrip("/"), os.environ.get(TOKEN_ENV_VAR, "")

    try:
        with open(target, encoding="utf-8") as handle:
            coordinates = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "Could not read the June web proxy coordinates "
            f"({target}): {exc}. The June app rewrites this file at "
            "startup; is the app running?"
        )

    base_url = str(coordinates.get("base_url") or "").rstrip("/")
    token = str(coordinates.get("token") or "")
    if not base_url:
        raise RuntimeError(
            f"The June web proxy coordinates file ({target}) has no base_url."
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


def call_tool(target: str, request_id: Any, params: dict[str, Any]) -> dict[str, Any]:
    name = params.get("name")
    arguments = params.get("arguments") or {}
    try:
        # Resolved inside the try so a missing/corrupt coordinates file
        # surfaces as a tool error the agent can report, not a dead server.
        base_url, token = resolve_coordinates(target)
        if name == "web_search":
            result = web_search(base_url, token, arguments)
        elif name == "places_search":
            result = places_search(base_url, token, arguments)
        elif name == "web_fetch":
            result = web_fetch(base_url, token, arguments)
        else:
            return error_response(request_id, -32602, f"Unknown tool: {name}")
    except Exception as exc:
        return response(
            request_id,
            {
                "isError": True,
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(
                            {"error": str(exc)}, ensure_ascii=False, indent=2
                        ),
                    }
                ],
            },
        )

    return response(
        request_id,
        {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(result, ensure_ascii=False, indent=2),
                }
            ],
            "structuredContent": result,
        },
    )


def web_search(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    query = str(arguments.get("query") or "").strip()
    if not query:
        raise ValueError("query is required")
    payload: dict[str, Any] = {"query": query, "requestId": new_request_id()}
    limit = arguments.get("limit")
    if isinstance(limit, int):
        payload["limit"] = max(1, min(MAX_LIMIT, limit))
    provider = arguments.get("provider")
    if provider in ("brave", "google"):
        payload["provider"] = provider
    return call_proxy(base_url, token, "/web/search", payload)


def places_search(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    query = str(arguments.get("query") or "").strip()
    if not query:
        raise ValueError("query is required")
    payload: dict[str, Any] = {"query": query}
    limit = arguments.get("limit")
    if isinstance(limit, int):
        payload["limit"] = max(1, min(8, limit))
    near = arguments.get("near")
    if (
        isinstance(near, dict)
        and isinstance(near.get("lat"), (int, float))
        and isinstance(near.get("lng"), (int, float))
    ):
        payload["near"] = {"lat": near["lat"], "lng": near["lng"]}
    return call_proxy(base_url, token, "/web/places", payload)


def web_fetch(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    url = str(arguments.get("url") or "").strip()
    if not url:
        raise ValueError("url is required")
    payload = {"url": url, "requestId": new_request_id()}
    return call_proxy(base_url, token, "/web/fetch", payload)


def call_proxy(
    base_url: str, token: str, path: str, payload: dict[str, Any]
) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(f"{base_url}{path}", data=data, method="POST")
    request.add_header("Content-Type", "application/json")
    request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        # The envelope still carries {success, message} on 4xx/5xx, so read it
        # for a usable error rather than a bare status code.
        body = exc.read().decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach the June web proxy: {exc.reason}")

    try:
        envelope = json.loads(body) if body else {}
    except json.JSONDecodeError:
        raise RuntimeError("The June web proxy returned an unreadable response.")

    if envelope.get("success"):
        data_value = envelope.get("data")
        return data_value if isinstance(data_value, dict) else {}
    raise RuntimeError(str(envelope.get("message") or "Web request failed."))


def new_request_id() -> str:
    return uuid.uuid4().hex


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


if __name__ == "__main__":
    main()
