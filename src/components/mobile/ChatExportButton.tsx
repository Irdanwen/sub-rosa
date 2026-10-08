// "Export" in the chat screen's header: the conversation as a Markdown or PDF
// file, handed to the share sheet (Files, Mail, AirDrop). Its own component so
// the chat screen only places it.

import { IconShareOs } from "central-icons/IconShareOs";
import { useState } from "react";
import {
  type ConversationExportFormat,
  exportConversation,
  exportTurnsFromMessages,
} from "../../lib/conversation-export";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { readableModelName } from "../../lib/model-names";
import type { AgentTaskDto } from "../../lib/tauri";
import { ActionSheet } from "./ActionSheet";

export function ChatExportButton({
  task,
  disabled,
  onError,
}: {
  task: Pick<AgentTaskDto, "title" | "createdAt" | "model" | "messages"> | null | undefined;
  disabled?: boolean;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!task || task.messages.length === 0) return null;

  const run = (format: ConversationExportFormat) => {
    void exportConversation(
      {
        title: task.title,
        startedAt: task.createdAt,
        model: task.model ? readableModelName(task.model) : undefined,
        turns: exportTurnsFromMessages(task.messages),
      },
      format,
    ).catch((error: unknown) =>
      onError(
        t("The conversation could not be exported: {reason}", {
          reason: messageFromError(error),
        }),
      ),
    );
  };

  return (
    <>
      <button
        type="button"
        className="mobile-icon-button"
        aria-label={t("Export chat")}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <IconShareOs size={20} />
      </button>
      {open ? (
        <ActionSheet
          title={t("Export chat")}
          subtitle={t("A file with every message, to save or send.")}
          actions={[
            { label: t("Export as Markdown"), onAction: () => run("markdown") },
            { label: t("Export as PDF"), onAction: () => run("pdf") },
          ]}
          onClose={() => setOpen(false)}
          closeLabel={t("Cancel")}
        />
      ) : null}
    </>
  );
}
