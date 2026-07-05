#!/usr/bin/env python3
"""MCP server exposing June media generation tools (image, video, music).

The June app writes this script into the managed Hermes home and registers it
as the built-in `june_media` MCP server. The tools call the June app's local
provider proxy (loopback only), which holds the user's media API key in the
Rust process and forwards requests to the configured media backend through an
allowlisted path proxy. Generated files are saved by the app into the Studio
gallery and the tools return their absolute paths, so the agent never needs
the API key, network access, or write access outside its sandbox.

Image generation is synchronous (with an automatic fallback to the async
queue when the sync path hits the edge cap). Video and music are queued:
`generate_video` / `generate_music` return a `queue_id` immediately and
`check_media` polls once per call, downloading the file into the gallery when
the render completes.

The proxy's coordinates (base URL + token) are NOT baked in at spawn time:
argv[1] is the path to a JSON file the app rewrites on every runtime spawn,
and this server re-reads it on every tool call (same contract as the
`june_web` MCP, and the same coordinates file).

It depends only on the Python standard library so it can run inside the
Hermes runtime venv without extra packaging.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any


PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "june-media", "version": "0.1.0"}
TOKEN_ENV_VAR = "JUNE_WEB_PROXY_TOKEN"

# One generous timeout for sync image generation (the backend's edge cap is
# ~60 s; the queue fallback below covers anything slower), a long one for
# downloads the app performs on our behalf, a short one for everything else.
IMAGE_SYNC_TIMEOUT_SECONDS = 150
SAVE_TIMEOUT_SECONDS = 300
REQUEST_TIMEOUT_SECONDS = 60

# Async image queue fallback: poll every 3 s for up to ~3 minutes, inside the
# single generate_image call.
IMAGE_QUEUE_POLL_SECONDS = 3
IMAGE_QUEUE_MAX_ATTEMPTS = 60

# Models whose sync path exceeds the edge cap: queue from the start (mirrors
# the Studio's list).
HEAVY_IMAGE_MODELS = ("gpt-image", "nano-banana-pro", "recraft-v4-pro")

# When the agent names no model, prefer the catalog entry carrying the
# "default" trait, then these ids (in order). The catalog's own ordering is
# alphabetical, which would "default" to special-purpose or adult models
# (bria-bg-remover, lustify-*) — never an acceptable surprise. Falls back to
# the first standard-tier entry, then the first entry.
PREFERRED_DEFAULT_MODELS = {
    "image": ("venice-sd35", "qwen-image", "flux-2-pro", "chroma"),
    "music": (
        "minimax-music-v26",
        "minimax-music-v25",
        "minimax-music-v2",
        "ace-step-15",
        "stable-audio-25",
    ),
}

# The constraint keys worth relaying to the agent (aspect ratios and durations
# drive valid generate_* arguments); the rest of the Venice constraint blob is
# noise at tool-choice time.
RELAYED_CONSTRAINT_KEYS = ("aspectRatios", "durations", "resolutions", "promptCharacterLimit")

# The loopback proxy caps request bodies at 3 MiB; leave headroom for the
# JSON envelope around a base64 reference image.
MAX_REFERENCE_IMAGE_BYTES = 2 * 1024 * 1024

MEDIA_TYPES = ("image", "imageEdit", "video", "imageToVideo", "music", "tts", "upscale")

CATALOG_TTL_SECONDS = 600
_catalog_cache: dict[str, Any] = {"at": 0.0, "backend": "", "models": []}


TOOLS: list[dict[str, Any]] = [
    {
        "name": "generate_image",
        "description": (
            "Generate an image from a text prompt. The file is saved into the "
            "user's Studio gallery and the absolute path is returned. Runs "
            "synchronously (up to a few minutes for heavy models). Costs "
            "credits from the user's media balance. Pick the model to fit the "
            "request: call list_media_models (type=image) and choose by "
            "traits, tier, and price - e.g. a cheap default/fastest model for "
            "quick or iterative asks, highest_quality or a premium/frontier "
            "model when the user wants photorealism, fine detail, or "
            "legible text in the image. Omit model only for generic requests."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "What to draw, as a detailed visual description.",
                },
                "model": {
                    "type": "string",
                    "description": (
                        "Image model id (see list_media_models). When omitted, "
                        "the catalog's default-trait model is used."
                    ),
                },
                "aspect_ratio": {
                    "type": "string",
                    "description": 'Aspect ratio such as "1:1", "16:9", "9:16" (model dependent).',
                },
                "width": {"type": "integer", "description": "Width in pixels (model dependent)."},
                "height": {"type": "integer", "description": "Height in pixels (model dependent)."},
                "style_preset": {
                    "type": "string",
                    "description": "Optional style preset name (model dependent).",
                },
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "generate_video",
        "description": (
            "Queue a video generation from a text prompt (optionally animating "
            "a local reference image). Returns a queue_id immediately; call "
            "check_media to poll and download the finished file. Video is the "
            "most expensive media kind (roughly $0.4 to $10+ per clip depending "
            "on the model) - state the chosen model and get the user's go-ahead "
            "before queueing anything beyond a short default clip."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "What should happen in the video.",
                },
                "model": {
                    "type": "string",
                    "description": "Video model id (required; see list_media_models).",
                },
                "duration": {
                    "type": "string",
                    "description": 'Clip duration as a string with unit, e.g. "5s" (model dependent). Defaults to "5s".',
                },
                "aspect_ratio": {
                    "type": "string",
                    "description": 'Aspect ratio such as "16:9" (model dependent).',
                },
                "resolution": {
                    "type": "string",
                    "description": 'Resolution such as "720p" (model dependent).',
                },
                "image_path": {
                    "type": "string",
                    "description": (
                        "Absolute path of a local image to animate (image-to-video). "
                        "Requires an image-to-video capable model."
                    ),
                },
            },
            "required": ["prompt", "model"],
        },
    },
    {
        "name": "generate_music",
        "description": (
            "Queue a music/audio-track generation from a text prompt. Returns "
            "a queue_id immediately; call check_media to poll and download the "
            "finished file. Costs credits from the user's media balance."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "Style, mood, instrumentation, tempo of the track.",
                },
                "model": {
                    "type": "string",
                    "description": (
                        "Music model id (see list_media_models). Defaults to a "
                        "music model from the catalog."
                    ),
                },
                "lyrics": {
                    "type": "string",
                    "description": (
                        "Lyrics to sing. Some models require lyrics, some forbid "
                        "them - check the model's constraints if the queue call "
                        "is rejected."
                    ),
                },
                "duration_seconds": {
                    "type": "integer",
                    "description": "Track duration in seconds (model dependent).",
                },
                "instrumental": {
                    "type": "boolean",
                    "description": "Force an instrumental track (no vocals).",
                },
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "check_media",
        "description": (
            "Check a queued video or music generation. While rendering it "
            "returns a pending status (wait ~30 seconds between checks); once "
            "complete it downloads the file into the user's Studio gallery and "
            "returns the absolute path."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": ["video", "music"]},
                "queue_id": {
                    "type": "string",
                    "description": "The queue_id returned by generate_video / generate_music.",
                },
                "model": {
                    "type": "string",
                    "description": "The model id the job was queued with (required by the backend).",
                },
            },
            "required": ["kind", "queue_id", "model"],
        },
    },
    {
        "name": "list_media_models",
        "description": (
            "List the media models available to the user: id, type, tier "
            "(standard < premium < frontier), traits (default, fastest, "
            "highest_quality, most_uncensored), price per generation, and "
            "generation constraints (aspect ratios, durations, resolutions). "
            "Call this before generating and choose the model that best fits "
            "the request and the user's budget."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "type": {
                    "type": "string",
                    "enum": list(MEDIA_TYPES),
                    "description": "Only return models of this type.",
                },
            },
        },
    },
]


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: june_media_mcp.py <coordinates_json_path>")

    target = sys.argv[1]
    while True:
        message = read_message()
        if message is None:
            return
        response_message = handle_message(target, message)
        if response_message is not None:
            write_message(response_message)


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
        "generate_image": generate_image,
        "generate_video": generate_video,
        "generate_music": generate_music,
        "check_media": check_media,
        "list_media_models": list_media_models,
    }
    try:
        handler = handlers.get(str(name))
        if handler is None:
            return error_response(request_id, -32602, f"Unknown tool: {name}")
        # Resolved inside the try so a missing/corrupt coordinates file
        # surfaces as a tool error the agent can report, not a dead server.
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


# --- tools --------------------------------------------------------------------


def generate_image(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    prompt = str(arguments.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")
    model = str(arguments.get("model") or "").strip() or default_model(
        base_url, token, "image"
    )
    body: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "format": "png",
        "variants": 1,
        "hide_watermark": True,
    }
    for field in ("aspect_ratio", "style_preset"):
        value = arguments.get(field)
        if isinstance(value, str) and value.strip():
            body[field] = value.strip()
    for field in ("width", "height"):
        value = arguments.get(field)
        if isinstance(value, int) and value > 0:
            body[field] = value

    if is_heavy_image_model(model):
        b64, extension = generate_image_via_queue(base_url, token, body)
    else:
        dto = proxy_request(
            base_url, token, "POST", "/image/generate", body, IMAGE_SYNC_TIMEOUT_SECONDS
        )
        if dto.get("ok"):
            b64, extension = first_image(dto), "png"
        elif dto.get("status") == 502:
            # A 502 on the sync path is usually the backend's edge cap, not a
            # failure: the async queue renders the same request without it.
            b64, extension = generate_image_via_queue(base_url, token, body)
        else:
            raise RuntimeError(upstream_error(dto, "Image generation failed."))

    artifact = save_artifact(base_url, token, {"base64": b64, "extension": extension})
    return {
        "status": "completed",
        "kind": "image",
        "model": model,
        "file_path": artifact.get("path"),
        "file_name": artifact.get("fileName"),
        "note": "Saved into the user's Studio gallery.",
    }


def generate_image_via_queue(
    base_url: str, token: str, body: dict[str, Any]
) -> tuple[str, str]:
    dto = proxy_request(base_url, token, "POST", "/image/generate/queue", body)
    if not dto.get("ok"):
        raise RuntimeError(upstream_error(dto, "Image generation failed to queue."))
    queue_id = queue_id_of(dto.get("json") or {})
    for _ in range(IMAGE_QUEUE_MAX_ATTEMPTS):
        dto = proxy_request(
            base_url, token, "POST", "/image/generate/retrieve", {"queue_id": queue_id}
        )
        # The retrieve endpoint answers JSON while pending and raw image bytes
        # once done; the proxy base64-encodes raw bytes for us.
        raw = dto.get("bodyBase64")
        if isinstance(raw, str) and raw:
            return raw, extension_of(dto.get("contentType"), "png")
        payload = dto.get("json") or {}
        status = str(payload.get("status") or "").lower()
        if status in ("failed", "error", "cancelled", "canceled"):
            raise RuntimeError(str(payload.get("error") or "The image generation failed."))
        time.sleep(IMAGE_QUEUE_POLL_SECONDS)
    raise RuntimeError(
        "The image is taking longer than expected. It may still finish - try again later."
    )


def generate_video(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    prompt = str(arguments.get("prompt") or "").strip()
    model = str(arguments.get("model") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")
    if not model:
        raise ValueError("model is required (call list_media_models with type=video)")
    body: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "duration": str(arguments.get("duration") or "5s"),
    }
    for field in ("aspect_ratio", "resolution"):
        value = arguments.get(field)
        if isinstance(value, str) and value.strip():
            body[field] = value.strip()
    image_path = str(arguments.get("image_path") or "").strip()
    if image_path:
        body["image_url"] = local_image_data_uri(image_path)

    dto = proxy_request(base_url, token, "POST", "/video/queue", body)
    if not dto.get("ok"):
        raise RuntimeError(upstream_error(dto, "Video generation failed to queue."))
    return queued_result("video", queue_id_of(dto.get("json") or {}), model)


def generate_music(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    prompt = str(arguments.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")
    model = str(arguments.get("model") or "").strip() or default_model(
        base_url, token, "music"
    )
    body: dict[str, Any] = {"model": model, "prompt": prompt}
    lyrics = arguments.get("lyrics")
    if isinstance(lyrics, str) and lyrics.strip():
        body["lyrics_prompt"] = lyrics
    duration = arguments.get("duration_seconds")
    if isinstance(duration, int) and duration > 0:
        body["duration_seconds"] = duration
    instrumental = arguments.get("instrumental")
    if isinstance(instrumental, bool):
        body["force_instrumental"] = instrumental

    dto = proxy_request(base_url, token, "POST", music_paths(base_url, token)["queue"], body)
    if not dto.get("ok"):
        raise RuntimeError(upstream_error(dto, "Music generation failed to queue."))
    return queued_result("music", queue_id_of(dto.get("json") or {}), model)


def check_media(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    kind = str(arguments.get("kind") or "").strip()
    queue_id = str(arguments.get("queue_id") or "").strip()
    model = str(arguments.get("model") or "").strip()
    if kind not in ("video", "music"):
        raise ValueError('kind must be "video" or "music"')
    if not queue_id or not model:
        raise ValueError("queue_id and model are required")

    if kind == "video":
        retrieve_path = "/video/retrieve"
        url_fields = ("video_url", "url")
        extension = "mp4"
    else:
        retrieve_path = music_paths(base_url, token)["retrieve"]
        url_fields = ("audio_url", "url")
        extension = "mp3"

    # Superset body: Venice reads `id`, Carpe Diem reads `queue_id` + `model`.
    dto = proxy_request(
        base_url,
        token,
        "POST",
        retrieve_path,
        {"id": queue_id, "queue_id": queue_id, "model": model},
    )
    if not dto.get("ok"):
        raise RuntimeError(upstream_error(dto, "Checking the job failed."))
    payload = dto.get("json") or {}
    status = str(payload.get("status") or "").lower()
    if status in ("failed", "error", "cancelled", "canceled"):
        raise RuntimeError(str(payload.get("error") or "The generation failed."))
    if status in ("completed", "complete", "succeeded", "success", "done"):
        url = next(
            (payload[field] for field in url_fields if isinstance(payload.get(field), str)),
            "",
        )
        if not url:
            raise RuntimeError("The job completed but returned no file URL.")
        artifact = save_artifact(base_url, token, {"url": url, "extension": extension})
        return {
            "status": "completed",
            "kind": kind,
            "model": model,
            "file_path": artifact.get("path"),
            "file_name": artifact.get("fileName"),
            "note": "Saved into the user's Studio gallery.",
        }
    return {
        "status": status or "pending",
        "kind": kind,
        "queue_id": queue_id,
        "model": model,
        "note": "Still rendering. Check again in about 30 seconds.",
    }


def list_media_models(base_url: str, token: str, arguments: dict[str, Any]) -> dict[str, Any]:
    backend, models = catalog(base_url, token)
    wanted = str(arguments.get("type") or "").strip()
    if wanted:
        models = [model for model in models if model["type"] == wanted]
    return {"backend": backend, "models": models}


# --- catalog ------------------------------------------------------------------


def catalog(base_url: str, token: str) -> tuple[str, list[dict[str, Any]]]:
    """The app's merged model catalog: backend availability enriched with
    Venice traits/constraints and per-model prices. This is the same data the
    Studio's model pickers run on."""
    now = time.monotonic()
    if _catalog_cache["models"] and now - _catalog_cache["at"] < CATALOG_TTL_SECONDS:
        return _catalog_cache["backend"], _catalog_cache["models"]

    payload = call_proxy(base_url, token, "/media/catalog", None, REQUEST_TIMEOUT_SECONDS)
    backend = str(payload.get("backend") or "carpe-diem")
    multiplier = payload.get("priceMultiplier")
    models: list[dict[str, Any]] = []
    for entry in payload.get("models") or []:
        if not isinstance(entry, dict):
            continue
        media_type = str(entry.get("mediaType") or "")
        model_id = str(entry.get("id") or "")
        if media_type not in MEDIA_TYPES or not model_id:
            continue
        model: dict[str, Any] = {"id": model_id, "type": media_type}
        if isinstance(entry.get("tier"), str):
            model["tier"] = entry["tier"]
        traits = [t for t in entry.get("traits") or [] if isinstance(t, str)]
        if traits:
            model["traits"] = traits
        cost = generation_cost(entry, multiplier)
        if cost is not None:
            model["approx_usd_per_generation"] = cost
        constraints = entry.get("constraints")
        if isinstance(constraints, dict):
            relayed = {
                key: constraints[key]
                for key in RELAYED_CONSTRAINT_KEYS
                if key in constraints
            }
            if relayed:
                model["constraints"] = relayed
        models.append(model)
    _catalog_cache.update({"at": now, "backend": backend, "models": models})
    return backend, models


