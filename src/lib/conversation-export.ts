// A conversation as a Markdown or PDF file (desktop save dialog, phone share
// sheet). The Markdown is written here, from what the person reads: on the
// desktop that is the Hermes session's stored transcript as the chat renders
// it (the most complete copy: the `agent_messages` mirror only holds the
// replies of agent tasks), on the phone the chat's own messages. The shell
// turns it into the file (`src-tauri/src/conversation_export/`), drawing the
// PDF from the same Markdown.
//
// Chat cards (`subrosa:*` blocks) are written as the readable lists Copy
// already makes of them; tool calls, thinking and process notices are left
// out, as they are when a reply is copied.

import { invoke } from "@tauri-apps/api/core";
import { stripAgentCliAccessRequest } from "./agent-cli-access";
import {
  type AgentChatTurn,
  displayedComposerUserMessageText,
  isProcessNoticeTurn,
} from "./agent-chat-runtime";
import { PRODUCT_NAME } from "./branding";
import { chatBlocksToClipboardText } from "./chat-blocks";
import { messageFromError } from "./errors";
import { intlLocale, t } from "./i18n";
import { readableModelName } from "./model-names";
import type { AgentMessageDto } from "./tauri";

export type ConversationExportFormat = "markdown" | "pdf";

export type ConversationExportTurn = { role: "user" | "assistant"; text: string };

export type ConversationExportDocument = {
  title: string;
  /** When the conversation began. */
  startedAt?: string;
  /** The model it ran on, as a person reads its name. */
  model?: string;
  turns: ConversationExportTurn[];
};

export type ConversationExportResult = {
  path: string | null;
  bytes: number;
  shared: boolean;
};

function formatDate(value: string | Date): string | undefined {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(intlLocale(), { dateStyle: "long", timeStyle: "short" }).format(
    date,
  );
}

/** The whole conversation as Markdown: the title, a line saying when and on
 * which model, then each turn under its speaker. */
export function conversationMarkdown(
  doc: ConversationExportDocument,
  exportedAt: Date = new Date(),
): string {
  const title = doc.title.trim() || t("Untitled chat");
  const details = [
    doc.startedAt ? formatDate(doc.startedAt) : undefined,
    doc.model ? t("Model: {model}", { model: doc.model }) : undefined,
    t("Exported {date}", { date: formatDate(exportedAt) ?? "" }),
  ].filter(Boolean);
  const lines = [`# ${title}`, "", `*${details.join(" · ")}*`];
  for (const turn of doc.turns) {
    const text = turn.text.trim();
    if (!text) continue;
    lines.push("", "---", "", `## ${turn.role === "user" ? t("You") : PRODUCT_NAME}`, "", text);
  }
  return `${lines.join("\n")}\n`;
}

/** A reply's text as it reads in a file: cards as lists. */
function replyText(text: string): string {
  return chatBlocksToClipboardText(stripAgentCliAccessRequest(text)).trim();
}

/** The desktop transcript's turns as the person reads them: what they typed
 * (without the attachment scaffolding the send path adds) and what the
 * replies said. Thinking, tools, notices and process rows stay out. */
export function exportTurnsFromChatTurns(
  turns: readonly AgentChatTurn[],
): ConversationExportTurn[] {
  const out: ConversationExportTurn[] = [];
  for (const turn of turns) {
    if (turn.role !== "user" && turn.role !== "assistant") continue;
    if (isProcessNoticeTurn(turn)) continue;
    const text = turn.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .map((part) =>
        turn.role === "user" ? displayedComposerUserMessageText(part) : replyText(part),
      )
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n");
    if (text) out.push({ role: turn.role, text });
  }
  return out;
}

/** The phone chat's stored messages as export turns. */
export function exportTurnsFromMessages(
  messages: readonly Pick<AgentMessageDto, "role" | "content">[],
): ConversationExportTurn[] {
  return messages.flatMap((message): ConversationExportTurn[] => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = message.role === "assistant" ? replyText(message.content) : message.content.trim();
    return text ? [{ role: message.role, text }] : [];
  });
}

/** Writes the file: the desktop asks where, the phone opens the share sheet. */
export function exportConversation(
  doc: ConversationExportDocument,
  format: ConversationExportFormat,
): Promise<ConversationExportResult> {
  return invoke<ConversationExportResult>("export_conversation", {
    request: {
      title: doc.title.trim() || t("Untitled chat"),
      markdown: conversationMarkdown(doc),
      format,
    },
  });
}

/** Exports an open desktop chat, reporting a failure through `onError`. */
export async function exportHermesChat(
  format: ConversationExportFormat,
  session: { title?: string | null; model?: string | null; started_at?: unknown },
  turns: readonly AgentChatTurn[],
  onError: (message: string) => void,
) {
  const model = session.model?.trim();
  try {
    await exportConversation(
      {
        title: session.title ?? "",
        startedAt:
          typeof session.started_at === "string" || typeof session.started_at === "number"
            ? new Date(
                typeof session.started_at === "number" && session.started_at < 1e12
                  ? session.started_at * 1000
                  : session.started_at,
              ).toISOString()
            : undefined,
        model: model ? readableModelName(model) : undefined,
        turns: exportTurnsFromChatTurns(turns),
      },
      format,
    );
  } catch (error) {
    onError(
      t("The conversation could not be exported: {reason}", { reason: messageFromError(error) }),
    );
  }
}
