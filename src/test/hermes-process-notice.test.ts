import { describe, expect, it } from "vitest";
import { isHermesProcessNotice, parseHermesProcessNotice } from "../lib/hermes-process-notice";

// Every fixture below is the literal wording of `format_process_notification`
// in the pinned Hermes runtime (tools/process_registry.py). If an upgrade
// rewords them, these tests are what catches it — the fallback keeps such a
// message out of the user's bubble, but the label goes generic.
//
// WATCH_MATCH is the reported case, copied verbatim from the `messages` row
// Hermes stored (with role `user`) for it.
const WATCH_MATCH = `[IMPORTANT: Background process proc_a8f9b7e429b2 matched watch pattern "Serving HTTP on".
Command: python3 -m http.server 8765 --bind 127.0.0.1
Matched output:
Serving HTTP on 127.0.0.1 port 8765 (http://127.0.0.1:8765/) ...]`;

const COMPLETED = `[IMPORTANT: Background process proc_31c0d4 completed normally (exit code 0).
Command: pnpm build
Output:
built in 12.41s]`;

const EXITED = `[IMPORTANT: Background process proc_9f21ab exited (exit code 1).
Command: cargo test --workspace
Output:
error: test failed]`;

const KILLED = `[IMPORTANT: Background process proc_77b2 terminated by Hermes (exit code -15, SIGTERM).
Command: tail -f server.log
Output:
]`;

