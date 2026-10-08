#!/usr/bin/env python3
"""MCP server exposing the person's Sub Rosa connectors to the agent runtime.

The Sub Rosa app writes this script into its data directory and registers it
as the built-in `subrosa_connectors` server (ADR-0092, addendum of
2026-10-08). It holds no connector, no token and no rule: `tools/list` asks
the app's loopback proxy for the connectors' tools, and `tools/call` hands the
call back to it, where the app reads the person's rule for the tool and runs
it through the same connector runtime the phones use. A tool that asks first
has already been through the runtime's approval by then (the guard plugin
asks for it); the app checks that again.

The proxy's coordinates (base URL and token) are read from the JSON file
named by argv[1] on every request, because the proxy binds a new port each
time the app starts while this server may outlive it.

The list changes when a connector is added, removed, turned off or ruled on.
A background thread asks for it every POLL_SECONDS and sends
`notifications/tools/list_changed` when it moved, so the runtime lists again.

Standard library only, so it runs inside the runtime's own interpreter.
"""

from __future__ import annotations

import json
import sys
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Optional

PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "subrosa-connectors", "version": "0.1.0"}
LIST_TIMEOUT_SECONDS = 20
CALL_TIMEOUT_SECONDS = 110
POLL_SECONDS = 20

_write_lock = threading.Lock()
_state = {"fingerprint": None, "initialized": False}


def resolve_coordinates(path: str) -> tuple[str, str]:
    with open(path, encoding="utf-8") as handle:
        coordinates = json.load(handle)
    base_url = str(coordinates.get("base_url") or "").rstrip("/")
    token = str(coordinates.get("token") or "")
    if not base_url:
        raise RuntimeError("The Sub Rosa proxy coordinates have no address.")
    return base_url, token


def ask_app(path: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    base_url, token = resolve_coordinates(path)
    request = urllib.request.Request(
        f"{base_url}/connectors",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
    )
    request.add_header("Content-Type", "application/json")
    request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
    value = json.loads(body) if body else {}
    if not isinstance(value, dict):
        raise RuntimeError("Sub Rosa returned an unreadable answer.")
    return value


def list_tools(path: str) -> tuple[list[dict[str, Any]], Optional[str]]:
    try:
        listing = ask_app(path, {"op": "list"}, LIST_TIMEOUT_SECONDS)
    except Exception:
        # The app is closed or starting: no connector is reachable now.
        return [], None
    tools = listing.get("tools")
    fingerprint = listing.get("fingerprint")
    return (
        [tool for tool in tools if isinstance(tool, dict)] if isinstance(tools, list) else [],
        fingerprint if isinstance(fingerprint, str) else None,
    )


def call_tool(path: str, params: dict[str, Any]) -> dict[str, Any]:
    name = params.get("name")
    arguments = params.get("arguments")
    if not isinstance(arguments, dict):
        arguments = {}
    try:
        result = ask_app(
            path,
            {"op": "call", "name": name, "arguments": arguments},
            CALL_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        return {
            "isError": True,
            "content": [
                {
                    "type": "text",
                    "text": f"Sub Rosa could not be reached to run this connector tool: {exc}",
                }
            ],
        }
    if "content" not in result:
        message = (result.get("error") or {}).get("message") if isinstance(result.get("error"), dict) else None
        return {
            "isError": True,
            "content": [{"type": "text", "text": message or "The connector tool failed."}],
        }
    return result


def write_message(payload: dict[str, Any]) -> None:
    with _write_lock:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        sys.stdout.write("\n")
        sys.stdout.flush()


def read_message() -> Optional[dict[str, Any]]:
    while True:
        line = sys.stdin.buffer.readline()
        if line == b"":
            return None
        if line.strip():
            break
    if line.lower().startswith(b"content-length:"):
        length = int(line.split(b":", 1)[1].strip() or b"0")
        while True:
            header = sys.stdin.buffer.readline()
            if header in (b"", b"\r\n", b"\n"):
                break
        if length <= 0:
            return None
        return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))
    return json.loads(line.strip().decode("utf-8"))


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def handle_message(path: str, message: dict[str, Any]) -> Optional[dict[str, Any]]:
    method = message.get("method")
    request_id = message.get("id")
    if method == "initialize":
        return response(
            request_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": True}},
                "serverInfo": SERVER_INFO,
            },
        )
    if method == "notifications/initialized":
        _state["initialized"] = True
        return None
    if method == "ping":
        return response(request_id, {})
    if method == "tools/list":
        tools, fingerprint = list_tools(path)
        _state["fingerprint"] = fingerprint
        return response(request_id, {"tools": tools})
    if method == "tools/call":
        params = message.get("params")
        return response(request_id, call_tool(path, params if isinstance(params, dict) else {}))
    if request_id is None:
        return None
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": -32601, "message": f"Unknown method: {method}"},
    }


def watch(path: str) -> None:
    """Tells the runtime to list again when the app's list moved."""
    while True:
        time.sleep(POLL_SECONDS)
        if not _state["initialized"]:
            continue
        _, fingerprint = list_tools(path)
        if fingerprint is None or fingerprint == _state["fingerprint"]:
            continue
        _state["fingerprint"] = fingerprint
        write_message({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: subrosa_connectors_mcp.py <coordinates_json_path>")
    path = sys.argv[1]
    threading.Thread(target=watch, args=(path,), daemon=True).start()
    while True:
        message = read_message()
        if message is None:
            return
        reply = handle_message(path, message)
        if reply is not None:
            write_message(reply)


if __name__ == "__main__":
    main()
