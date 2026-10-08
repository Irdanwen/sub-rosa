/**
 * A conversation leaving the browser: copied, read aloud, or downloaded as
 * Markdown. The Markdown is the app's (`@subrosa/chat-core`), in the site's
 * words; the PDF is the browser's own print of the page.
 */
import { chatBlockKindOf } from "@subrosa/chat-core/chat-block-fence";
import {
  type ConversationExportDocument,
  conversationMarkdown,
} from "@subrosa/chat-core/conversation-markdown";
import { speakableReply } from "@subrosa/chat-core/speakable-text";
import { splitChatBlocks } from "../lib/chat-blocks";
import { t, websiteLocale } from "../lib/i18n";
import type { Message } from "./library";

function formatDate(value: string | Date): string | undefined {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(websiteLocale(), { dateStyle: "long", timeStyle: "short" }).format(
    date,
  );
}

function field(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A reply as text: prose as written, cards as the lists Copy makes of them
 * in the app (a link as its title and address). */
export function replyText(content: string): string {
  return splitChatBlocks(content)
    .map((part) => {
      if (part.kind === "text") return part.text.trim();
      const payload = part.payload ?? {};
      const items = (["links", "places", "notes", "actions"] as const).flatMap((name) =>
        Array.isArray(payload[name]) ? (payload[name] as Record<string, unknown>[]) : [],
      );
      const lines = items
        .map((item) => {
          const title = field(item.title) || field(item.name) || field(item.label);
          const url = field(item.url);
          return title ? `- ${title}${url ? `: ${url}` : ""}` : "";
        })
        .filter(Boolean);
      const heading = field(payload.title);
      return [heading, ...lines].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

export function exportMarkdown(
  title: string,
  messages: Message[],
  model: string | null,
  exportedAt = new Date(),
): string {
  const doc: ConversationExportDocument = {
    title,
    startedAt: messages[0]?.createdAt,
    model: model ?? undefined,
    turns: messages.map((message) => ({
      role: message.role,
      text: message.role === "assistant" ? replyText(message.content) : message.content,
    })),
  };
  return conversationMarkdown(
    doc,
    {
      untitled: t("Untitled chat", "Discussion sans titre"),
      model: (name) => t(`Model: ${name}`, `Modèle : ${name}`),
      exported: (date) => t(`Exported ${date}`, `Exportée le ${date}`),
      you: t("You", "Vous"),
      assistant: "Sub Rosa",
      formatDate,
    },
    exportedAt,
  );
}

/** Hands the browser a file to save. Nothing is uploaded anywhere. */
export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileName(title: string): string {
  const base = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
  return `${base || "Sub Rosa"}.md`;
}

/** What a card becomes when a reply is read aloud, in the site's words. */
export function fenceLabel(info: string): string {
  switch (chatBlockKindOf(info)) {
    case "links":
      return t("There are links here.", "Il y a des liens ici.");
    case "places":
      return t("There are places here.", "Il y a des lieux ici.");
    case "notes":
      return t("There are notes here.", "Il y a des notes ici.");
    case "chart":
      return t("There is a chart here.", "Il y a un graphique ici.");
    case "table":
      return t("There is a table here.", "Il y a un tableau ici.");
    case null:
      return t("There is some code here.", "Il y a du code ici.");
    default:
      return t("There is a card here.", "Il y a une carte ici.");
  }
}

export function spokenReply(content: string): string {
  return speakableReply(content, fenceLabel);
}
