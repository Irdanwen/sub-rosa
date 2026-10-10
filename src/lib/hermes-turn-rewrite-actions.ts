/**
 * The gateway half of Regenerate, Edit and Branch from here on the desktop
 * chat (ADR-0080; the pure planning is `hermes-turn-rewrite.ts`). Built from
 * the workspace's own seams, passed in, so this module owns the sequence and
 * the workspace keeps owning its state.
 */

import { messageFromError } from "./errors";
import { createHermesMethods } from "./hermes-control-plane";
import type { HermesGatewayClient } from "./hermes-gateway";
import { isModelSwitchMarker } from "./hermes-adapter";
import { parseBranchSessionResult } from "./hermes-session-branch";
import { attachmentStateFrom, type HermesAttachmentState } from "./hermes-image-attach";
import {
  findBranchStoredId,
  messagesAfterUndo,
  planUserTurnEdit,
  type QuestionImage,
  questionImages,
  undoPrefillText,
  undoTurnsFor,
} from "./hermes-turn-rewrite";
import { t } from "./i18n";
import { readableModelName } from "./model-names";
import {
  type HermesSessionInfo,
  type HermesSessionMessage,
  hermesBridgeImageForModel,
  type ImportedHermesFile,
} from "./tauri";

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
  /** Sends `text` as a new user turn of the session, on `model` if given,
   * attaching `images` the way the composer attaches its own. */
  send: (
    storedSessionId: string,
    text: string,
    model?: string,
    images?: QuestionImage[],
  ) => Promise<unknown>;
  /** Whether every picture can still be read from the workspace. Defaults
   * to reading each one the way the attach does. */
  imagesReadable?: (images: QuestionImage[]) => Promise<boolean>;
  /** The catalog model id the session runs on. */
  sessionModel: (storedSessionId: string) => string | undefined;
  /** The model string the runtime is handed for a catalog id (the
   * reasoning-effort alias when one applies). */
  runtimeModel: (modelId: string) => string;
  /** The sessions the list holds now, and a fresh read of them. */
  knownSessionIds: () => ReadonlySet<string>;
  listSessions: () => Promise<HermesSessionInfo[]>;
  /** Puts a message back in the session's composer: a rewind went through
   * but the new send did not, and the text must not be lost with it. */
  restoreDraft: (storedSessionId: string, text: string) => void;
  /** Tells the person something that worked only in part, on that session. */
  notice: (storedSessionId: string, message: string) => void;
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

/** Sends `text` after a rewind. The rewind already removed the message from
 * the transcript, so a failed send puts it back in the composer and says why,
 * instead of letting the question vanish. */
async function sendAfterRewind(
  deps: TurnRewriteDeps,
  sessionId: string,
  text: string,
  model?: string,
  images?: QuestionImage[],
) {
  try {
    await (images?.length
      ? deps.send(sessionId, text, model, images)
      : model
        ? deps.send(sessionId, text, model)
        : deps.send(sessionId, text));
  } catch (error) {
    deps.restoreDraft(sessionId, text);
    throw new TurnRewriteError(
      t("Your message is back in the composer. {reason}", { reason: messageFromError(error) }),
    );
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
  let modelSwitchFailed = false;
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
        // On the profile default the fork still answers, but not on the model
        // the person chose: said below rather than passed over.
        await methods
          .switchActiveSessionModel({ mode: "sandboxed", sessionId: fork.sessionId, model })
          .catch(() => {
            modelSwitchFailed = true;
          });
      }
      return fork.sessionId;
    },
  );
  const storedSessionId = findBranchStoredId(await deps.listSessions(), sourceSessionId, known);
  if (!storedSessionId) {
    throw new TurnRewriteError(t("Hermes did not return a branched session."));
  }
  await deps.openBranch({ storedSessionId, runtimeSessionId, sourceSessionId });
  if (modelSwitchFailed && sourceModel) {
    deps.notice(
      storedSessionId,
      t("This branch could not switch to {model} and answers on your default model.", {
        model: readableModelName(sourceModel),
      }),
    );
  }
  return storedSessionId;
}

/** Each picture can still be read from the workspace, the way the attach
 * will read it: a file deleted since cannot be attached again. */
async function imagesStillReadable(images: QuestionImage[]): Promise<boolean> {
  const read = await Promise.all(
    images.map((image) => hermesBridgeImageForModel(image.path).catch(() => null)),
  );
  return read.every(Boolean);
}

/** Regenerate the last reply: back up the last question and ask it again,
 * with the pictures it carried. */
export async function regenerateLastReply(deps: TurnRewriteDeps, sessionId: string) {
  ensureIdle(deps, sessionId);
  const messages = deps.storedMessages(sessionId);
  // A model-switch note is a user row nobody typed: skip it, and back up
  // through it, or Regenerate would ask the note again.
  const lastQuestion = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "user" &&
        !(typeof message.content === "string" && isModelSwitchMarker(message.content)),
    );
  const stored = typeof lastQuestion?.content === "string" ? lastQuestion.content : "";
  // Checked before the rewind: `/undo` hands back the text alone, so the
  // pictures are found again from it, and must still be there to attach.
  const images = questionImages(stored);
  if (!images) {
    throw new TurnRewriteError(t("A question with images cannot be asked again. Send it anew."));
  }
  if (images.length && !(await (deps.imagesReadable ?? imagesStillReadable)(images))) {
    throw new TurnRewriteError(
      t("The images of this question are no longer in the workspace. Send it anew."),
    );
  }
  // `/undo` answers the earliest user row it removed: the question.
  const back = lastQuestion ? (undoTurnsFor(messages, String(lastQuestion.id), "replace") ?? 1) : 1;
  const text = await undoTurns(deps, sessionId, back);
  const question = text ?? stored;
  if (!question.trim()) throw new TurnRewriteError(t("There is no question to ask again."));
  await sendAfterRewind(deps, sessionId, question, undefined, images);
}

type ResentAttachment = ImportedHermesFile & { id: string; attach: HermesAttachmentState };

/** What the workspace's send is called with for a rewrite: the text, the
 * session as the list holds it (on `model` if given), and the question's
 * pictures as composer attachments, which the send path attaches before the
 * prompt exactly as it attaches the composer's own. */
export function sendArgs(
  sessions: readonly HermesSessionInfo[],
  sessionId: string,
  text: string,
  model?: string,
  images?: QuestionImage[],
): [string, HermesSessionInfo, { attachments: ResentAttachment[] }] {
  const session = {
    ...(sessions.find((entry) => entry.id === sessionId) ?? { id: sessionId }),
    ...(model ? { model } : {}),
  };
  return [text, session, { attachments: resentImageAttachments(images) }];
}

function resentImageAttachments(images: QuestionImage[] | undefined): ResentAttachment[] {
  return (images ?? []).map((image, index) => {
    const file: ImportedHermesFile = {
      name: image.name,
      path: image.path,
      rootLabel: "Workspace",
      size: 0,
    };
    // An image whether or not its name says so: a mention is named by its label.
    const attach: HermesAttachmentState = { ...attachmentStateFrom(file), kind: "image" };
    return { ...file, id: `resend:${index}:${image.path}`, attach };
  });
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
    await sendAfterRewind(deps, sessionId, plan.text);
    return sessionId;
  }
  const branchId = await branchSession(deps, sessionId, plan.undoTurns);
  await sendAfterRewind(deps, branchId, plan.text, deps.sessionModel(sessionId));
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
