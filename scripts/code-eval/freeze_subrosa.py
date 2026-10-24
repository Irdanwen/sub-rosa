# /// script
# requires-python = ">=3.12"
# ///
"""Freeze the Sub Rosa part of the bench (ADR-0122) from merged pull requests.

Each task is a small, self-contained merged pull request of this repository:
the base is the merge's first parent, the request is the pull request's
description rewritten as an ask (no solution in it), and the check is the
tests the pull request added, run with the project's own runner. The test
patch and the gold patch (the rest of the pull request) are read from git and
written into `tasks/subrosa.json`, so the task file is self-contained.

    uv run scripts/code-eval/freeze_subrosa.py
    uv run scripts/code-eval/prepare.py --suite subrosa   # validates them

Run it from a clone that has the merge commits (any clone of main).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from codeeval import paths  # noqa: E402
from codeeval.fmt import biome_format  # noqa: E402

# id, pull request, merge commit, kind, test files, the request.
TASKS = [
    {
        "id": "subrosa-446-v2v-duration",
        "pr": 446,
        "merge": "1a8781bd9",
        "kind": "ts",
        "tests": ["src/test/studio-video-request.test.ts"],
        "prompt": (
            "Every video-to-video render started from the Video studio's source clip fails after "
            "it is queued. These models publish `durations: [\"Auto\"]` in the catalog; the "
            "operator's pre-flight accepts only that value, so the request body built in "
            "`src/lib/studio/video-request.ts` sends `duration: \"Auto\"`, and the provider then "
            "refuses the job at retrieve with `duration must be a positive number (input video "
            "duration in seconds)`. A number is refused by the pre-flight. Make the request body "
            "of a video-to-video model work: the source clip must set the length. Leave the "
            "upscalers' contract as it is."
        ),
    },
    {
        "id": "subrosa-410-durable-options",
        "pr": 410,
        "merge": "72c3993d6",
        "kind": "ts",
        "tests": ["src/test/studio-workflow-durable.test.ts"],
        "prompt": (
            "Canvas runs of a Studio workflow ignore the step cache: running the same workflow "
            "twice regenerates every step, and the level-by-level scheduling, failure isolation "
            "and rate-limit wait budget the caller asked for do not apply either. The unit tests "
            "of the cache and the scheduler call `runWorkflow` directly and pass; the canvas goes "
            "through `runAndSaveWorkflow` in `src/lib/studio/workflow-run.ts`. Make canvas runs "
            "honour every run option the caller passes."
        ),
    },
    {
        "id": "subrosa-460-canvas-save-race",
        "pr": 460,
        "merge": "ce6229f9b",
        "kind": "ts",
        "tests": ["src/test/workflow-open-keeps-steps.test.tsx"],
        "prompt": (
            "On a slow machine, opening a workflow in the Studio editor can save it with no "
            "steps: the next time it is opened the canvas is empty (\"The workflow is empty.\"). "
            "The editor's first render has the workflow from the library but an empty canvas; the "
            "steps arrive with the first hydrate, one render later, and the debounced save can "
            "fire in between. Fix `src/components/studio/WorkflowStudio.tsx` so that the graph the "
            "save, the validation and the run picture read never pairs a workflow with a canvas "
            "that has not been hydrated from it yet."
        ),
    },
    {
        "id": "subrosa-426-list-results",
        "pr": 426,
        "merge": "f23fe6ddc",
        "kind": "ts",
        "tests": ["src/test/workflow-run-picture.test.tsx"],
        "prompt": (
            "When a Studio workflow contains a list (for example a two-line text list feeding a "
            "voice step), the run works but the canvas shows no result on the list's steps: the "
            "copies made for each item (`voice#0`, `voice#1`) belong to no visible step. The view "
            "is built in `src/components/studio/workflow/useRunPicture.ts`. Make each step show "
            "the results of its list items."
        ),
    },
    {
        "id": "subrosa-131-account-watch",
        "pr": 131,
        "merge": "68a5a1d01",
        "kind": "ts",
        "tests": ["src/test/account-status-watch.test.ts"],
        "prompt": (
            "The sidebar footer still reads \"Sign in\" after the person signs in while the app is "
            "open: `SidebarIdentity` reads the account status once, at mount. Make the account "
            "status observable: in `src/lib/account.ts`, every account command that answers with "
            "an `AccountStatus` publishes it to subscribers (a `watchAccountStatus(listener)` "
            "function returning an unsubscribe function), a failed command publishes nothing, and "
            "the sidebar footer subscribes. Keep the exact call shape no-argument commands have "
            "today when they reach the bridge."
        ),
    },
    {
        "id": "subrosa-132-sync-errors",
        "pr": 132,
        "merge": "f7e4afc9b",
        "kind": "ts",
        "tests": ["src/test/account-sync-error.test.ts"],
        "prompt": (
            "Account synchronisation failures all show \"Synchronization could not finish. Try "
            "again.\" because most of the error codes the native side emits have no sentence. "
            "Move the mapping out of `AccountSettingsSection.tsx` into a new module "
            "`src/lib/account-sync-error.ts` exporting `accountSyncErrorMessage(code)` and the "
            "list of known codes, give every `sync_*` code the Rust sources under "
            "`src-tauri/src/account/` can emit its own sentence (through `t()`, with the French "
            "translation in the catalogs), never advise trying again for codes that mean work is "
            "in flight or waiting (`sync_local_work_active`, `sync_pending_changes`, "
            "`sync_dependencies_pending`), and never leak a path, host or native detail in a "
            "message."
        ),
    },
    {
        "id": "subrosa-476-practice-reply",
        "pr": 476,
        "merge": "79bdb3e6b",
        "kind": "ts",
        "tests": ["src/test/onboarding.test.tsx"],
        "prompt": (
            "In onboarding, the dictation practice step refuses short replies: dictating \"Yes\" "
            "or \"OK\" does not count as a success. Any non-blank reply should complete the step "
            "(`src/components/onboarding/steps/PracticeStep.tsx`)."
        ),
    },
    {
        "id": "subrosa-137-manual-notes",
        "pr": 137,
        "merge": "d4407cf4b",
        "kind": "rust",
        "tests": ["src-tauri/tests/processing.rs"],
        "cargo_test": ["--test", "processing"],
        "prompt": (
            "When a person types notes above the generated summary of a meeting note (rather than "
            "below it), those notes are lost the next time the note is regenerated: "
            "`manual_notes_for_generation` in `src-tauri/src/domain/processing.rs` only keeps "
            "what follows the generated text. Keep the manual notes wherever they are: text after "
            "the generated summary first, otherwise text before it."
        ),
    },
    {
        "id": "subrosa-140-session-order",
        "pr": 140,
        "merge": "94acd927b",
        "kind": "rust",
        "tests": ["src-tauri/tests/source_modes.rs"],
        "cargo_test": ["--test", "source_modes"],
        "prompt": (
            "A note recorded in several recording sessions shows its source transcripts out of "
            "order: `source_transcripts` in `src-tauri/src/db/repositories.rs` orders by "
            "`turn_index` first, so turn 0 of the second session comes before turn 5 of the "
            "first. Order the transcripts by recording session (when it started, then insertion "
            "order), then by turn, start time and creation, with a stable last tie-breaker."
        ),
    },
    {
        "id": "subrosa-120-agent-lifecycle",
        "pr": 120,
        "merge": "683f50637",
        "kind": "rust",
        "tests": ["src-tauri/tests/agent.rs"],
        "cargo_test": ["--test", "agent"],
        "prompt": (
            "Agent tasks have lifecycle races. Fix them, with a SQL migration where the schema "
            "must change (migrations are listed explicitly in `src-tauri/src/db/migrations.rs`; "
            "a migration comment must not contain a semicolon):\n"
            "- hydration completes a queued or running task only when there is an assistant reply "
            "newer than the latest user message;\n"
            "- the runtime placeholder moves status only by guarded transitions (queued to "
            "running, running to paused), so it never resurrects a task cancelled in flight;\n"
            "- the status repair completes only stale queued or running tasks whose latest "
            "message is the assistant's, leaving paused and waiting_for_user tasks alone;\n"
            "- hydrated messages carry the runtime's message identity in a new "
            "`agent_messages.external_id` column, unique per task, inserted with INSERT OR IGNORE "
            "so overlapping hydrations cannot duplicate a message; the migration removes existing "
            "duplicates before creating the unique index.\n"
            "The repository methods live in `src-tauri/src/db/repositories.rs`."
        ),
    },
]


def git(*args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(paths.REPO_ROOT), *args],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def main() -> int:
    out = []
    for task in TASKS:
        merge = git("rev-parse", task["merge"]).strip()
        base = git("rev-parse", f"{merge}^1").strip()
        changed = git("diff", "--name-only", base, merge).split()
        tests = task["tests"]
        missing = [t for t in tests if t not in changed]
        if missing:
            raise SystemExit(f"{task['id']}: {missing} not changed by the merge")
        others = [f for f in changed if f not in tests]
        record = {
            **task,
            "merge": merge,
            "base": base,
            "test_patch": git("diff", "--binary", base, merge, "--", *tests),
            "gold_patch": git("diff", "--binary", base, merge, "--", *others),
        }
        out.append(record)
    target = paths.TASKS_DIR / "subrosa.json"
    target.write_text(json.dumps({"tasks": out}, indent=2) + "\n")
    biome_format([target])
    print(f"{len(out)} tasks written to {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
