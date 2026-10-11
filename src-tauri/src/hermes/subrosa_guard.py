"""Sub Rosa's guard on the runtime's own memory (ADR-0083, ADR-0084).

Installed by the app as a Hermes user plugin (`$HERMES_HOME/plugins/
subrosa_guard/`) and enabled in the `config.yaml` the app writes. It vetoes a
tool call through the runtime's `pre_tool_call` hook, which every dispatch
path asks before running a tool, the background memory and skill review
included (that review runs under the session id of the chat it reviews).

What to veto is read, on every guarded call, from a ledger the app rewrites
whenever it changes (`subrosa-guard.json` next to `config.yaml`):

- `temporarySessions`: the stored ids of the open temporary chats. Their
  sessions may read memory but never write it: the runtime's memory tool and
  its skill writer are refused there. A session descended from one (a branch,
  or a continuation the runtime forks when it compacts a long chat) counts.
  So are the media tools that file what they make in the Studio gallery
  (every generation, and `make_document`'s file), which is kept and
  synchronised: the media server serves every session, so the app cannot
  tell which chat asked, and the refusal is made here, where the session is
  known.
- `memoryOff`: protected mode switched memory off. The memory tool and the
  recall of the app's own memory are refused in every session.
- `pastChatsOff`: protected mode switched past chats off. The runtime's
  session search and the app's past-chat search are refused in every session.

A ledger that exists but cannot be read refuses the guarded tools: it is
written atomically, so an unreadable one is damage, not a race.

The connectors (ADR-0092 addendum) reach this runtime as one built-in MCP
server, `subrosa_connectors`. Their rules are in the ledger too, under
`connectorRules`, by the runtime's tool name: `allow` runs, `deny` is
refused, and `ask`, or a connector tool the ledger does not name, goes to the
runtime's own approval with the sentence the app wrote. What the plugin
cannot read it asks about: the safe direction for a connector is a question.

The runtime also logs the start of every turn at INFO into `logs/agent.log`
("conversation turn: session=... msg=..."), with the first 80 characters of
the message (`agent/turn_context.py`). A temporary chat is not saved, so
that line must not keep its words: a filter on that logger replaces the
message with a placeholder when the session, or one it descends from, is
temporary, and when the record names no session while one is open.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Optional

LEDGER_NAME = "subrosa-guard.json"
STATE_DB_NAME = "state.db"

# Tools that would keep something from a conversation beyond it.
WRITE_TOOLS = frozenset({"memory", "skill_manage"})
# The media tools that save into the gallery, under the name the runtime
# gives an MCP tool (`mcp_<server>_<tool>`, or `mcp__<server>__<tool>`).
GALLERY_TOOLS = re.compile(
    r"mcp_{1,2}june_media_{1,2}(generate_image|generate_video|generate_music|check_media|make_document)"
)
# Tools that read the person's memory, or their other conversations.
MEMORY_READ_SUFFIXES = ("search_user_memories",)
PAST_CHAT_TOOLS = frozenset({"session_search"})
PAST_CHAT_SUFFIXES = ("search_past_chats",)
# How far up a session's parents the lineage check walks.
MAX_LINEAGE = 16
# The connectors' tools, as the runtime names them.
CONNECTOR_PREFIX = "mcp__subrosa_connectors__"
# How much of a call's arguments the approval shows.
MAX_ARGUMENTS_SHOWN = 600

TEMPORARY_MESSAGE = (
    "This is a temporary chat: nothing from it may be saved to memory or to "
    "skills. Answer without saving anything."
)
MEMORY_OFF_MESSAGE = (
    "Memory is turned off on this device by protected mode. Answer without "
    "saving or recalling memories."
)
PAST_CHATS_OFF_MESSAGE = (
    "Past chats are turned off on this device by protected mode. Answer "
    "without searching other conversations."
)
CONNECTOR_OFF_MESSAGE = (
    "This action is turned off for this connector in Sub Rosa. Tell the user "
    "it is off, and that they can allow it in Settings, Connectors."
)
CONNECTOR_ASK_MESSAGE = "Sub Rosa asks you before a connector changes something."
TEMPORARY_GALLERY_MESSAGE = (
    "This is a temporary chat: nothing from it may be saved, and this tool "
    "saves what it makes into the gallery. Tell the user to start a regular "
    "chat to make it."
)
# The runtime's per-turn log line (`agent/turn_context.py`): its logger, the
# start of its format, and what replaces a temporary chat's words in it.
TURN_LOGGER = "agent.turn_context"
TURN_RECORD = "conversation turn:"
REDACTED_TURN = "[temporary chat]"

UNREADABLE_MESSAGE = (
    "Sub Rosa could not confirm that this chat may use memory, so nothing is "
    "saved or recalled. Answer without it."
)


class _Unreadable(Exception):
    pass


def _home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or ".")


def _ledger(home: Path) -> dict:
    path = home / LEDGER_NAME
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise _Unreadable() from error
    try:
        value = json.loads(raw)
    except ValueError as error:
        raise _Unreadable() from error
    if not isinstance(value, dict):
        raise _Unreadable()
    return value


def _parent(home: Path, session_id: str) -> Optional[str]:
    path = home / STATE_DB_NAME
    if not path.exists():
        return None
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
        try:
            row = connection.execute(
                "SELECT parent_session_id FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
        finally:
            connection.close()
    except sqlite3.Error:
        return None
    return row[0] if row and isinstance(row[0], str) and row[0] else None


def is_temporary(session_id: str, temporary: set, home: Path) -> bool:
    """Whether `session_id`, or a session it descends from, is temporary."""
    seen = set()
    current: Optional[str] = session_id
    while current and current not in seen and len(seen) < MAX_LINEAGE:
        if current in temporary:
            return True
        seen.add(current)
        current = _parent(home, current)
    return False


def _matches(tool_name: str, names: frozenset, suffixes: tuple) -> bool:
    return tool_name in names or any(
        tool_name.endswith(suffix) and "june_context" in tool_name for suffix in suffixes
    )


def decide(tool_name: str, session_id: str, home: Optional[Path] = None) -> Optional[str]:
    """The message that refuses this call, or None to let it run."""
    gallery = GALLERY_TOOLS.fullmatch(tool_name) is not None
    guarded_write = tool_name in WRITE_TOOLS or gallery
    memory_read = _matches(tool_name, frozenset(), MEMORY_READ_SUFFIXES)
    past_chats = _matches(tool_name, PAST_CHAT_TOOLS, PAST_CHAT_SUFFIXES)
    if not (guarded_write or memory_read or past_chats):
        return None
    home = home or _home()
    try:
        ledger = _ledger(home)
    except _Unreadable:
        return UNREADABLE_MESSAGE
    if ledger.get("memoryOff") is True and (tool_name == "memory" or memory_read):
        return MEMORY_OFF_MESSAGE
    if ledger.get("pastChatsOff") is True and past_chats:
        return PAST_CHATS_OFF_MESSAGE
    if guarded_write:
        temporary = {
            value
            for value in ledger.get("temporarySessions") or []
            if isinstance(value, str) and value
        }
        message = TEMPORARY_GALLERY_MESSAGE if gallery else TEMPORARY_MESSAGE
        if temporary and not session_id:
            # A call that cannot say which chat it belongs to, while a
            # temporary chat is open, is refused rather than guessed at.
            return message
        if temporary and is_temporary(session_id, temporary, home):
            return message
    return None


def connector_directive(
    tool_name: str, args: Any = None, home: Optional[Path] = None
) -> Optional[dict]:
    """The directive for a connector tool, or None when it is not one or may run."""
    if not tool_name.startswith(CONNECTOR_PREFIX):
        return None
    home = home or _home()
    try:
        rules = _ledger(home).get("connectorRules")
    except _Unreadable:
        rules = None
    entry = rules.get(tool_name) if isinstance(rules, dict) else None
    rule = entry.get("rule") if isinstance(entry, dict) else None
    if rule == "allow":
        return None
    if rule == "deny":
        return {"action": "block", "message": CONNECTOR_OFF_MESSAGE}
    message = entry.get("message") if isinstance(entry, dict) else None
    if not isinstance(message, str) or not message:
        message = CONNECTOR_ASK_MESSAGE
    if isinstance(args, dict) and args:
        shown = json.dumps(args, ensure_ascii=False, sort_keys=True)
        if len(shown) > MAX_ARGUMENTS_SHOWN:
            shown = shown[:MAX_ARGUMENTS_SHOWN] + "..."
        message = f"{message}\n{shown}"
    # One approval per tool: "for this session" covers this tool only.
    return {"action": "approve", "message": message, "rule_key": f"subrosa_connector:{tool_name}"}


def turn_log_is_temporary(session_id: str, home: Optional[Path] = None) -> bool:
    """Whether a turn's log line belongs to a temporary chat (or may)."""
    home = home or _home()
    try:
        ledger = _ledger(home)
    except _Unreadable:
        return True
    temporary = {
        value
        for value in ledger.get("temporarySessions") or []
        if isinstance(value, str) and value
    }
    if not temporary:
        return False
    if not session_id or session_id == "none":
        return True
    return is_temporary(session_id, temporary, home)