def generation_cost(entry: dict[str, Any], multiplier: Any) -> float | None:
    """Approximate per-generation USD: the backend's flat credit price when
    published (1 credit = $0.01), else Venice's list price scaled by the
    backend's price multiplier."""
    credits = entry.get("costCredits")
    if isinstance(credits, (int, float)):
        return round(credits / 100.0, 4)
    pricing = entry.get("pricing")
    if isinstance(pricing, dict):
        usd = (pricing.get("generation") or {}).get("usd")
        if isinstance(usd, (int, float)):
            scale = multiplier if isinstance(multiplier, (int, float)) else 1.0
            return round(usd * scale, 4)
    return None


def default_model(base_url: str, token: str, media_type: str) -> str:
    _, models = catalog(base_url, token)
    candidates = [model for model in models if model["type"] == media_type]
    if not candidates:
        raise RuntimeError(f"No {media_type} model is available on this backend.")
    for candidate in candidates:
        if "default" in candidate.get("traits", ()):
            return candidate["id"]
    available = {candidate["id"] for candidate in candidates}
    for preferred in PREFERRED_DEFAULT_MODELS.get(media_type, ()):
        if preferred in available:
            return preferred
    for candidate in candidates:
        if candidate.get("tier") == "standard":
            return candidate["id"]
    return candidates[0]["id"]


