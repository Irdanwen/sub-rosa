// A conversation as a Markdown file: the title, a line saying when and on
// which model, then each turn under its speaker. The app writes its files from
// it (desktop save dialog, phone share sheet) and the web client its
// downloads, so the two read the same. The words are each surface's own copy.

export type ConversationExportTurn = { role: "user" | "assistant"; text: string };

export type ConversationExportDocument = {
  title: string;
  /** When the conversation began. */
  startedAt?: string;
  /** The model it ran on, as a person reads its name. */
  model?: string;
  turns: ConversationExportTurn[];
};

export type ConversationMarkdownCopy = {
  untitled: string;
  /** "Model: {model}" in the surface's language. */
  model: (name: string) => string;
  /** "Exported {date}" in the surface's language. */
  exported: (date: string) => string;
  you: string;
  assistant: string;
  /** A date as the surface writes one, or undefined when it is not a date. */
  formatDate: (value: string | Date) => string | undefined;
};

export function conversationMarkdown(
  doc: ConversationExportDocument,
  copy: ConversationMarkdownCopy,
  exportedAt: Date = new Date(),
): string {
  const title = doc.title.trim() || copy.untitled;
  const details = [
    doc.startedAt ? copy.formatDate(doc.startedAt) : undefined,
    doc.model ? copy.model(doc.model) : undefined,
    copy.exported(copy.formatDate(exportedAt) ?? ""),
  ].filter(Boolean);
  const lines = [`# ${title}`, "", `*${details.join(" · ")}*`];
  for (const turn of doc.turns) {
    const text = turn.text.trim();
    if (!text) continue;
    lines.push("", "---", "", `## ${turn.role === "user" ? copy.you : copy.assistant}`, "", text);
  }
  return `${lines.join("\n")}\n`;
}