class TemporaryTurnFilter(logging.Filter):
    """Keeps a temporary chat's words out of the runtime's turn log line.

    The record stays (the turn still happened, and the line is what tells a
    reader a turn started), only its `msg=` argument is replaced. The
    message is the format's last argument and the session its first.
    """

    subrosa_guard = True

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if not str(record.msg).startswith(TURN_RECORD):
                return True
            args = record.args
            if not isinstance(args, tuple) or not args:
                return True
            if turn_log_is_temporary(str(args[0] or "")):
                record.args = args[:-1] + (REDACTED_TURN,)
        except Exception:
            # Never break a turn over its log line, and never keep the words
            # when the check itself failed.
            if isinstance(record.args, tuple) and record.args:
                record.args = record.args[:-1] + (REDACTED_TURN,)
        return True


def install_log_filter() -> None:
    """Adds the filter once, even when the runtime discovers plugins again."""
    turn_logger = logging.getLogger(TURN_LOGGER)
    if any(getattr(existing, "subrosa_guard", False) for existing in turn_logger.filters):
        return
    turn_logger.addFilter(TemporaryTurnFilter())


def _pre_tool_call(tool_name: str = "", session_id: str = "", args: Any = None, **_: Any):
    name = str(tool_name or "")
    if name.startswith(CONNECTOR_PREFIX):
        try:
            return connector_directive(name, args)
        except Exception:
            # Never let a connector call through on the hook's own failure.
            return {"action": "approve", "message": CONNECTOR_ASK_MESSAGE}
    try:
        message = decide(str(tool_name or ""), str(session_id or ""))
    except Exception:
        # The hook must never let a guarded call through on its own failure.
        if str(tool_name or "") in WRITE_TOOLS or GALLERY_TOOLS.fullmatch(str(tool_name or "")):
            return {"action": "block", "message": UNREADABLE_MESSAGE}
        return None
    if message is None:
        return None
    return {"action": "block", "message": message}


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    install_log_filter()