def music_paths(base_url: str, token: str) -> dict[str, str]:
    # Music lives under /audio/music/* on Carpe Diem but /audio/* on Venice.
    backend, _ = catalog(base_url, token)
    if backend == "carpe-diem":
        return {"queue": "/audio/music/queue", "retrieve": "/audio/music/retrieve"}
    return {"queue": "/audio/queue", "retrieve": "/audio/retrieve"}


# --- proxy plumbing -----------------------------------------------------------


def proxy_request(
    base_url: str,
    token: str,
    method: str,
    path: str,
    body: dict[str, Any] | None,
    timeout: int = REQUEST_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Forward `method path body` through the app's media proxy. Returns the
    proxy's response DTO: {status, ok, json?, bodyBase64?, contentType?}."""
    payload: dict[str, Any] = {"method": method, "path": path}
    if body is not None:
        payload["body"] = body
    return call_proxy(base_url, token, "/media/request", payload, timeout)


def save_artifact(
    base_url: str, token: str, payload: dict[str, Any]
) -> dict[str, Any]:
    """Ask the app to persist a generation ({base64|url, extension}) into the
    Studio gallery. Returns {path, fileName, bytes}."""
    return call_proxy(base_url, token, "/media/save", payload, SAVE_TIMEOUT_SECONDS)


def call_proxy(
    base_url: str, token: str, path: str, payload: dict[str, Any] | None, timeout: int
) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        f"{base_url}{path}", data=data, method="POST" if data is not None else "GET"
    )
    if data is not None:
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
        message = (
            (envelope.get("error") or {}).get("message")
            if isinstance(envelope.get("error"), dict)
            else None
        )
        raise RuntimeError(str(message or f"The June media proxy answered HTTP {exc.code}."))
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach the June media proxy: {exc.reason}")

    try:
        return json.loads(body) if body else {}
    except json.JSONDecodeError:
        raise RuntimeError("The June media proxy returned an unreadable response.")


