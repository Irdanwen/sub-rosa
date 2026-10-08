// The pieces of a chat thread that the Chat tab and an assistant's chat share,
// so a reply reads, types out, copies and reports its progress the same way
// in both.

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ReplyLibraryActions } from "../chat/LibraryActions";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconBranchSimple } from "central-icons/IconBranchSimple";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconClipboard } from "central-icons/IconClipboard";
import { IconPencil } from "central-icons/IconPencil";
import { useCallback, useEffect, useRef, useState } from "react";
import { chatBlocksToClipboardText } from "../../lib/chat-blocks";
import { hapticImpact, hapticSelection } from "../../lib/haptics";
import { t } from "../../lib/i18n";
import { SimpleMarkdown } from "../../lib/simple-markdown";
import type { AgentLiteAttachment, AgentLiteStatusDto } from "../../lib/tauri";
import { RateReply } from "../chat/RateReply";
import { ReadAloudButton } from "../chat/ReadAloudButton";
import { Spinner } from "../ui/Spinner";

/** Whether a stored message names attachments. Only the names are kept: the
 * payloads ride with the turn that sent them. */
export function hasAttachmentMarkers(content: string): boolean {
  return content.includes("[Image: ") || content.includes("[File: ");
}

/** What a stored message says about its attachments, one readable marker each. */
export function withAttachmentMarkers(content: string, attachments: AgentLiteAttachment[]): string {
  const markers = attachments
    .map((entry) => `[${entry.kind === "image" ? "Image" : "File"}: ${entry.name}]`)
    .join(" ");
  return [content, markers].filter(Boolean).join("\n") || markers;
}

/** A turn whose attachments were lost with the process cannot be re-run. */
export function interruptedAttachmentMessage(): string {
  return t("This message was interrupted. Attach your files again and send a new message.");
}

/** The run's stages as a short activity log (thinking, then searching notes,
 * then the web) rather than a single flickering line. */
export function ChatSteps({
  steps,
  fallback,
}: {
  steps: AgentLiteStatusDto[];
  /** The line shown before the first stage arrives. */
  fallback: string;
}) {
  return (
    <div className="mobile-chat-bubble mobile-chat-status" data-role="assistant">
      <ul className="mobile-chat-steps">
        {steps.map((step, i) => {
          const active = i === steps.length - 1;
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: an append-only log, where an entry never moves.
              key={`${step.stage}-${i}`}
              className="mobile-chat-step"
              data-active={active ? "true" : undefined}
            >
              <span className="mobile-chat-step-icon" aria-hidden>
                {active ? <Spinner aria-hidden /> : <IconCheckmark1Small size={12} />}
              </span>
              <span className="mobile-chat-step-label" data-shimmer={active ? "true" : undefined}>
                {stageText(step.stage)}
                {step.detail ? ` · ${step.detail}` : ""}
              </span>
            </li>
          );
        })}
        {steps.length === 0 ? (
          <li className="mobile-chat-step" data-active="true">
            <span className="mobile-chat-step-icon" aria-hidden>
              <Spinner aria-hidden />
            </span>
            <span className="mobile-chat-step-label" data-shimmer="true">
              {fallback}
            </span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export function stageText(stage: AgentLiteStatusDto["stage"]): string {
  const labels: Record<string, string> = {
    "searching-notes": t("Searching your notes"),
    "searching-web": t("Searching the web"),
    "searching-memory": t("Recalling your memories"),
    "searching-places": t("Finding places"),
    "searching-calendar": t("Checking your calendar"),
    "reading-note": t("Reading a note"),
    "writing-note": t("Writing to your notes"),
    remembering: t("Remembering that"),
    "reading-page": t("Reading a page"),
  };
  return labels[stage] ?? t("Thinking");
}

/** Copies a finished reply to the clipboard, with a brief confirmation. */
export function CopyReplyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      // Chat blocks paste as readable link lists, not JSON fences.
      await writeText(chatBlocksToClipboardText(text));
      hapticImpact("light");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Copy is a convenience; a transient clipboard failure is not worth a toast.
    }
  }, [text]);
  return (
    <button
      type="button"
      className="mobile-chat-copy"
      onClick={() => void copy()}
      aria-label={t("Copy reply")}
    >
      {copied ? <IconCheckmark1Small size={13} /> : <IconClipboard size={13} />}
      {copied ? t("Copied") : t("Copy")}
    </button>
  );
}

