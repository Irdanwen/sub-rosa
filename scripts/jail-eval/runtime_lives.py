"""The sandboxed runtime, alive with its home read-only (ADR-0140).

Run by the ignored Rust test `the_runtime_lives_with_its_home_read_only`
(src-tauri/src/hermes_bridge/jail_runtime_tests.rs), which renders the
app's real profile and prepares the home with the app's own code first.

Free: the model is a local OpenAI-compatible server in this process that
plays a fixed script of tool calls, so the runtime's own agent loop runs
every tool for real, in its own process, under the profile. Nothing leaves
the machine.

usage: runtime_lives.py --hermes BIN --profile SB --home DIR --out JSON

Checks: the dashboard answers 200, a session opens, an image attaches, the
tools a sandboxed session needs work (terminal, background process, file
read, write, patch and search, todo, skills, session search, delegation),
the ones that would write the runtime's own settings are refused (memory,
skill writing, scheduling), the turn completes, and nothing in the home was
written outside the runtime state the profile re-opens. Exit 0 when all
hold; the details are written to --out.
"""

import argparse
import asyncio
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import websockets

# What the profile re-opens in the home (sandbox_profile.rs). Kept here by
# hand on purpose: the Rust test of the list is the gate on the list; this
# is the gate on the runtime staying inside it.
STATE_DIRS = ("workspace", "sessions", "logs", "cache", "images", "image_cache", "audio_cache", "mcp-tokens")
STATE_FILES = (
    "state.db", "state.db-wal", "state.db-shm", "state.db-journal",
    "verification_evidence.db", "verification_evidence.db-wal",
    "verification_evidence.db-shm", "verification_evidence.db-journal",
    "auth.lock",
)

SCRIPT = [
    ("terminal", {"command": "echo hi > shell-out.txt && cat shell-out.txt"}, "ok"),
    ("terminal", {"command": "sleep 1; echo bg", "background": True}, "ok"),
    # The system services the jail keeps (ADR-0140): TLS to a real host
    # (read only, free), file watching, and what it refuses.
    ("write_file", {"path": "tls_probe.py", "content": "import urllib.request\nprint('TLS-' + str(urllib.request.urlopen('https://example.com', timeout=20).status))\n"}, "ok"),
    ("terminal", {"command": "/usr/bin/python3 tls_probe.py"}, "contains:TLS-200"),
    ("terminal", {"command": "curl -s -o /dev/null -w 'CURL-%{http_code}' https://example.com"}, "contains:CURL-200"),
    ("terminal", {"command": "if command -v node >/dev/null; then node -e \"const fs=require('fs');fs.watch('.',()=>{console.log('WATCH-OK');process.exit(0)});let i=0;setInterval(()=>fs.writeFileSync('w'+(i++)+'.tmp','x'),300);setTimeout(()=>process.exit(1),8000)\"; else echo WATCH-OK-NO-NODE; fi"}, "contains:WATCH-OK"),
    ("terminal", {"command": "/usr/bin/open https://example.com; echo OPEN-RC=$?"}, "contains:OPEN-RC=1"),
    ("write_file", {"path": "ax_probe.py", "content": "import ctypes\nf = ctypes.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices').AXIsProcessTrusted\nf.restype = ctypes.c_bool\nprint('AX-' + str(f()))\n"}, "ok"),
    ("terminal", {"command": "python3 ax_probe.py"}, "contains:AX-False"),
    ("write_file", {"path": "note.md", "content": "hello\n"}, "ok"),
    ("read_file", {"path": "note.md"}, "ok"),
    ("patch", {"mode": "replace", "path": "note.md", "old_string": "hello", "new_string": "hullo"}, "ok"),
    ("search_files", {"pattern": "hullo"}, "ok"),
    ("write_file", {"path": "mod.py", "content": "def f(x):\n    return x + 1\n"}, "ok"),
    ("todo", {"todos": [{"id": "1", "content": "x", "status": "pending"}]}, "ok"),
    ("skills_list", {}, "ok"),
    ("skill_view", {"name": "jail-probe"}, "ok"),
    ("skill_view", {"name": "plan"}, "ok"),
    ("session_search", {"query": "tea"}, "ok"),
    ("delegate_task", {"goal": "CHILD-GOAL say ok"}, "ok"),
    ("process", {"action": "list"}, "ok"),
    ("memory", {"action": "add", "target": "memory", "content": "The user likes tea."}, "refused"),
    ("skill_manage", {"action": "create", "name": "planted-skill",
                      "content": "---\nname: planted-skill\ndescription: x\n---\nbody\n"}, "refused"),
    ("cronjob", {"action": "create", "name": "planted", "prompt": "hi", "schedule": "every 1h"}, "refused"),
]

RESULTS = {}


