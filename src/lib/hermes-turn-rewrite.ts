/**
 * Regenerate a reply, edit a sent message, branch from a message: the pure
 * half of the three desktop chat actions that rewrite a Hermes transcript
 * (ADR-0080). The other half, which talks to the gateway, is
 * `components/agent/useTurnRewrites.ts`.
 *
 * All three stand on two primitives the pinned runtime really has, verified
 * against a live gateway rather than read off its docs:
 * - `/undo N` (command.dispatch name/arg) backs up N USER turns: it
 *   soft-deletes those rows and everything after them on disk, reloads the
 *   session's history, and answers the text of the earliest user message it
 *   removed. `/retry` only trims the in-memory history, so the stored
 *   transcript would keep the old reply and show the question twice.
 * - `session.branch` copies the session's whole history into a new session.
 *   It must be given the RUNTIME id, and it ignores `from_message_id`; the new
 *   session's stored id is not in its answer, only its parent's.
 * So "from here" is always: branch, then `/undo` on the branch.
 */

import { isBranchableMessageId } from "./hermes-session-branch";
import type { AgentChatTurn } from "./agent-chat-runtime";
import type { HermesSessionInfo, HermesSessionMessage } from "./tauri";

function userRowsIn(messages: readonly HermesSessionMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

function indexOfMessage(messages: readonly HermesSessionMessage[], messageId: string): number {
  return messages.findIndex((message) => String(message.id) === messageId);
}

/** How many user turns `/undo` must back up so the transcript ends just
 * BEFORE `messageId` (to replace it), or just AFTER its exchange (`keep`, to
 * branch from it). `undefined` when the message is not in the stored copy. */
export function undoTurnsFor(
  messages: readonly HermesSessionMessage[],
  messageId: string,
  mode: "replace" | "keep",
): number | undefined {
  const index = indexOfMessage(messages, messageId);
  if (index < 0) return undefined;
  return userRowsIn(messages.slice(mode === "replace" ? index : index + 1));
}

/** The stored transcript as it stands once `/undo` has backed up `turns` user
 * turns: everything before the earliest user row it removed. Applied locally
 * right away so the old exchange does not linger under the new one. */
export function messagesAfterUndo(
  messages: readonly HermesSessionMessage[],
  turns: number,
): HermesSessionMessage[] {
  if (turns <= 0) return [...messages];
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    seen += 1;
    if (seen === turns) return messages.slice(0, index);
  }
  return [];
}

export type UserTurnEdit =
  /** The last user message: rewind it in place, then send the new text. */
  | { kind: "in-place"; text: string }
  /** An earlier one: fork, rewind the fork to just before it, send there. */
  | { kind: "branch"; text: string; undoTurns: number };

/** What editing `messageId` to `text` takes. `undefined` when there is
 * nothing to do: an empty or unchanged text, or a message the stored copy
 * does not hold (still sending, or a client-side turn). */
export function planUserTurnEdit(
  messages: readonly HermesSessionMessage[],
  messageId: string,
  text: string,
  originalText: string,
): UserTurnEdit | undefined {
  const next = text.trim();
  if (!next || next === originalText.trim()) return undefined;
  if (!isBranchableMessageId(messageId)) return undefined;
  const message = messages[indexOfMessage(messages, messageId)];
  if (message?.role !== "user") return undefined;
  const undoTurns = undoTurnsFor(messages, messageId, "replace") ?? 0;
  return undoTurns === 1
    ? { kind: "in-place", text: next }
    : { kind: "branch", text: next, undoTurns };
}

/** The turn that carries the Regenerate action: the last turn of the
 * transcript, when it is a finished assistant reply stored by the runtime and
 * a question precedes it. A failed or interrupted turn already offers Retry. */
export function regenerableTurnId(turns: readonly AgentChatTurn[]): string | undefined {
  const last = turns.at(-1);
  if (last?.role !== "assistant" || last.status !== "complete") return undefined;
  if (!isBranchableMessageId(last.id)) return undefined;
  if (last.parts.some((part) => part.type === "notice")) return undefined;
  return turns.some((turn) => turn.role === "user") ? last.id : undefined;
}