/** What a finished reply offers: copy it, read it aloud, rate it (a stored
 * reply in a saved chat), ask for it again (the last reply only) and branch
 * the chat from it into a new one. */
export function ReplyActions({
  text,
  conversationId,
  messageId,
  onRegenerate,
  onBranch,
}: {
  text: string;
  /** The chat and the reply, for reading aloud and rating. */
  conversationId?: string;
  messageId?: string;
  onRegenerate?: () => void;
  onBranch?: () => void;
}) {
  return (
    <div className="mobile-chat-actions">
      <CopyReplyButton text={text} />
      <ReplyLibraryActions
        text={text}
        conversationId={conversationId}
        messageId={messageId}
        className="mobile-chat-copy"
        onPress={hapticSelection}
      />
      {messageId ? (
        <ReadAloudButton
          speechKey={`${conversationId ?? "chat"}:${messageId}`}
          text={text}
          className="mobile-chat-copy"
          onPress={hapticSelection}
        />
      ) : null}
      {conversationId && messageId ? (
        <RateReply
          conversationId={conversationId}
          messageId={messageId}
          className="mobile-chat-copy"
          onPress={hapticSelection}
        />
      ) : null}
      {onRegenerate ? (
        <button
          type="button"
          className="mobile-chat-copy"
          aria-label={t("Regenerate reply")}
          onClick={() => {
            hapticSelection();
            onRegenerate();
          }}
        >
          <IconArrowRotateClockwise size={13} />
          {t("Regenerate")}
        </button>
      ) : null}
      {onBranch ? (
        <button
          type="button"
          className="mobile-chat-copy"
          aria-label={t("Branch from here")}
          onClick={() => {
            hapticSelection();
            onBranch();
          }}
        >
          <IconBranchSimple size={13} />
          {t("Branch")}
        </button>
      ) : null}
    </div>
  );
}

/** Under a question the user sent: edit it. */
export function QuestionActions({ onEdit }: { onEdit: () => void }) {
  return (
    <div className="mobile-chat-actions" data-role="user">
      <button
        type="button"
        className="mobile-chat-copy"
        aria-label={t("Edit message")}
        onClick={() => {
          hapticSelection();
          onEdit();
        }}
      >
        <IconPencil size={13} />
        {t("Edit")}
      </button>
    </div>
  );
}

/** Progressive reveal of a fresh reply — the backend is not streaming, so the
 * finished text plays back at reading speed instead of appearing as a wall.
 * The "reply is ready" buzz fires once on arrival (the done listener); while
 * the text types out, a sparse selection tick (~every 190 ms, never per frame)
 * makes the phone purr along without the Taptic Engine coalescing it into
 * mush or swallowing that arrival buzz. */
export function TypewriterMarkdown({
  text,
  onTick,
  onDone,
}: {
  text: string;
  onTick?: () => void;
  onDone?: () => void;
}) {
  const [visible, setVisible] = useState(0);
  const onTickRef = useRef(onTick);
  const onDoneRef = useRef(onDone);
  onTickRef.current = onTick;
  onDoneRef.current = onDone;

  useEffect(() => {
    let index = 0;
    let frame = 0;
    // ~3 seconds for a long answer, faster for short ones.
    const step = Math.max(3, Math.ceil(text.length / 130));
    const interval = window.setInterval(() => {
      index = Math.min(text.length, index + step);
      frame += 1;
      // Every 8th frame at 24 ms/frame keeps ticks ~190 ms apart.
      if (frame % 8 === 0 && index < text.length) hapticSelection();
      setVisible(index);
      onTickRef.current?.();
      if (index >= text.length) {
        window.clearInterval(interval);
        onDoneRef.current?.();
      }
    }, 24);
    return () => window.clearInterval(interval);
  }, [text]);

  // streaming while the reveal runs: a subrosa fence cut mid-payload renders
  // as a card skeleton instead of a flash of half-written JSON.
  return <SimpleMarkdown text={text.slice(0, visible)} streaming={visible < text.length} />;
}
