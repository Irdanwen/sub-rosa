#!/usr/bin/env python3
"""MCP server exposing Sub Rosa's agent browser (`june_browser`, ADR-0094).

The agent drives a Chromium-family browser the person already has, in a
profile of its own. This server does none of it: every tool is relayed to the
app's local provider proxy (loopback only, `/v1/browser/request`), and the app
starts the browser, holds its DevTools socket, asks the person before each new
site, refuses password, payment and one-time-code fields and CAPTCHAs, and
journals every action. The runtime never learns the browser's port.

The proxy's coordinates (base URL + token) are NOT baked in at spawn time:
argv[1] is the path to a JSON file the app rewrites on every runtime spawn,
and this server re-reads it on every tool call (same contract as `june_web`,
`june_media` and `june_studio`).

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
SERVER_INFO = {"name": "june-browser", "version": "0.1.0"}
TOKEN_ENV_VAR = "JUNE_MEDIA_PROXY_TOKEN"
# A consent card can wait minutes for the person, on top of the page.
REQUEST_TIMEOUT_SECONDS = 280

REF = {"type": "string", "description": "An element ref from the last snapshot, like e12."}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "browser_open_url",
        "description": (
            "Open a web page in the agent browser, a real browser window the person "
            "can watch. Use it when a task needs a site to be used (forms, bookings, "
            "pages behind a sign-in the person did inside that window), not to read a "
            "page: web_fetch is faster for that. The first visit to a new site asks "
            "the person for permission and may take a while."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"url": {"type": "string", "description": "An http(s) URL."}},
            "required": ["url"],
        },
    },
    {
        "name": "browser_snapshot",
        "description": (
            "Read the current page as its accessibility tree: headings, text and every "
            "control numbered with a ref (e1, e2...) for click, type and select. Take "
            "a new one after anything that changes the page. screenshot=true adds a "
            "picture of the visible part."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"screenshot": {"type": "boolean"}},
        },
    },
    {
        "name": "browser_click",
        "description": "Click the element with this ref.",
        "inputSchema": {"type": "object", "properties": {"ref": REF}, "required": ["ref"]},
    },
    {
        "name": "browser_type",
        "description": (
            "Replace the text in a field. submit=true presses Enter afterwards. "
            "Password, payment and one-time-code fields are refused: the person types "
            "those themselves."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"ref": REF, "text": {"type": "string"}, "submit": {"type": "boolean"}},
            "required": ["ref", "text"],
        },
    },
    {
        "name": "browser_select",
        "description": "Choose an option in a drop-down list, by its label or value.",
        "inputSchema": {
            "type": "object",
            "properties": {"ref": REF, "value": {"type": "string"}},
            "required": ["ref", "value"],
        },
    },
    {
        "name": "browser_scroll",
        "description": "Scroll the page by most of a screen.",
        "inputSchema": {
            "type": "object",
            "properties": {"direction": {"type": "string", "enum": ["down", "up"]}},
        },
    },
    {
        "name": "browser_back",
        "description": "Go back to the previous page.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "browser_wait_for",
        "description": (
            "Wait until some text shows on the page, or for a number of seconds "
            "(30 at most). Use it after asking the person to do something in the "
            "window, such as signing in or completing a CAPTCHA."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "seconds": {"type": "integer", "minimum": 1, "maximum": 30},
            },
        },
    },
    {
        "name": "browser_extract_text",
        "description": "The page's visible text, for reading it in full.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "browser_screenshot",
        "description": "A picture of the visible part of the page.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "browser_close",
        "description": "Close the agent browser when the task is done.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]

# Tool name to the app-side action.
ACTIONS: dict[str, str] = {
    "browser_open_url": "open_url",
    "browser_snapshot": "snapshot",
    "browser_click": "click",
    "browser_type": "type",
    "browser_select": "select",
    "browser_scroll": "scroll",
    "browser_back": "back",
    "browser_wait_for": "wait_for",
    "browser_extract_text": "extract_text",
    "browser_screenshot": "screenshot",
    "browser_close": "close",
}


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: june_browser_mcp.py <coordinates_json_path>")
    target = sys.argv[1]
    while True:
        message = read_message()
        if message is None:
            return
        reply = handle_message(target, message)
        if reply is not None:
            write_message(reply)


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
    name = str(params.get("name") or "")
    arguments = dict(params.get("arguments") or {})
    action = ACTIONS.get(name)
    if action is None:
        return error_response(request_id, -32602, f"Unknown tool: {name}")
    try:
        base_url, token = resolve_coordinates(target)
        result = browser_request(base_url, token, action, arguments)
    except Exception as exc:
        return response(
            request_id,
            {"isError": True, "content": [{"type": "text", "text": str(exc)}]},
        )
    return response(request_id, {"content": content_for(result)})


def content_for(result: Any) -> list[dict[str, Any]]:
    """Text for the model, and the picture as an image block rather than as
    base64 inside the text."""
    content: list[dict[str, Any]] = []
    if isinstance(result, dict) and isinstance(result.get("screenshot"), dict):
        shot = result.pop("screenshot")
        content.append(
            {
                "type": "image",
                "data": str(shot.get("base64") or ""),
                "mimeType": str(shot.get("mimeType") or "image/jpeg"),
            }
        )
    if isinstance(result, dict) and isinstance(result.get("snapshot"), str):
        snapshot = result.pop("snapshot")
        header = json.dumps(result, ensure_ascii=False)
        content.insert(0, {"type": "text", "text": f"{header}\n\n{snapshot}"})
    else:
        content.insert(
            0, {"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}
        )
    return content


def browser_request(base_url: str, token: str, action: str, params: dict[str, Any]) -> Any:
    body = json.dumps({"action": action, "params": params}).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/browser/request",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as handle:
            return json.loads(handle.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        try:
            message = json.loads(detail).get("error", {}).get("message") or detail
        except json.JSONDecodeError:
            message = detail
        raise RuntimeError(message or f"The app returned status {exc.code}.")


def resolve_coordinates(target: str) -> tuple[str, str]:
    if target.startswith("http://") or target.startswith("https://"):
        return target.rstrip("/"), os.environ.get(TOKEN_ENV_VAR, "")
    try:
        with open(target, encoding="utf-8") as handle:
            coordinates = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"Could not read the app's proxy coordinates ({target}): {exc}. "
            "The app rewrites this file at startup; is it running?"
        )
    base_url = str(coordinates.get("base_url") or "").rstrip("/")
    token = str(coordinates.get("token") or "")
    if not base_url:
        raise RuntimeError(f"The proxy coordinates file ({target}) has no base_url.")
    return base_url, token


def read_message() -> dict[str, Any] | None:
    while True:
        first = sys.stdin.buffer.readline()
        if first == b"":
            return None
        if first.strip():
            break
    if not first.lower().startswith(b"content-length:"):
        return json.loads(first.strip().decode("utf-8"))
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
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


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