/** The text `/undo` hands back (`{type: "prefill", message}`), if any. */
export function undoPrefillText(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const message = (raw as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

/** The stored id of the fork `session.branch` just made: the newest child of
 * `parentId` the list did not hold before. The gateway answers only the
 * fork's runtime id and its parent's stored id. */
export function findBranchStoredId(
  sessions: readonly HermesSessionInfo[],
  parentId: string,
  knownIds: ReadonlySet<string>,
): string | undefined {
  const parentOf = (session: HermesSessionInfo) =>
    session.parent_session_id ?? session.parentSessionId ?? undefined;
  const started = (session: HermesSessionInfo) =>
    session.started_at ?? session.startedAt ?? session.last_active ?? "";
  return sessions
    .filter((session) => parentOf(session) === parentId && !knownIds.has(session.id))
    .sort((a, b) => String(started(b)).localeCompare(String(started(a))))[0]?.id;
}

const ATTACHED_IMAGE_LINE = /^- .+\.(?:png|jpe?g|gif|webp|tiff?|heic|bmp)\b/im;
/** The images the send path hands the model as pixels (`isImageImport`):
 * any other picture only ever rode along as a path in the text. */
const ATTACHABLE_IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|tiff?)$/i;

function attachedBlock(text: string): string | undefined {
  return /Attached files copied into the .+ workspace:\n([\s\S]*?)\n+Use these file paths/i.exec(
    text,
  )?.[1];
}

/** Whether a sent question carried pictures: an attached image in the block
 * the send path appends, an image mention, or the notice Hermes writes when
 * it could not look at one. */
export function questionCarriesImages(text: string): boolean {
  const attached = attachedBlock(text);
  if (attached && ATTACHED_IMAGE_LINE.test(attached)) return true;
  if (/^- Image ".*": attached to this message/m.test(text)) return true;
  return /attached an image/i.test(text);
}

/** A picture a question carried, found again from its text. */
export type QuestionImage = { name: string; path: string };

/**
 * The pictures to attach again when a question is asked again. `/undo` hands
 * back the text only, but the text names every picture the send path
 * attached: the attachment block lists each upload by its path in the
 * workspace (`- name (root): path`), and an image mention by its absolute
 * path. The files stay in the workspace, so Regenerate can attach them again.
 *
 * `undefined` when the question carried a picture its text does not name
 * (only the notice Hermes writes when it could not look at one): that one
 * cannot be sent again.
 */
export function questionImages(text: string): QuestionImage[] | undefined {
  const images: QuestionImage[] = [];
  for (const line of (attachedBlock(text) ?? "").split("\n")) {
    const entry = /^- (.+?) \([^()]*\): (.+?)(?: \(its text, extracted: .*\))?$/.exec(line.trim());
    if (entry && ATTACHABLE_IMAGE_PATH.test(entry[2])) {
      images.push({ name: entry[1], path: entry[2] });
    }
  }
  for (const match of text.matchAll(
    /^- Image "(.*)": attached to this message.*? Saved at `([^`]+)`\.?$/gm,
  )) {
    images.push({ name: match[1], path: match[2] });
  }
  if (images.length) return images;
  // An image in the block that was never attached (a HEIC rides as a path)
  // is resent exactly as it went: as text.
  const attached = attachedBlock(text);
  if (attached && ATTACHED_IMAGE_LINE.test(attached)) return [];
  return questionCarriesImages(text) ? undefined : [];
}

/** The turns that carry Regenerate and Edit, and what the rows need to know
 * about them. */
export type RewriteTargets = {
  regenerable?: string;
  lastUser?: string;
  /** The question Regenerate would ask again carried a picture its text does
   * not name, which a rewind cannot resend: Regenerate is offered disabled,
   * with the reason. */
  regenerateBlocked?: boolean;
  /** The open chat's stored session id, the conversation a rating belongs
   * to. */
  sessionId?: string;
};

export function rewriteTargetsFor(
  turns: readonly AgentChatTurn[],
  sessionId?: string,
  /** The stored transcript: the question as sent, before the display strips
   * what Hermes wrote into it (the notice about a picture it could not see). */
  messages: readonly HermesSessionMessage[] = [],
): RewriteTargets {
  const lastUserTurn = [...turns].reverse().find((turn) => turn.role === "user");
  const regenerable = regenerableTurnId(turns);
  const stored = lastUserTurn
    ? messages.find((message) => String(message.id) === lastUserTurn.id)?.content
    : undefined;
  const question =
    typeof stored === "string"
      ? stored
      : lastUserTurn?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  return {
    regenerable,
    lastUser: lastUserTurn?.id,
    regenerateBlocked: Boolean(regenerable && question && questionImages(question) === undefined),
    sessionId,
  };
}