def free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class FakeModel(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self._send({"object": "list", "data": [{"id": "fake-model", "object": "model"}]})

    def _send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        req = json.loads(self.rfile.read(length) or b"{}")
        messages = req.get("messages", [])
        child = any(
            m.get("role") == "user" and "CHILD-GOAL" in json.dumps(m.get("content"))
            for m in messages
        )
        done = sum(1 for m in messages if m.get("role") == "tool")
        if not child and done and messages[-1].get("role") == "tool":
            name = SCRIPT[done - 1][0]
            RESULTS[f"{done - 1}:{name}"] = str(messages[-1].get("content"))
        if child or done >= len(SCRIPT) or "LIVES" not in json.dumps(messages):
            delta = {"role": "assistant", "content": "done"}
            finish = "stop"
        else:
            name, args, _ = SCRIPT[done]
            delta = {"role": "assistant", "tool_calls": [{
                "index": 0, "id": f"call_{done}", "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }]}
            finish = "tool_calls"
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        now = int(time.time())
        for chunk in (
            {"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
            {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
             "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
        ):
            chunk.update({"id": "x", "object": "chat.completion.chunk", "created": now, "model": "fake-model"})
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


def snapshot(root):
    state = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for name in filenames:
            path = os.path.join(dirpath, name)
            try:
                st = os.lstat(path)
            except OSError:
                continue
            state[path] = (st.st_size, st.st_mtime_ns)
    return state


def in_state(home, path):
    rel = os.path.relpath(path, home)
    first = rel.split(os.sep, 1)[0]
    return first in STATE_DIRS or rel in STATE_FILES


async def drive(port, token, report):
    url = f"ws://127.0.0.1:{port}/api/ws?token={token}"
    async with websockets.connect(url, max_size=None, open_timeout=30) as ws:
        counter = iter(range(1, 10_000))

        async def rpc(method, params):
            rid = next(counter)
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
            while True:
                frame = json.loads(await asyncio.wait_for(ws.recv(), 120))
                if frame.get("id") == rid:
                    return frame

        created = await rpc("session.create", {"title": "jail eval", "cols": 96})
        sid = (created.get("result") or {}).get("session_id")
        report["session"] = bool(sid)
        png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        attached = await rpc("image.attach_bytes", {"session_id": sid, "content_base64": png, "filename": "dot.png"})
        report["image"] = bool((attached.get("result") or {}).get("attached"))
        if not report["image"]:
            report["image_answer"] = json.dumps(attached)[:500]
        submitted = await rpc("prompt.submit", {"session_id": sid, "text": "LIVES run the script"})
        if "error" in submitted:
            report["submit_answer"] = json.dumps(submitted)[:500]
        deadline = time.time() + 240
        report["completed"] = False
        while time.time() < deadline:
            try:
                frame = json.loads(await asyncio.wait_for(ws.recv(), 30))
            except asyncio.TimeoutError:
                continue
            kind = (frame.get("params") or {}).get("type")
            report.setdefault("events", [])
            if kind and kind not in report["events"]:
                report["events"].append(kind)
            if kind == "error":
                report["error"] = json.dumps(frame)[:500]
                break
            if kind == "message.complete":
                report["completed"] = True
                break


def judge(outcome, text):
    if outcome.startswith("contains:"):
        return outcome[len("contains:"):] in text
    lowered = text.lower()
    refused = "operation not permitted" in lowered or "permissionerror" in lowered or '"success": false' in lowered
    failed = (
        refused
        or "error executing tool" in lowered
        or "tool_error" in lowered
        or '"error": "' in lowered
    )
    return refused if outcome == "refused" else not failed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--home", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    home = os.path.realpath(args.home)
    work = os.path.join(home, "workspace")
    report = {}

    model_port = free_port()
    server = ThreadingHTTPServer(("127.0.0.1", model_port), FakeModel)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    # What the app writes before a start, outside the jail.
    with open(os.path.join(home, "config.yaml"), "w") as handle:
        handle.write(
            "model:\n  default: \"fake-model\"\n  provider: custom\n"
            f"  base_url: \"http://127.0.0.1:{model_port}/v1\"\n  api_key: \"fake\"\n"
            "  api_mode: chat_completions\nagent:\n  max_turns: 60\n"
            "  disabled_toolsets: [browser]\napprovals:\n  mode: manual\n  cron_mode: deny\n"
        )
    before = snapshot(home)

    port = free_port()
    token = f"jail-eval-{port}"
    env = {k: v for k, v in os.environ.items() if not k.startswith(("HERMES_", "OPENAI", "ANTHROPIC"))}
    env.update(
        HERMES_HOME=home,
        HERMES_DASHBOARD_SESSION_TOKEN=token,
        NO_PROXY="127.0.0.1,localhost,::1",
        no_proxy="127.0.0.1,localhost,::1",
        PYTHONDONTWRITEBYTECODE="1",
    )
    log = open(os.path.join(os.path.dirname(os.path.realpath(args.out)), "dashboard.log"), "w")
    proc = subprocess.Popen(
        ["/usr/bin/sandbox-exec", "-f", args.profile, args.hermes, "--profile", "default",
         "dashboard", "--no-open", "--host", "127.0.0.1", "--port", str(port)],
        env=env, cwd=work, stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True,
    )
    report["status"] = None
    for _ in range(240):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=2) as reply:
                report["status"] = reply.status
                break
        except Exception:
            if proc.poll() is not None:
                break
            time.sleep(0.5)
    if report["status"] == 200:
        try:
            asyncio.run(drive(port, token, report))
        except Exception as error:
            report["drive"] = repr(error)
    time.sleep(2)
    try:
        os.killpg(proc.pid, 15)
        proc.wait(10)
    except Exception:
        try:
            os.killpg(proc.pid, 9)
        except Exception:
            pass
    server.shutdown()

    after = snapshot(home)
    report["written_outside_state"] = sorted(
        os.path.relpath(path, home)
        for path, meta in after.items()
        if before.get(path) != meta and not in_state(home, path)
    )
    tools = {}
    for index, (name, _, outcome) in enumerate(SCRIPT):
        text = RESULTS.get(f"{index}:{name}")
        tools[f"{index}:{name}"] = {
            "expected": outcome,
            "held": text is not None and judge(outcome, text),
            "result": (text or "<no result>")[:300],
        }
    report["tools"] = tools
    ok = (
        report.get("status") == 200
        and report.get("session")
        and report.get("image")
        and report.get("completed")
        and not report["written_outside_state"]
        and all(tool["held"] for tool in tools.values())
    )
    report["ok"] = bool(ok)
    with open(args.out, "w") as handle:
        json.dump(report, handle, indent=2)
    print(json.dumps(report, indent=2))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
