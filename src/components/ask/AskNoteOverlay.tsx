import { t } from "../../lib/i18n";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../../lib/modal-focus";
import { AskNotesPanel } from "./AskNotesPanel";

/**
 * "Ask this note": a question over one note, from its header. The palette
 * carries the question when the scope is every note; here the note is the
 * scope, so the overlay asks for the question first, then shows the same
 * answer panel with the retrieval kept to this note.
 */
export function AskNoteOverlay({
  noteId,
  title,
  onOpenNote,
  onClose,
}: {
  noteId: string;
  title: string;
  onOpenNote: (noteId: string) => void;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const promptRef = useRef<HTMLFormElement>(null);
  useModalFocus(promptRef, { open: question === null, onClose, initialFocusSelector: "input" });

  const name = title.trim() || "this note";
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a click-away target; the prompt and the panel inside are the dialogs, and Escape (spec/modal-focus.md) is the keyboard route
    <div
      className="ask-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {question === null ? (
        <form
          ref={promptRef}
          className="ask-panel ask-prompt"
          role="dialog"
          aria-modal="true"
          aria-label={`Ask ${name}`}
          tabIndex={-1}
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = draft.trim();
            if (trimmed) setQuestion(trimmed);
          }}
        >
          <p className="ask-panel-question">{t("Ask {name}", { name })}</p>
          <input
            type="text"
            className="ask-prompt-input"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            placeholder={t("What was decided, who said what, when…")}
            aria-label={t("Your question")}
            autoComplete="off"
          />
          <div className="ask-prompt-actions">
            <button type="button" className="ask-panel-toggle" onClick={onClose}>
              {t("Cancel")}
            </button>
            <button type="submit" className="ask-prompt-submit" disabled={!draft.trim()}>
              {t("Ask")}
            </button>
          </div>
        </form>
      ) : (
        <AskNotesPanel
          question={question}
          noteId={noteId}
          onOpenNote={onOpenNote}
          onClose={onClose}
        />
      )}
    </div>,
    document.body,
  );
}
