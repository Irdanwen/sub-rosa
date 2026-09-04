import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconSparkle3 } from "central-icons/IconSparkle3";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { messageFromError } from "../../lib/errors";
import { type AskAnswerDto, askNotes } from "../../lib/ask";
import { useModalFocus } from "../../lib/modal-focus";

/**
 * Whether a palette query reads as a question rather than a name to find.
 * A trailing question mark is the sure sign; a leading interrogative in
 * French or English catches the rest without claiming every search.
 */
export function looksLikeAQuestion(query: string) {
  const trimmed = query.trim();
  if (trimmed.length < 8) return false;
  if (trimmed.endsWith("?")) return true;
  return /^(what|why|who|when|where|how|which|did|does|is|are|quand|pourquoi|qui|comment|combien|où|quel|quelle|quels|quelles|est-ce)\b/i.test(
    trimmed,
  );
}

/**
 * Split an answer on its citations so each `[n]` becomes a link to the note
 * it came from. Inventions (indices that were never sent) stay as text.
 */
export function answerParts(
  answer: string,
  citations: AskAnswerDto["citations"],
): Array<{ text: string } | { citation: AskAnswerDto["citations"][number] }> {
  const parts: Array<{ text: string } | { citation: AskAnswerDto["citations"][number] }> = [];
  const pattern = /\[(\d+)\]/g;
  let last = 0;
  for (const match of answer.matchAll(pattern)) {
    const index = Number(match[1]);
    const citation = citations.find((c) => c.index === index);
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: answer.slice(last, at) });
    if (citation) parts.push({ citation });
    else parts.push({ text: match[0] });
    last = at + match[0].length;
  }
  if (last < answer.length) parts.push({ text: answer.slice(last) });
  return parts;
}

/**
 * The answer to a question over the notes, with every claim linked to its
 * note and, underneath, the exact passages that were sent. The second list
 * is the point: a person sees what left the machine for this answer.
 */
export function AskNotesPanel({
  question,
  onOpenNote,
  onClose,
}: {
  question: string;
  onOpenNote: (noteId: string) => void;
  onClose: () => void;
}) {
  const [result, setResult] = useState<AskAnswerDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSent, setShowSent] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  // Focus in, Escape closes, focus back (spec/modal-focus.md). The panel
  // itself takes focus first so a screen reader lands on the question.
  useModalFocus(panelRef, { onClose, initialFocusSelector: ".ask-panel" });

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    askNotes(question)
      .then((answer) => {
        if (!cancelled) setResult(answer);
      })
      .catch((err) => {
        if (!cancelled) setError(messageFromError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [question]);

  return (
    <section className="ask-panel" aria-label="Answer from your notes" ref={panelRef} tabIndex={-1}>
      <header className="ask-panel-header">
        <p className="ask-panel-question">{question}</p>
        <button type="button" className="ask-panel-close" aria-label="Close" onClick={onClose}>
          <IconCrossSmall size={14} aria-hidden />
        </button>
      </header>
      {error ? (
        <p className="ask-panel-error">{error}</p>
      ) : result ? (
        <>
          <p className="ask-panel-answer">
            {answerParts(result.answer, result.citations).map((part, i) =>
              "citation" in part ? (
                <button
                  type="button"
                  className="ask-citation"
                  // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional by construction
                  key={i}
                  title={part.citation.title}
                  onClick={() => onOpenNote(part.citation.noteId)}
                >
                  {part.citation.index}
                </button>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional by construction
                <span key={i}>{part.text}</span>
              ),
            )}
          </p>
          {result.citations.length > 0 ? (
            <ul className="ask-panel-sources" aria-label="Sources">
              {result.citations.map((source) => (
                <li key={source.index}>
                  <button type="button" onClick={() => onOpenNote(source.noteId)}>
                    <span className="ask-citation">{source.index}</span>
                    <span className="ask-source-title">{source.title}</span>
                    <span className="ask-source-kind">{source.kind}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {result.invented.length > 0 ? (
            <p className="ask-panel-note">
              The model cited {result.invented.map((n) => `[${n}]`).join(", ")}, which was not among
              the passages it was given; treat that sentence with care.
            </p>
          ) : null}
          <button
            type="button"
            className="ask-panel-toggle"
            aria-expanded={showSent}
            onClick={() => setShowSent((value) => !value)}
          >
            {showSent ? "Hide what was sent" : `What was sent (${result.sent.length} passages)`}
          </button>
          {showSent ? (
            <ol className="ask-panel-sent">
              {result.sent.map((source) => (
                <li key={source.index}>
                  <strong>{source.title}</strong>
                  <span className="ask-source-kind"> · {source.kind}</span>
                  <p>{source.excerpt}</p>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : (
        <p className="ask-panel-answer ask-panel-pending" role="status">
          Reading your notes…
        </p>
      )}
    </section>
  );
}

/** The panel over the whole window, for the desktop palette. */
export function AskNotesOverlay(props: {
  question: string;
  onOpenNote: (noteId: string) => void;
  onClose: () => void;
}) {
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a click-away target; the panel inside is the dialog, and Escape (spec/modal-focus.md) is the keyboard route
    <div
      className="ask-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <AskNotesPanel {...props} />
    </div>,
    document.body,
  );
}

/**
 * The palette item that offers to answer the query, when the query reads
 * as a question. Shaped like the palette's own items so it slots into a
 * group without the palette knowing about asking.
 */
export function askPaletteItems(
  query: string,
  onAsk: (question: string) => void,
): Array<{
  id: string;
  label: string;
  meta: string;
  icon: ReactNode;
  searchText: string;
  action: () => void;
}> {
  const trimmed = query.trim();
  if (!looksLikeAQuestion(trimmed)) return [];
  return [
    {
      id: "ask:notes",
      label: `Ask your notes: ${trimmed}`,
      meta: "Answer with citations",
      icon: <IconSparkle3 size={15} />,
      searchText: "",
      action: () => onAsk(trimmed),
    },
  ];
}
