import "../../styles/canvas.css";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconCheckmark1 } from "central-icons/IconCheckmark1";
import { IconClipboard } from "central-icons/IconClipboard";
import { IconCode } from "central-icons/IconCode";
import { IconFileText } from "central-icons/IconFileText";
import { IconX } from "central-icons/IconX";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { codeOfCanvas } from "../../lib/canvas";
import { requestOpenNoteFromChat } from "../../lib/chat-blocks-nav";
import { friendlyErrorMessage } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { useNoteRewrite } from "../../lib/note-rewrite";
import { getNote, updateNote } from "../../lib/tauri";
import { DotSpinner } from "../DotSpinner";
import { NotePreview } from "../note-editor/NotePreview";
import { InlineNotice } from "../ui/InlineNotice";

/**
 * The canvas: one note, opened beside the chat on the desktop and as a screen
 * of its own on the phone (ADR-0087).
 *
 * The body is the note editor itself, so everything a note can hold a canvas
 * can hold, and it is saved the way a note is, on blur. What the assistant
 * proposes is shown *instead of* the document until the person accepts it or
 * discards it (ADR-0038): a whole new version from a `subrosa:canvas` block,
 * or one written here from an instruction typed under the canvas. Accepting
 * is the only way the model's text reaches the note.
 */
