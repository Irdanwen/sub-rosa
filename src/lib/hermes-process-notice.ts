/**
 * Recognizes the machine notifications Hermes injects into a session as if the
 * user had typed them.
 *
 * When the agent starts a background process (`terminal(background=true)` with
 * `notify_on_complete` / `watch_patterns` — the flow the soul's long-task note
 * asks for) or dispatches an async subagent, the runtime wakes the agent back
 * up by *submitting the notification as a prompt*: the gateway's notification
 * poller calls the same `prompt.submit` path a typed message uses, so the
 * transcript stores a `user` message reading
 * `[IMPORTANT: Background process proc_… matched watch pattern "…"]`. Nothing
 * in the stored row distinguishes it from something the user wrote, so the
 * chat rendered these as user bubbles and the app looked like it was sending
 * messages on the user's behalf.
 *
 * The shapes below mirror `format_process_notification` in the pinned Hermes
 * runtime (`tools/process_registry.py`), which emits exactly four:
 * a watch-pattern match, a process completion, a "watch patterns disabled"
 * summary, and an async-delegation result. Recognition is anchored on their
 * openers so an ordinary message that merely starts with `[IMPORTANT` is never
 * mistaken for one, and an unparsed variant (a future Hermes wording) still
 * falls back to a generic process notice rather than a user bubble.
 */

export type HermesProcessNoticeKind =
  /** A `watch_patterns` line matched while the process is still running. */
  | "watch-match"
  /** The process ended on its own, successfully. */
  | "finished"
  /** The process exited non-zero, was killed, was lost, or failed to start. */
  | "failed"
  /** Watching was rate-limited off; the runtime falls back to one end notice. */
  | "watch-stopped"
  /** An async subagent the agent dispatched earlier reported back. */
  | "delegation"
  /** A process notification whose wording this parser does not know. */
  | "update";

export type HermesProcessNotice = {
  kind: HermesProcessNoticeKind;
  /** One-line summary for the collapsed row. Sentence case, no trailing dot. */
  label: string;
  /** The notification verbatim (minus the `[IMPORTANT: … ]` wrapper), shown
   * when the row is expanded so the exact text the agent received stays
   * inspectable. */
  detail: string;
};

/** Longest watch pattern echoed into the collapsed label before it's elided. */
const LABEL_PATTERN_LIMIT = 48;

const IMPORTANT_OPENER = /^\[IMPORTANT:\s*/i;
const DELEGATION_OPENER = /^\[ASYNC DELEGATION COMPLETE\b/i;

/** True for any message Hermes injected as a background-process notification. */
export function isHermesProcessNotice(content: string): boolean {
  return parseHermesProcessNotice(content) !== undefined;
}

/** Parses an injected notification, or returns undefined for a real message. */
export function parseHermesProcessNotice(content: string): HermesProcessNotice | undefined {
  const text = content.trim();
  if (!text) return undefined;

  if (DELEGATION_OPENER.test(text)) {
    return {
      kind: "delegation",
      label: delegationLabel(text),
      detail: text,
    };
  }

  if (!IMPORTANT_OPENER.test(text)) return undefined;
  const body = unwrapImportantBlock(text);
  const head = noticeHead(body);

  if (/^Watch patterns disabled for process\b/i.test(head)) {
    return { kind: "watch-stopped", label: "Background process watch stopped", detail: body };
  }

  if (!/^Background process\b/i.test(head)) return undefined;

  const watched = /matched watch pattern\s+"([^"]*)/i.exec(head);
  if (watched) {
    const pattern = truncate(watched[1] ?? "", LABEL_PATTERN_LIMIT);
    return {
      kind: "watch-match",
      label: pattern
        ? `Background process matched "${pattern}"`
        : "Background process matched a watch pattern",
      detail: body,
    };
  }

  const ended = /^Background process\s+\S+\s+(.*?)\s*(?:\(exit code\s*([^)]*)\)|$)/i.exec(head);
  const endNotice = ended ? endedNotice(ended[1] ?? "", ended[2] ?? "") : undefined;
  if (endNotice) return { ...endNotice, detail: body };

  // A wording this parser doesn't know: still a machine notification, so it
  // renders as a process row rather than falling back to a user bubble.
  return { kind: "update", label: "Background process update", detail: body };
}

/** The part of a notification that says what happened, before the command and
 * output blocks. Splits on `Command:` as well as the newline: session previews
 * arrive with their whitespace collapsed onto one line (and truncated), so the
 * first line alone is not a reliable boundary. */
function noticeHead(body: string) {
  return (body.split("\n", 1)[0] ?? "").split(/\s*\bCommand:\s/)[0]?.trim() ?? "";
}

/** Drops the `[IMPORTANT:` opener and the block's closing bracket. Only a
 * trailing `]` is removed — process output routinely contains brackets, so
 * matching from the inside out would truncate the payload. */
function unwrapImportantBlock(text: string) {
  const body = text.replace(IMPORTANT_OPENER, "");
  return (body.endsWith("]") ? body.slice(0, -1) : body).trim();
}

/** Maps Hermes's end-of-process wording onto a kind + label. `status` is the
 * runtime's phrasing ("completed normally", "exited", "terminated by …",
 * "marked lost because …", "failed to start"); `exit` is the raw exit-code
 * text, which may carry a signal ("-15, SIGTERM") or be unknown ("?").
 *
 * Returns undefined for a wording it doesn't know with no exit code to go on —
 * the caller then reports a neutral update. Calling an unrecognized event a
 * failure would be worse than saying nothing about how it ended. */
function endedNotice(
  status: string,
  exit: string,
): Omit<HermesProcessNotice, "detail"> | undefined {
  const wording = status.trim().toLowerCase();
  if (wording.startsWith("completed normally")) {
    return { kind: "finished", label: "Background process finished" };
  }
  if (wording.startsWith("terminated by")) {
    return { kind: "failed", label: "Background process was stopped" };
  }
  if (wording.startsWith("marked lost")) {
    return { kind: "failed", label: "Background process was lost" };
  }
  if (wording.startsWith("failed to start")) {
    return { kind: "failed", label: "Background process failed to start" };
  }
  if (!wording.startsWith("exited") && !exit.trim()) return undefined;
  const code = exit.split(",")[0]?.trim() ?? "";
  // "exited" with a zero code never happens (Hermes words that "completed
  // normally"), but honor the code rather than assume the failure.
  if (code === "0") return { kind: "finished", label: "Background process finished" };
  return {
    kind: "failed",
    label:
      code && code !== "?"
        ? `Background process exited with code ${code}`
        : "Background process exited",
  };
}

/** An async delegation carries a `Status:` line inside its body; a failed
 * subagent reads as a failure rather than a plain completion. */
function delegationLabel(text: string) {
  const status = /^Status:\s*(\S+)/im.exec(text)?.[1]?.toLowerCase() ?? "";
  if (status && status !== "completed" && status !== "success") {
    return `Background subagent ${status === "interrupted" ? "was interrupted" : "did not finish"}`;
  }
  return "Background subagent finished";
}

function truncate(value: string, limit: number) {
  const text = value.trim().replace(/\s+/g, " ");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