describe("parseHermesProcessNotice", () => {
  it("recognizes a watch-pattern match and echoes the pattern", () => {
    const notice = parseHermesProcessNotice(WATCH_MATCH);
    expect(notice?.kind).toBe("watch-match");
    expect(notice?.label).toBe('Background process matched "Serving HTTP on"');
    // The detail keeps the notification verbatim, minus the [IMPORTANT: … ]
    // wrapper — including the command and the matched output.
    expect(notice?.detail).toContain("Command: python3 -m http.server 8765 --bind 127.0.0.1");
    expect(notice?.detail).toContain("Serving HTTP on 127.0.0.1 port 8765");
    expect(notice?.detail.startsWith("[IMPORTANT")).toBe(false);
    expect(notice?.detail.endsWith("]")).toBe(false);
  });

  it("elides a long watch pattern in the collapsed label", () => {
    const pattern = "a".repeat(80);
    const notice = parseHermesProcessNotice(
      `[IMPORTANT: Background process proc_1 matched watch pattern "${pattern}".\nCommand: x\nMatched output:\ny]`,
    );
    // The echoed pattern is capped at 48 characters; the row must not grow
    // with whatever the agent decided to watch for.
    expect(notice?.label).toBe(`Background process matched "${"a".repeat(47)}…"`);
    // The full pattern is still one expand away.
    expect(notice?.detail).toContain(pattern);
  });

  it("separates a clean end from a failure", () => {
    expect(parseHermesProcessNotice(COMPLETED)).toMatchObject({
      kind: "finished",
      label: "Background process finished",
    });
    expect(parseHermesProcessNotice(EXITED)).toMatchObject({
      kind: "failed",
      label: "Background process exited with code 1",
    });
    // A signal exit reads as "stopped", not as an exit code the user should
    // debug: Hermes (or the app) killed it.
    expect(parseHermesProcessNotice(KILLED)).toMatchObject({
      kind: "failed",
      label: "Background process was stopped",
    });
  });

  it("recognizes the lost, failed-to-start and unknown-code endings", () => {
    expect(
      parseHermesProcessNotice(
        "[IMPORTANT: Background process proc_2 marked lost because the process backend disappeared (exit code ?).\nCommand: x\nOutput:\n]",
      ),
    ).toMatchObject({ kind: "failed", label: "Background process was lost" });
    expect(
      parseHermesProcessNotice(
        "[IMPORTANT: Background process proc_3 failed to start (exit code ?).\nCommand: x\nOutput:\n]",
      ),
    ).toMatchObject({ kind: "failed", label: "Background process failed to start" });
    expect(
      parseHermesProcessNotice(
        "[IMPORTANT: Background process proc_4 exited (exit code ?).\nCommand: x\nOutput:\n]",
      ),
    ).toMatchObject({ kind: "failed", label: "Background process exited" });
  });

  it("recognizes the watch-disabled summary", () => {
    const notice = parseHermesProcessNotice(
      "[IMPORTANT: Watch patterns disabled for process proc_5 — 3 consecutive rate-limit windows triggered (min spacing 30s). Falling back to a completion notification.]",
    );
    expect(notice?.kind).toBe("watch-stopped");
    expect(notice?.label).toBe("Background process watch stopped");
  });

  it("recognizes an async delegation result and its status", () => {
    const completed = parseHermesProcessNotice(
      "[ASYNC DELEGATION COMPLETE — deleg_7]\nA background subagent you dispatched earlier has finished.\nOriginal goal: audit the CSS\nRole: leaf   Model: gpt\nStatus: completed   API calls: 4   Duration: 31s\n--- RESULT ---\nDone.",
    );
    expect(completed).toMatchObject({ kind: "delegation", label: "Background subagent finished" });

    const interrupted = parseHermesProcessNotice(
      "[ASYNC DELEGATION COMPLETE — deleg_8]\nStatus: interrupted   API calls: 1   Duration: 2s\n--- RESULT ---\nThe subagent was interrupted before completing.",
    );
    expect(interrupted?.label).toBe("Background subagent was interrupted");
  });

  it("still recognizes a notification flattened and truncated into a preview", () => {
    // Hermes builds a session preview by collapsing whitespace and cutting at
    // 160 characters, so the wrapper's closing bracket, the newlines, and the
    // tail of the pattern are all gone by the time a list surface sees it.
    const preview =
      '[IMPORTANT: Background process proc_a8f9b7e429b2 matched watch pattern "Serving HTTP on". Command: python3 -m http.server 8765 --bind 127.0.0.1 Matched outp';
    expect(parseHermesProcessNotice(preview)).toMatchObject({
      kind: "watch-match",
      label: 'Background process matched "Serving HTTP on"',
    });

    expect(
      parseHermesProcessNotice(
        "[IMPORTANT: Background process proc_31c0d4 completed normally (exit code 0). Command: pnpm build Output: vite v5",
      ),
    ).toMatchObject({ kind: "finished", label: "Background process finished" });

    // Cut mid-pattern: the label degrades to what survived, never to a bubble.
    expect(
      parseHermesProcessNotice(
        '[IMPORTANT: Background process proc_1 matched watch pattern "Serving HT',
      ),
    ).toMatchObject({ kind: "watch-match", label: 'Background process matched "Serving HT"' });

    // Cut before the exit code: the wording alone still classifies it.
    expect(
      parseHermesProcessNotice("[IMPORTANT: Background process proc_2 terminated by Hermes (exit"),
    ).toMatchObject({ kind: "failed", label: "Background process was stopped" });
  });

  it("falls back to a generic process row for an unknown wording", () => {
    // A future Hermes rewording must still stay out of the user's bubble.
    const notice = parseHermesProcessNotice(
      "[IMPORTANT: Background process proc_6 did something entirely new.\nCommand: x]",
    );
    expect(notice).toMatchObject({ kind: "update", label: "Background process update" });
  });

  it("leaves messages the user actually wrote alone", () => {
    expect(parseHermesProcessNotice("Run the build in the background please")).toBeUndefined();
    // Merely opening with [IMPORTANT is not enough — the cron preamble and any
    // user emphasis must keep rendering as what they are.
    expect(parseHermesProcessNotice("[IMPORTANT] read this carefully")).toBeUndefined();
    expect(
      parseHermesProcessNotice(
        "[IMPORTANT: You are running as a scheduled cron job.]\n\nSummarize the day.",
      ),
    ).toBeUndefined();
    // A user quoting a notification mid-message is not a notification.
    expect(
      parseHermesProcessNotice(
        "why did you send [IMPORTANT: Background process proc_1 exited (exit code 1).]?",
      ),
    ).toBeUndefined();
    expect(parseHermesProcessNotice("")).toBeUndefined();
    expect(isHermesProcessNotice(WATCH_MATCH)).toBe(true);
    expect(isHermesProcessNotice("Hello")).toBe(false);
  });
});
