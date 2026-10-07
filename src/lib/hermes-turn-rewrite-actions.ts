/**
 * The gateway half of Regenerate, Edit and Branch from here on the desktop
 * chat (ADR-0080; the pure planning is `hermes-turn-rewrite.ts`). Built from
 * the workspace's own seams, passed in, so this module owns the sequence and
 * the workspace keeps owning its state.
 */

import { createHermesMethods } from "./hermes-control-plane";
import type { HermesGatewayClient } from "./hermes-gateway";
import { parseBranchSessionResult } from "./hermes-session-branch";
import {
  findBranchStoredId,
  messagesAfterUndo,
  planUserTurnEdit,
  undoPrefillText,
  undoTurnsFor,
} from "./hermes-turn-rewrite";
import { t } from "./i18n";
import type { HermesSessionInfo, HermesSessionMessage } from "./tauri";

export type TurnRewriteDeps = {
  /** Runs `call` on the session's live runtime (resuming it if needed). */
  withLiveSession: <T>(
    storedSessionId: string,
    call: (gateway: HermesGatewayClient, runtimeSessionId: string) => Promise<T>,
  ) => Promise<T>;
  /** Whether a turn is in flight or waiting on the person. */
  isBusy: (storedSessionId: string) => boolean;
  /** The session's stored transcript as the workspace holds it. */
  storedMessages: (storedSessionId: string) => HermesSessionMessage[];
  /** Replaces the workspace's copy of the stored transcript. */
  replaceStoredMessages: (storedSessionId: string, messages: HermesSessionMessage[]) => void;
  /** Sends `text` as a new user turn of the session, on `model` if given. */
  send: (storedSessionId: string, text: string, model?: string) => Promise<unknown>;
  /** The catalog model id the session runs on. */
  sessionModel: (storedSessionId: string) => string | undefined;
  /** The model string the runtime is handed for a catalog id (the
   * reasoning-effort alias when one applies). */
  runtimeModel: (modelId: string) => string;
  /** The sessions the list holds now, and a fresh read of them. */
  knownSessionIds: () => ReadonlySet<string>;
  listSessions: () => Promise<HermesSessionInfo[]>;
  /** Records and opens a fork the runtime made. */
  openBranch: (branch: {
    storedSessionId: string;
    runtimeSessionId: string;
    sourceSessionId: string;
  }) => Promise<void>;
};

export class TurnRewriteError extends Error {}

function ensureIdle(deps: TurnRewriteDeps, sessionId: string) {
  if (deps.isBusy(sessionId)) {
    throw new TurnRewriteError(t("Wait for the current reply to finish, then try again."));
  }
}

/** Rewinds the session by `turns` user turns and mirrors it locally. Returns
 * the text of the earliest user message the runtime removed. */
async function undoTurns(deps: TurnRewriteDeps, sessionId: string, turns: number) {
  const before = deps.storedMessages(sessionId);
  const raw = await deps.withLiveSession(sessionId, (gateway, runtimeSessionId) =>
    createHermesMethods(gateway).dispatchUndoCommand({ sessionId: runtimeSessionId, turns }),
  );
  deps.replaceStoredMessages(sessionId, messagesAfterUndo(before, turns));
  return undoPrefillText(raw);
}

/** Forks the session and rewinds the fork by `undoTurns` user turns, then
 * opens it. Returns the fork's stored id. */
async function branchSession(deps: TurnRewriteDeps, sourceSessionId: string, undoCount: number) {
  const known = deps.knownSessionIds();
  const sourceModel = deps.sessionModel(sourceSessionId);
  // A fork starts on the profile default, not on its source's model.
  const model = sourceModel ? deps.runtimeModel(sourceModel) : undefined;
  const runtimeSessionId = await deps.withLiveSession(
    sourceSessionId,
    async (gateway, sourceRuntimeId) => {
      const methods = createHermesMethods(gateway);
      const fork = parseBranchSessionResult(
        await methods.branchSession({ sessionId: sourceRuntimeId }),
        { sourceSessionId: sourceRuntimeId },
      );
      if (!fork) throw new TurnRewriteError(t("Hermes did not return a branched session."));
      if (undoCount > 0) {
        await methods.dispatchUndoCommand({ sessionId: fork.sessionId, turns: undoCount });
      }
      if (model) {
        // Best effort: on the profile default the fork still answers.
        await methods
          .switchActiveSessionModel({ mode: "sandboxed", sessionId: fork.sessionId, model })
          .catch(() => undefined);
      }
      return fork.sessionId;
    },
  );
  const storedSessionId = findBranchStoredId(await deps.listSessions(), sourceSessionId, known);
  if (!storedSessionId) {
    throw new TurnRewriteError(t("Hermes did not return a branched session."));
  }
  await deps.openBranch({ storedSessionId, runtimeSessionId, sourceSessionId });
  return storedSessionId;
}

/** Regenerate the last reply: back up the last question and ask it again. */
export async function regenerateLastReply(deps: TurnRewriteDeps, sessionId: string) {
  ensureIdle(deps, sessionId);
  const messages = deps.storedMessages(sessionId);
  const lastQuestion = [...messages].reverse().find((message) => message.role === "user");
  const text = await undoTurns(deps, sessionId, 1);
  const question = text ?? (typeof lastQuestion?.content === "string" ? lastQuestion.content : "");
  if (!question.trim()) throw new TurnRewriteError(t("There is no question to ask again."));
  await deps.send(sessionId, question);
}

/** Edit a sent message: the last one is replaced in place, an earlier one in a
 * fork so the original conversation stays as it was. Returns the session the
 * edited message was sent in, or `undefined` when there was nothing to do. */
export async function editSentMessage(
  deps: TurnRewriteDeps,
  sessionId: string,
  messageId: string,
  text: string,
  originalText: string,
): Promise<string | undefined> {
  const plan = planUserTurnEdit(deps.storedMessages(sessionId), messageId, text, originalText);
  if (!plan) return undefined;
  ensureIdle(deps, sessionId);
  if (plan.kind === "in-place") {
    await undoTurns(deps, sessionId, 1);
    await deps.send(sessionId, plan.text);
    return sessionId;
  }
  const branchId = await branchSession(deps, sessionId, plan.undoTurns);
  await deps.send(branchId, plan.text, deps.sessionModel(sessionId));
  return branchId;
}

/** Branch from a message: a fork that ends with that message's exchange. */
export async function branchFromMessage(
  deps: TurnRewriteDeps,
  sessionId: string,
  messageId: string,
) {
  ensureIdle(deps, sessionId);
  const undoCount = undoTurnsFor(deps.storedMessages(sessionId), messageId, "keep") ?? 0;
  return branchSession(deps, sessionId, undoCount);
}
