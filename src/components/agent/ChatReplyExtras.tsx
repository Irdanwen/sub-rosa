// What the desktop chat adds around a reply and a conversation, kept out of
// AgentWorkspace (which is at its size ceiling): read a reply aloud and rate
// it, export the open chat, and the context gauge beside the composer.

import { IconFileText } from "central-icons/IconFileText";
import { IconFilePdf } from "central-icons/IconFilePdf";
import { useMemo } from "react";
import type { AgentChatTurn } from "../../lib/agent-chat-runtime";
import { readContextGauge } from "../../lib/context-gauge";
import type { ConversationExportFormat } from "../../lib/conversation-export";
import { isBranchableMessageId } from "../../lib/hermes-session-branch";
import { t } from "../../lib/i18n";
import type { HermesSessionMessage, VeniceModelDto } from "../../lib/tauri";
import { ContextGauge } from "../chat/ContextGauge";
import { RateReply } from "../chat/RateReply";
import { ReadAloudButton } from "../chat/ReadAloudButton";

/** A reply's text as written: markdown and chat blocks included, so the voice
 * can name a card instead of reading its contents. */
function replySource(turn: AgentChatTurn): string {
  return turn.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n")
    .trim();
}

/**
 * Read aloud and the thumbs, on a finished reply. The thumbs need a reply the
 * runtime has stored (its id survives a reload) in a known conversation;
 * reading aloud only needs the text.
 */
export function ReplyExtras({ turn, sessionId }: { turn: AgentChatTurn; sessionId?: string }) {
  if (turn.role !== "assistant" || turn.status !== "complete") return null;
  const text = replySource(turn);
  if (!text) return null;
  return (
    <>
      <ReadAloudButton
        speechKey={`${sessionId ?? "task"}:${turn.id}`}
        text={text}
        className="agent-turn-action"
      />
      {sessionId && isBranchableMessageId(turn.id) ? (
        <RateReply conversationId={sessionId} messageId={turn.id} className="agent-turn-action" />
      ) : null}
    </>
  );
}

/** "Export as Markdown" and "Export as PDF" in a chat's actions menu. */
export function ExportChatItems({
  onExport,
  close,
}: {
  onExport?: (format: ConversationExportFormat) => void;
  close: () => void;
}) {
  if (!onExport) return null;
  const pick = (format: ConversationExportFormat) => {
    close();
    onExport(format);
  };
  return (
    <>
      <button type="button" role="menuitem" onClick={() => pick("markdown")}>
        <IconFileText size={14} />
        {t("Export as Markdown")}
      </button>
      <button type="button" role="menuitem" onClick={() => pick("pdf")}>
        <IconFilePdf size={14} />
        {t("Export as PDF")}
      </button>
    </>
  );
}

/** A stored Hermes message's text, whatever shape its content takes. */
export function hermesMessageText(message: HermesSessionMessage): string {
  const content = message.content ?? message.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : part &&
              typeof part === "object" &&
              typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
      )
      .join("\n");
  }
  return "";
}

/**
 * The context gauge on the desktop composer: the open chat's stored messages
 * (tool results included, they fill the window too) against the model's
 * context length. Not drawn before the chat has a message, nor for a model
 * whose window the catalog does not give.
 */
export function DesktopContextGauge({
  model,
  messages,
  onNewChat,
}: {
  model?: Pick<VeniceModelDto, "contextTokens">;
  messages: readonly HermesSessionMessage[];
  onNewChat?: () => void;
}) {
  const reading = useMemo(
    () =>
      readContextGauge({
        messages: messages.map((message) => ({ content: hermesMessageText(message) })),
        contextTokens: model?.contextTokens,
      }),
    [messages, model?.contextTokens],
  );
  if (messages.length === 0) return null;
  return <ContextGauge reading={reading} onNewChat={onNewChat} />;
}