# --- helpers ------------------------------------------------------------------


def is_heavy_image_model(model: str) -> bool:
    lowered = model.lower()
    return any(marker in lowered for marker in HEAVY_IMAGE_MODELS)


def first_image(dto: dict[str, Any]) -> str:
    images = (dto.get("json") or {}).get("images") or []
    for image in images:
        if isinstance(image, str) and image.strip():
            return image
        if isinstance(image, dict):
            b64 = image.get("b64_json")
            if isinstance(b64, str) and b64.strip():
                return b64
    raise RuntimeError("The backend returned no image.")


def queue_id_of(payload: dict[str, Any]) -> str:
    queue_id = payload.get("queue_id") or payload.get("id")
    if not isinstance(queue_id, str) or not queue_id:
        raise RuntimeError("The backend did not return a job id.")
    return queue_id


def queued_result(kind: str, queue_id: str, model: str) -> dict[str, Any]:
    return {
        "status": "queued",
        "kind": kind,
        "queue_id": queue_id,
        "model": model,
        "note": (
            f"Rendering started. Call check_media with kind={kind}, this "
            "queue_id and this model after ~30-60 seconds; renders typically "
            "take one to five minutes."
        ),
    }


def upstream_error(dto: dict[str, Any], fallback: str) -> str:
    payload = dto.get("json")
    if isinstance(payload, dict):
        for field in ("error", "message", "detail"):
            value = payload.get(field)
            if isinstance(value, str) and value.strip():
                return f"{value} (HTTP {dto.get('status')})"
    return f"{fallback} (HTTP {dto.get('status')})"


def extension_of(content_type: Any, fallback: str) -> str:
    if isinstance(content_type, str):
        subtype = content_type.split(";")[0].strip().split("/")[-1].lower()
        if subtype == "jpeg":
            return "jpg"
        if subtype.isalnum() and 1 <= len(subtype) <= 5:
            return subtype
    return fallback


def local_image_data_uri(path: str) -> str:
    import base64 as b64mod

    mime_by_extension = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }
    _, extension = os.path.splitext(path)
    mime = mime_by_extension.get(extension.lower())
    if mime is None:
        raise ValueError(
            "image_path must point to a .png, .jpg, .jpeg, or .webp file."
        )
    try:
        size = os.path.getsize(path)
    except OSError as exc:
        raise ValueError(f"Could not read image_path: {exc}")
    if size > MAX_REFERENCE_IMAGE_BYTES:
        raise ValueError(
            "That reference image is too large to send through the media "
            "proxy (2 MB max). Use a smaller image."
        )
    with open(path, "rb") as handle:
        encoded = b64mod.b64encode(handle.read()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


if __name__ == "__main__":
    main()
