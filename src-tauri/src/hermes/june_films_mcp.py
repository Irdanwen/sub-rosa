#!/usr/bin/env python3
"""MCP server exposing June film-production tools (Videomaker Studio).

The June app writes this script into the managed Hermes home and registers it
as the built-in `june_films` MCP server. Every tool calls the June app's local
provider proxy (loopback only), which forwards typed actions to the app's
Videomaker module: the Studio wallet, the `vmk_` token, and the user's Carpe
Diem key all stay inside the Rust process. Production spend is billed in DIEM
to the user's Carpe Diem key, so cost-moving tools are explicit about caps:
`start_film_run` requires `max_cost_diem`, and `start_film_production` refuses
to confirm a quote above its `max_cost_diem`.

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


PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-films", "version": "0.1.0"}
TOKEN_ENV_VAR = "JUNE_WEB_PROXY_TOKEN"

REQUEST_TIMEOUT_SECONDS = 60
# A chat turn with the studio crew legitimately runs for minutes when it
# generates assets; the export downloads a whole film.
CHAT_TIMEOUT_SECONDS = 900
EXPORT_TIMEOUT_SECONDS = 600

GATE_PHASES = (
    "concept",
    "bible",
    "asset_pack",
    "shotlist",
    "storyboard",
    "production",
    "final",
)

TOOLS: list[dict[str, Any]] = [
    {
        "name": "film_studio_status",
        "description": (
            "Whether film production is activated, plus the studio account "
            "(wallet address, registered key, DIEM balance and quota). Call "
            "this first; if not activated, ask the user to activate it in "
            "Settings > Film studio - you cannot activate it yourself."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_film_projects",
        "description": (
            "List the user's film projects: slug, title, state, whether the "
            "final film is rendered, and expiry (idle projects are purged "
            "after 7 days)."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "create_film_project",
        "description": (
            "Create a film project. autonomous=true (recommended for "
            "hands-off asks) requires a positive budget_ceiling_diem - a hard "
            "spend cap enforced by the studio at every step. Confirm the "
            "budget with the user before creating an autonomous project. "
            "Non-autonomous projects pause at each phase gate for review."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "The film's title."},
                "aspect_ratio": {
                    "type": "string",
                    "description": '"16:9", "9:16", "1:1", "4:3", "3:4", or "21:9".',
                },
                "target_duration_seconds": {
                    "type": "integer",
                    "description": "Target film length in seconds (e.g. 60).",
                },
                "autonomous": {
                    "type": "boolean",
                    "description": "Skip human phase gates (needs budget_ceiling_diem).",
                },
                "budget_ceiling_diem": {
                    "type": "number",
                    "description": "Hard spend cap in DIEM for the whole project.",
                },
            },
            "required": ["title"],
        },
    },
    {
        "name": "start_film_run",
        "description": (
            "Hand a brief to the studio and let it drive every phase (concept "
            "to storyboard, then production) from the project's current "
            "state. This is the recommended way to produce a film end to end. "
            "max_cost_diem caps the production launch: the run stops at the "
            "quote if it exceeds the cap. Re-POSTing after a pause resumes. "
            "Production continues server-side; the app downloads the finished "
            "film automatically."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "slug": {"type": "string", "description": "Project slug."},
                "brief": {
                    "type": "string",
                    "description": (
                        "The full brief: story, tone, characters, locations, "
                        "style references. Give intent, not raw video prompts."
                    ),
                },
                "max_cost_diem": {
                    "type": "number",
                    "description": (
                        "Cap for the automatic production launch in DIEM. "
                        "Required - agree it with the user first."
                    ),
                },
            },
            "required": ["slug", "brief", "max_cost_diem"],
        },
    },
    {
        "name": "film_status",
        "description": (
            "Live production status of a film project: daemon state, task "
            "queue, DIEM spend vs ceiling, shots to review, and whether the "
            "user's Carpe Diem balance ran out."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"slug": {"type": "string"}},
            "required": ["slug"],
        },
    },
    {
        "name": "film_gates",
        "description": (
            "The phase-gate rollup of a gated (non-autonomous) project: one "
            "row per phase with its latest decision and whether it is open."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"slug": {"type": "string"}},
            "required": ["slug"],
        },
    },
    {
        "name": "decide_film_gate",
        "description": (
            "Approve or reject a phase gate on the user's behalf. Only do "
            "this when the user explicitly told you their decision; rejecting "
            "should carry their reason - the studio crew reads it."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "slug": {"type": "string"},
                "phase": {"type": "string", "enum": list(GATE_PHASES)},
                "decision": {"type": "string", "enum": ["approve", "reject"]},
                "reason": {"type": "string", "description": "The user's reasoning."},
            },
            "required": ["slug", "phase", "decision"],
        },
    },
    {
        "name": "chat_with_film_studio",
        "description": (
            "Send one message to the project's studio crew (the creative "
            "agent that writes the bible, builds assets, drafts the shotlist "
            "and storyboard). Turns that generate assets can take minutes. "
            "Prefer start_film_run for end-to-end production; use chat for "
            "targeted revisions."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "slug": {"type": "string"},
                "message": {"type": "string"},
            },
            "required": ["slug", "message"],
        },
    },
    {
        "name": "start_film_production",
        "description": (
            "Launch shot rendering through the studio's cost handshake: "
            "fetches the live quote and confirms it only if it is at or "
            "under max_cost_diem, otherwise returns the quote for the user "
            "to decide. Get the user's budget before calling."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "slug": {"type": "string"},
                "max_cost_diem": {
                    "type": "number",
                    "description": "Do not confirm a quote above this many DIEM.",
                },
            },
            "required": ["slug", "max_cost_diem"],
        },
    },
    {
        "name": "film_board",
        "description": (
            "The shot board of a project: scenes with per-shot status, "
            "prompts, takes count, failures, and overall totals (done/total, "
            "spend, ETA)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"slug": {"type": "string"}},
            "required": ["slug"],
        },
    },
    {
        "name": "film_shot_action",
        "description": (
            "Act on one shot: select a rendered take (free), retake with an "
            "optionally adjusted prompt (costs DIEM), requeue a failed shot "
            "(costs DIEM), or skip it (free, placeholders the shot). Confirm "
            "cost-bearing actions with the user first."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "slug": {"type": "string"},
                "shot_id": {"type": "string"},
                "action": {
                    "type": "string",
                    "enum": ["takes", "select", "retake", "requeue", "skip"],
                    "description": '"takes" lists the rendered takes.',
                },
                "version": {
                    "type": "integer",
                    "description": "Take version (required for select).",
                },
                "prompt": {
                    "type": "string",
                    "description": "Adjusted prompt (optional, retake only).",
                },
            },
            "required": ["slug", "shot_id", "action"],
        },
    },
    {
        "name": "export_film",
        "description": (
            "Download the finished film into the user's Studio gallery and "
            "return its absolute path. Fails with a final-review message on "
            "gated projects until the final gate is approved."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"slug": {"type": "string"}},
            "required": ["slug"],
        },
    },
]


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: june_films_mcp.py <coordinates_json_path>")

    target = sys.argv[1]
    while True:
        message = read_message()
        if message is None:
            return
        response_message = handle_message(target, message)
        if response_message is not None:
            write_message(response_message)


def resolve_coordinates(target: str) -> tuple[str, str]:
    if target.startswith("http://") or target.startswith("https://"):
        return target.rstrip("/"), os.environ.get(TOKEN_ENV_VAR, "")

    try:
        with open(target, encoding="utf-8") as handle:
            coordinates = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "Could not read the June proxy coordinates "
            f"({target}): {exc}. The June app rewrites this file at "
            "startup; is the app running?"
        )

    base_url = str(coordinates.get("base_url") or "").rstrip("/")
    token = str(coordinates.get("token") or "")
    if not base_url:
        raise RuntimeError(f"The June proxy coordinates file ({target}) has no base_url.")
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
    handlers = {
        "film_studio_status": film_studio_status,
        "list_film_projects": list_film_projects,
        "create_film_project": create_film_project,
        "start_film_run": start_film_run,
        "film_status": film_status,
        "film_gates": film_gates,
        "decide_film_gate": decide_film_gate,
        "chat_with_film_studio": chat_with_film_studio,
        "start_film_production": start_film_production,
        "film_board": film_board,
        "film_shot_action": film_shot_action,
        "export_film": export_film,
    }
    try:
        handler = handlers.get(str(name))
        if handler is None:
            return error_response(request_id, -32602, f"Unknown tool: {name}")
        base_url, token = resolve_coordinates(target)
        result = handler(base_url, token, arguments)
    except Exception as exc:
        return response(
            request_id,
            {
                "isError": True,
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2),
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


# --- tools --------------------------------------------------------------------


def film_studio_status(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    settings = films_action(base_url, token, "settings", {})
    if not settings.get("activated"):
        return {
            "activated": False,
            "note": (
                "Film production is not activated. Ask the user to activate "
                "it in Settings > Film studio (it shares their Carpe Diem key "
                "with the first-party Videomaker studio after their consent)."
            ),
        }
    account = films_action(base_url, token, "account_status", {})
    return {"activated": True, "account": account}


def list_film_projects(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return films_action(base_url, token, "list_projects", {})


def create_film_project(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    title = str(arguments.get("title") or "").strip()
    if not title:
        raise ValueError("title is required")
    params: dict[str, Any] = {
        "title": title,
        "autonomous": bool(arguments.get("autonomous")),
    }
    if isinstance(arguments.get("aspect_ratio"), str):
        params["aspectRatio"] = arguments["aspect_ratio"]
    if isinstance(arguments.get("target_duration_seconds"), int):
        params["targetDurationSeconds"] = arguments["target_duration_seconds"]
    budget = arguments.get("budget_ceiling_diem")
    if isinstance(budget, (int, float)) and budget > 0:
        params["budgetCeilingDiem"] = budget
    return films_action(base_url, token, "create_project", params)


def start_film_run(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    slug = required_str(arguments, "slug")
    brief = required_str(arguments, "brief")
    cap = arguments.get("max_cost_diem")
    if not isinstance(cap, (int, float)) or cap <= 0:
        raise ValueError("max_cost_diem is required (agree a DIEM budget with the user)")
    result = films_action(
        base_url,
        token,
        "start_run",
        {"slug": slug, "brief": brief, "maxCostDiem": cap, "produce": True},
    )
    result["note"] = (
        "Run started. It drives every phase and launches production if the "
        "quote fits the cap. Check film_status for progress; the app "
        "downloads the finished film into the Studio gallery automatically."
    )
    return result


def film_status(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    slug = required_str(arguments, "slug")
    return films_action(base_url, token, "status", {"slug": slug})


def film_gates(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    slug = required_str(arguments, "slug")
    return films_action(base_url, token, "gates", {"slug": slug})


def decide_film_gate(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    slug = required_str(arguments, "slug")
    phase = required_str(arguments, "phase")
    decision = required_str(arguments, "decision")
    if decision not in ("approve", "reject"):
        raise ValueError('decision must be "approve" or "reject"')
    params: dict[str, Any] = {"slug": slug, "phase": phase}
    reason = arguments.get("reason")
    if isinstance(reason, str) and reason.strip():
        params["decisionReason"] = reason.strip()
    action = "gate_approve" if decision == "approve" else "gate_reject"
    return films_action(base_url, token, action, params)


def chat_with_film_studio(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    slug = required_str(arguments, "slug")
    message = required_str(arguments, "message")
    return films_action(
        base_url,
        token,
        "chat",
        {"slug": slug, "message": message},
        timeout=CHAT_TIMEOUT_SECONDS,
    )


def start_film_production(
    base_url: str, token: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    slug = required_str(arguments, "slug")
    cap = arguments.get("max_cost_diem")
    if not isinstance(cap, (int, float)) or cap <= 0:
        raise ValueError("max_cost_diem is required (agree a DIEM budget with the user)")
    quote = films_action(base_url, token, "produce", {"slug": slug})
    if quote.get("started"):
        return {"started": True}
    projected = quote.get("projected_cost_diem")
    if not isinstance(projected, (int, float)):
        return {
            "started": False,
            "quote": quote,
            "note": "The studio returned no usable quote; inspect the payload.",
        }
    if projected > cap:
        return {
            "started": False,
            "projected_cost_diem": projected,
            "max_cost_diem": cap,
            "note": (
                "The quote exceeds the agreed cap - production was NOT "
                "started. Tell the user the projected cost and ask whether "
                "to proceed with a higher cap."
            ),
        }
    confirmed = films_action(
        base_url, token, "produce", {"slug": slug, "confirmedCostDiem": projected}
    )
    if confirmed.get("needs_confirmation"):
        # The queue grew past the 2 % tolerance between quote and confirm.
        return {
            "started": False,
            "quote": confirmed,
            "note": "The quote moved; call start_film_production again.",
        }
    return {"started": True, "confirmed_cost_diem": projected, "detail": confirmed}


def film_board(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    slug = required_str(arguments, "slug")
    return films_action(base_url, token, "board", {"slug": slug})


def film_shot_action(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    slug = required_str(arguments, "slug")
    shot_id = required_str(arguments, "shot_id")
    action = required_str(arguments, "action")
    if action == "takes":
        return films_action(base_url, token, "shot_takes", {"slug": slug, "shotId": shot_id})
    if action == "select":
        version = arguments.get("version")
        if not isinstance(version, int):
            raise ValueError("version is required for select")
        return films_action(
            base_url,
            token,
            "take_select",
            {"slug": slug, "shotId": shot_id, "version": version},
        )
    if action == "retake":
        params: dict[str, Any] = {"slug": slug, "shotId": shot_id}
        prompt = arguments.get("prompt")
        if isinstance(prompt, str) and prompt.strip():
            params["prompt"] = prompt.strip()
        return films_action(base_url, token, "shot_retake", params)
    if action == "requeue":
        return films_action(base_url, token, "shot_requeue", {"slug": slug, "shotId": shot_id})
    if action == "skip":
        return films_action(base_url, token, "shot_skip", {"slug": slug, "shotId": shot_id})
    raise ValueError(f"Unknown shot action: {action}")


def export_film(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    slug = required_str(arguments, "slug")
    artifact = films_action(
        base_url, token, "export", {"slug": slug}, timeout=EXPORT_TIMEOUT_SECONDS
    )
    return {
        "status": "completed",
        "file_path": artifact.get("path"),
        "file_name": artifact.get("fileName"),
        "note": "Saved into the user's Studio gallery.",
    }


# --- proxy plumbing -----------------------------------------------------------


def films_action(
    base_url: str,
    token: str,
    action: str,
    params: dict[str, Any],
    timeout: int = REQUEST_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    payload = {"action": action, "params": params}
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/films/request", data=data, method="POST"
    )
    request.add_header("Content-Type", "application/json")
    request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        try:
            envelope = json.loads(detail) if detail else {}
        except json.JSONDecodeError:
            envelope = {}
        error = envelope.get("error")
        message = error.get("message") if isinstance(error, dict) else None
        raise RuntimeError(str(message or f"The June films proxy answered HTTP {exc.code}."))
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach the June films proxy: {exc.reason}")

    try:
        parsed = json.loads(body) if body else {}
    except json.JSONDecodeError:
        raise RuntimeError("The June films proxy returned an unreadable response.")
    if isinstance(parsed, dict):
        return parsed
    return {"result": parsed}


def required_str(arguments: dict[str, Any], field: str) -> str:
    value = str(arguments.get(field) or "").strip()
    if not value:
        raise ValueError(f"{field} is required")
    return value


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


if __name__ == "__main__":
    main()
