/**
 * The two ways a session's runtime can be gone, and the sentences a person
 * reads instead of the gateway's wire text. Shared by every surface that drives
 * a Hermes session through the `use-*` hooks next to this file.
 */
import { t } from "../i18n";

/** The gateway's answer when the runtime process that held a session is gone
 * (reaped between turns, Hermes restarted, the machine slept). */
export function isSessionGoneError(message: string): boolean {
  return message.toLowerCase().includes("session not found");
}

// A pending request (approval/sudo/secret/clarify) can only be answered by the
// runtime process that asked for it. When that runtime ends, the session's data
// still loads, but the gateway answers "Session not found" on respond — the
// request is now permanently unanswerable. Every respond handler treats this as
// terminal: it retires the dead-end card and shows SESSION_GONE_MESSAGE rather
// than leaking the raw "Hermes API returned 404 ... Session not found" error.
export function sessionGoneMessage() {
  return t("This session has ended, so the request can no longer be answered.");
}

// A send whose session cannot be resumed on either runtime. Distinct from
// SESSION_GONE_MESSAGE (an unanswerable pending request): here the conversation
// itself has no live runtime left, and the raw wire text ("Hermes API returned
// 404 … Session not found") told the user nothing about what to do next.
export function sessionRuntimeGoneMessage() {
  return t(
    "Sub Rosa could not reopen this conversation, so the message was not sent. Start a new session to continue.",
  );
}
