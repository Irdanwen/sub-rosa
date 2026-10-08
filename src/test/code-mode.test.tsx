// Code mode (ADR-0090): the session bar's buttons, the review panel's keep and
// revert, and the block the agent is told with each message.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { CodeModeControls } from "../components/agent/CodeModeControls";
import { CodeReviewPanel } from "../components/agent/CodeReviewPanel";
import { forgetSessionWorkingDir } from "../lib/agent-session-working-dir";
import {
  type CodeReviewStatus,
  diffLineKind,
  type FileChange,
  withCodeContext,
} from "../lib/code-mode";

const FOLDER = "/Users/me/project";
const ON: CodeReviewStatus = {
  active: true,
  folder: FOLDER,
  base: "git",
  startedAt: "2026-10-08T10:00:00Z",
};

let status: CodeReviewStatus = { active: false };
let changes: FileChange[] = [];
const calls: [string, unknown][] = [];

function change(path: string, extra: Partial<FileChange> = {}): FileChange {
  return {
    path,
    status: "modified",
    diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    additions: 1,
    deletions: 1,
    binary: false,
    revertible: true,
    truncated: false,
    ...extra,
  };
}

beforeEach(() => {
  status = { active: false };
  changes = [];
  calls.length = 0;
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(
    async (command: string, args: { request?: { path?: string } } = {}) => {
      calls.push([command, args]);
      switch (command) {
        case "code_review_status":
          return status;
        case "code_review_start":
          status = ON;
          return status;
        case "code_review_stop":
          status = { active: false };
          return undefined;
        case "code_review_changes":
          return { status, changes, truncated: false };
        case "code_review_keep":
        case "code_review_revert":
          changes = changes.filter((c) => c.path !== args.request?.path);
          return undefined;
        default:
          throw new Error(`unexpected ${command}`);
      }
    },
  );
});

describe("the agent's context", () => {
  it("is added only in Code mode on the chat's folder", async () => {
    expect(await withCodeContext("Fix the bug", "s1", FOLDER)).toBe("Fix the bug");
    status = ON;
    const text = await withCodeContext("Fix the bug", "s1", FOLDER);
    expect(text).toContain(
      "Fix the bug\n\n--- Attached Context ---\n\nCode mode is on for this chat.",
    );
    expect(text).toContain(FOLDER);
    // Another folder, or no chat yet, leaves the message alone.
    expect(await withCodeContext("x", "s1", "/elsewhere")).toBe("x");
    expect(await withCodeContext("x", null, FOLDER)).toBe("x");
    // An existing context block is extended, not repeated.
    const again = await withCodeContext("x\n\n--- Attached Context ---\n\nproject", "s1", FOLDER);
    expect(again.match(/Attached Context/g)).toHaveLength(1);
    mocks.invoke.mockRejectedValueOnce(new Error("gone"));
    expect(await withCodeContext("y", "s1", FOLDER)).toBe("y");
  });

  it("colours diff lines by their mark", () => {
    expect(["+++ b/a", "--- a/a", "@@ -1 +1 @@", "+x", "-y", " z"].map(diffLineKind)).toEqual([
      "header",
      "header",
      "hunk",
      "add",
      "remove",
      "context",
    ]);
  });
});

describe("the session bar", () => {
  it("turns Code mode on for the chat's folder, then offers the review", async () => {
    render(<CodeModeControls sessionId="s1" workingDir={FOLDER} />);
    const code = await screen.findByRole("button", { name: "Code" });
    expect(code.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
    fireEvent.click(code);
    await waitFor(() =>
      expect(calls).toContainEqual([
        "code_review_start",
        { request: { sessionId: "s1", folder: FOLDER } },
      ]),
    );
    expect(await screen.findByRole("button", { name: "Review changes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Code" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("forgets a deleted chat's record", async () => {
    forgetSessionWorkingDir("s9");
    await waitFor(() =>
      expect(calls).toContainEqual(["code_review_stop", { request: { sessionId: "s9" } }]),
    );
  });
});

describe("the review panel", () => {
  it("keeps, and reverts only after a second tap", async () => {
    status = ON;
    changes = [change("src/a.rs"), change("src/b.rs", { status: "added" })];
    render(<CodeReviewPanel sessionId="s1" folder={FOLDER} onClose={() => {}} />);
    expect(await screen.findByText("src/a.rs")).toBeTruthy();
    expect(
      screen.getByText("Compared with the folder as it was when Code mode started, using git."),
    ).toBeTruthy();
    expect(screen.getAllByText("+new")).toHaveLength(2);

    const [keepA] = screen.getAllByRole("button", { name: "Keep" });
    fireEvent.click(keepA);
    await waitFor(() => expect(screen.queryByText("src/a.rs")).toBeNull());
    expect(calls).toContainEqual([
      "code_review_keep",
      { request: { sessionId: "s1", path: "src/a.rs" } },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(calls.some(([command]) => command === "code_review_revert")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Revert this file?" }));
    await waitFor(() =>
      expect(screen.getByText("No changes since Code mode started.")).toBeTruthy(),
    );
    expect(calls).toContainEqual([
      "code_review_revert",
      { request: { sessionId: "s1", path: "src/b.rs" } },
    ]);
  });

  it("cannot revert a file it kept no copy of, and turns the mode off", async () => {
    status = ON;
    changes = [change("big.bin", { binary: true, diff: null, revertible: false })];
    const onClose = vi.fn();
    render(<CodeReviewPanel sessionId="s1" folder={FOLDER} onClose={onClose} />);
    expect(await screen.findByText("Too large to preview or revert.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Revert" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Turn Code mode off" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toContainEqual(["code_review_stop", { request: { sessionId: "s1" } }]);
  });
});