export function CanvasPane({
  noteId,
  proposal,
  proposalSeq,
  layout,
  onClose,
}: {
  noteId: string;
  /** A version the assistant proposed in the chat, waiting for review. */
  proposal?: string;
  /** Changes with every open, so the same proposal opened again is shown again. */
  proposalSeq?: number;
  layout: "split" | "screen";
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [agentProposal, setAgentProposal] = useState<string | null>(proposal ?? null);
  const [copied, setCopied] = useState(false);
  const { run, start, stop, dismiss } = useNoteRewrite();

  useEffect(() => {
    let cancelled = false;
    setMarkdown(null);
    setLoadError(null);
    getNote(noteId)
      .then((note) => {
        if (cancelled) return;
        setTitle(note.title ?? "");
        setMarkdown(note.editedContent ?? note.generatedContent ?? "");
      })
      .catch((error) => {
        if (!cancelled)
          setLoadError(friendlyErrorMessage(error, t("This canvas could not be opened.")));
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  // A new proposal from the chat replaces whatever was waiting for review,
  // even the same text opened again (React's "adjust state on a prop change").
  const [seenSeq, setSeenSeq] = useState(proposalSeq);
  if (proposalSeq !== seenSeq) {
    setSeenSeq(proposalSeq);
    if (proposal) setAgentProposal(proposal);
  }

  const persist = useCallback(
    (next: string) => {
      setMarkdown(next);
      setSaveError(null);
      void Promise.resolve(updateNote({ noteId, editedContent: next })).catch((error) =>
        setSaveError(friendlyErrorMessage(error, t("Your changes were not saved. Try again."))),
      );
    },
    [noteId],
  );

  const code = useMemo(() => (markdown === null ? null : codeOfCanvas(markdown)), [markdown]);

  // What is under review: a run asked for here wins over a block's proposal.
  const review = run
    ? {
        text: run.text,
        running: run.status === "running",
        error: run.status === "failed" || run.status === "cancelled" ? run.error : undefined,
      }
    : agentProposal !== null
      ? { text: agentProposal, running: false, error: undefined }
      : null;

  function closeReview() {
    dismiss();
    setAgentProposal(null);
  }

  function accept(text: string) {
    persist(text);
    closeReview();
  }

  function ask(event: FormEvent) {
    event.preventDefault();
    const value = instruction.trim();
    if (!value || markdown === null) return;
    setAgentProposal(null);
    start({ kind: "canvas", text: markdown, instruction: value });
    setInstruction("");
  }

  async function copy() {
    if (markdown === null) return;
    try {
      await writeText(code ? code.code : markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Copy is a convenience; a transient clipboard failure is not worth a notice.
    }
  }

  const kindLabel = code
    ? code.language
      ? t("Code, {language}", { language: code.language })
      : t("Code")
    : t("Document");

  return (
    <section className="canvas-pane" data-layout={layout} aria-label={t("Canvas")}>
      <header className="canvas-pane-head">
        <span className="canvas-pane-kind" aria-hidden>
          {code ? <IconCode size={15} /> : <IconFileText size={15} />}
        </span>
        <div className="canvas-pane-heading">
          <h2 className="canvas-pane-title">{title || t("Canvas")}</h2>
          <span className="canvas-pane-meta">{kindLabel}</span>
        </div>
        <button
          type="button"
          className="canvas-pane-action"
          onClick={() => void copy()}
          aria-label={code ? t("Copy code") : t("Copy document")}
          title={code ? t("Copy code") : t("Copy document")}
          disabled={markdown === null}
        >
          {copied ? <IconCheckmark1 size={15} /> : <IconClipboard size={15} />}
        </button>
        <button
          type="button"
          className="canvas-pane-action"
          onClick={() => requestOpenNoteFromChat(noteId)}
          aria-label={t("Open as a note")}
          title={t("Open as a note")}
        >
          <IconArrowUpRight size={15} />
        </button>
        <button
          type="button"
          className="canvas-pane-action"
          onClick={onClose}
          aria-label={t("Close canvas")}
          title={t("Close canvas")}
        >
          <IconX size={15} />
        </button>
      </header>

      {saveError ? <InlineNotice tone="warning" body={saveError} /> : null}

      <div className="canvas-pane-body">
        {loadError ? (
          <InlineNotice tone="warning" body={loadError} />
        ) : markdown === null ? (
          <div className="canvas-pane-loading" aria-busy="true">
            <DotSpinner />
          </div>
        ) : review ? (
          <CanvasReview
            text={review.text}
            running={review.running}
            error={review.error}
            onAccept={accept}
            onDiscard={closeReview}
            onStop={stop}
          />
        ) : (
          <NotePreview
            noteId={noteId}
            markdown={markdown}
            onChange={(changedNoteId, next) => {
              if (changedNoteId !== noteId || next === markdown) return;
              persist(next);
            }}
            emptyPlaceholder={t("Start writing, or ask Sub Rosa below")}
          />
        )}
      </div>

      <form className="canvas-pane-ask" onSubmit={ask}>
        <input
          type="text"
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder={code ? t("Ask for a change to the code") : t("Ask for a change")}
          aria-label={t("Ask for a change")}
          disabled={markdown === null || Boolean(review?.running)}
        />
        <button
          type="submit"
          className="canvas-pane-send"
          aria-label={t("Send")}
          disabled={!instruction.trim() || markdown === null || Boolean(review?.running)}
        >
          <IconArrowUp size={15} />
        </button>
      </form>
    </section>
  );
}

/** A proposed version, before it is anything: accept it, or nothing happens. */
function CanvasReview({
  text,
  running,
  error,
  onAccept,
  onDiscard,
  onStop,
}: {
  text: string;
  running: boolean;
  error?: string;
  onAccept: (text: string) => void;
  onDiscard: () => void;
  onStop: () => void;
}) {
  const ready = !running && !error && text.trim().length > 0;
  return (
    <section className="canvas-review" aria-label={t("Proposed version")}>
      <header className="canvas-review-head">
        <span className="canvas-review-title">{t("Proposed version")}</span>
        {running ? <DotSpinner /> : null}
      </header>
      {error ? (
        <InlineNotice tone="warning" body={error} />
      ) : (
        <div className="canvas-review-text" aria-live="polite" aria-busy={running}>
          {text || <span className="canvas-review-waiting">{t("Reading the canvas")}</span>}
        </div>
      )}
      <footer className="canvas-review-actions">
        {running ? (
          <button type="button" onClick={onStop}>
            {t("Stop")}
          </button>
        ) : (
          <>
            {ready ? (
              <button
                type="button"
                className="canvas-review-primary"
                onClick={() => onAccept(text)}
              >
                <IconCheckmark1 size={14} />
                {t("Accept")}
              </button>
            ) : null}
            <button type="button" onClick={onDiscard}>
              {t("Discard")}
            </button>
          </>
        )}
      </footer>
    </section>
  );
}
