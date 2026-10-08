import { useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { Markdown } from "../../lib/markdown";
import { applyCanvas, CanvasError, rewriteCanvas } from "../canvas";
import { CarpeDiemError } from "../carpe-diem";
import { AGENT_LITE } from "../codec";
import { listNotes } from "../library";
import type { ClientContext } from "./context";

/** A code canvas is a note whose body is one fenced code block. */
export function codeOf(body: string): { language: string; code: string } | null {
  const match = /^(`{3,})([\w+#.-]*)\n([\s\S]*?)\n\1\s*$/.exec(body.trim());
  return match ? { language: match[2], code: match[3] } : null;
}

/**
 * A canvas beside the chat (ADR-0087): an ordinary note, edited here as
 * Markdown. A version the assistant proposes, from a reply or from an
 * instruction typed under the document, is shown for review and written only
 * on Accept, as one write (ADR-0038).
 */
export function CanvasPane({
  ctx,
  noteId,
  proposal,
  onClose,
}: {
  ctx: ClientContext;
  noteId: string;
  proposal: string | null;
  onClose: () => void;
}) {
  const note = listNotes(ctx.sync).find((item) => item.id === noteId);
  const [draft, setDraft] = useState(note?.body ?? "");
  const [dirty, setDirty] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [review, setReview] = useState<string | null>(proposal);
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const running = useRef<AbortController | null>(null);
  useEffect(() => setReview(proposal), [proposal]);
  useEffect(() => {
    if (!dirty && note) setDraft(note.body);
  }, [note?.body, dirty, note]);
  useEffect(() => () => running.current?.abort(), []);
  if (!note)
    return (
      <aside className="wc-canvas" aria-label={t("Canvas", "Canevas")}>
        <p className="quiet">{t("This canvas is no longer here.", "Ce canevas n’est plus là.")}</p>
        <button className="button" type="button" onClick={onClose}>
          {t("Close", "Fermer")}
        </button>
      </aside>
    );
  const code = codeOf(draft);
  const save = async (content: string) => {
    await applyCanvas(ctx.sync, note.id, content);
    setDirty(false);
    ctx.flush();
  };
  const ask = async () => {
    setError("");
    const key = await ctx.openKey().catch(() => null);
    if (!key) {
      setError(
        t(
          "This browser has no Carpe Diem key yet.",
          "Ce navigateur n’a pas encore de clé Carpe Diem.",
        ),
      );
      return;
    }
    const controller = new AbortController();
    running.current = controller;
    setStreaming(true);
    setReview("");
    try {
      const proposed = await rewriteCanvas(
        ctx.operator,
        key,
        ctx.model || AGENT_LITE.defaultModel,
        draft,
        instruction,
        (sofar) => setReview(sofar),
        controller.signal,
      );
      setReview(proposed);
      setInstruction("");
    } catch (failure) {
      setReview(null);
      if (failure instanceof CanvasError)
        setError(
          failure.code === "too_long"
            ? t(
                "This canvas is too long for the assistant to rewrite at once.",
                "Ce canevas est trop long pour que l’assistant le réécrive d’un coup.",
              )
            : t(
                "Write something first, then ask.",
                "Écrivez d’abord quelque chose, puis demandez.",
              ),
        );
      else if (!controller.signal.aborted)
        setError(
          failure instanceof CarpeDiemError
            ? t(
                `The model could not answer: ${failure.message}`,
                `Le modèle n’a pas pu répondre : ${failure.message}`,
              )
            : t(
                "The rewrite did not finish. Try again.",
                "La réécriture n’a pas abouti. Réessayez.",
              ),
        );
    } finally {
      running.current = null;
      setStreaming(false);
    }
  };
  return (
    <aside className="wc-canvas" aria-label={t("Canvas", "Canevas")}>
      <header className="wc-row wc-canvas-head">
        <h2>{note.title}</h2>
        {code && (
          <>
            <span className="quiet">{code.language || t("Code", "Code")}</span>
            <button
              className="button"
              type="button"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(code.code)
                  .then(() => setStatus(t("Code copied.", "Code copié.")))
              }
            >
              {t("Copy code", "Copier le code")}
            </button>
          </>
        )}
        <button className="button" type="button" onClick={onClose}>
          {t("Close canvas", "Fermer le canevas")}
        </button>
      </header>
      {review !== null ? (
        <section
          className="wc-review"
          aria-label={t("Proposed version", "Version proposée")}
          aria-busy={streaming}
        >
          <p className="notice">
            {streaming
              ? t("Sub Rosa is writing a new version…", "Sub Rosa écrit une nouvelle version…")
              : t(
                  "A new version is proposed. Nothing changes until you accept it.",
                  "Une nouvelle version est proposée. Rien ne change tant que vous ne l’acceptez pas.",
                )}
          </p>
          <div className="wc-canvas-preview">
            <Markdown text={review} />
          </div>
          <div className="wc-row">
            <button
              className="button primary"
              type="button"
              disabled={streaming || !review.trim()}
              onClick={() =>
                void save(review).then(() => {
                  setDraft(review);
                  setReview(null);
                  setStatus(t("Version accepted.", "Version acceptée."));
                })
              }
            >
              {t("Accept", "Accepter")}
            </button>
            <button
              className="button"
              type="button"
              onClick={() => {
                running.current?.abort();
                setReview(null);
              }}
            >
              {t("Discard", "Ignorer")}
            </button>
          </div>
        </section>
      ) : (
        <>
          <label className="wc-canvas-editor">
            <span className="sr-only">
              {t("Canvas text, in Markdown", "Texte du canevas, en Markdown")}
            </span>
            <textarea
              value={draft}
              rows={18}
              spellCheck
              onChange={(event) => {
                setDraft(event.target.value);
                setDirty(true);
              }}
            />
          </label>
          <div className="wc-row">
            <button
              className="button"
              type="button"
              disabled={!dirty}
              onClick={() => void save(draft)}
            >
              {t("Save", "Enregistrer")}
            </button>
          </div>
          <form
            className="wc-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (instruction.trim()) void ask();
            }}
          >
            <label className="wc-grow">
              <span className="sr-only">{t("What should change?", "Que faut-il changer ?")}</span>
              <input
                value={instruction}
                placeholder={t(
                  "Ask for a change to the whole canvas",
                  "Demandez une modification de tout le canevas",
                )}
                onChange={(event) => setInstruction(event.target.value)}
              />
            </label>
            <button className="button" type="submit" disabled={!instruction.trim() || dirty}>
              {t("Propose", "Proposer")}
            </button>
          </form>
          {dirty && (
            <p className="quiet">
              {t(
                "Save your edits before asking for a new version.",
                "Enregistrez vos modifications avant de demander une nouvelle version.",
              )}
            </p>
          )}
        </>
      )}
      {status && (
        <p className="quiet" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}
