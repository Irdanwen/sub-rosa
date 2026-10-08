import "../../styles/canvas.css";
import { IconCode } from "central-icons/IconCode";
import { IconFileText } from "central-icons/IconFileText";
import { IconSidebarSimpleRightWide } from "central-icons/IconSidebarSimpleRightWide";
import { useState } from "react";
import { type CanvasChatBlock, openCanvasBlock } from "../../lib/canvas";
import { friendlyErrorMessage } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { SimpleMarkdown } from "../../lib/simple-markdown";
import { HighlightedCode } from "../chat/HighlightedCode";

/** Lines of the draft shown in the card: enough to recognise it. */
const PREVIEW_LINES = 6;

/**
 * A `subrosa:canvas` block: a draft or a file the assistant wrote, offered as
 * a canvas (ADR-0087). Nothing is created until the person opens it. A block
 * that names a canvas already on this device is a proposed new version of it,
 * and opening it shows the proposal for review rather than applying it.
 */
export function CanvasCard({ block }: { block: CanvasChatBlock }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lines = block.content.replace(/\r\n?/g, "\n").split("\n");
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  const more = lines.length > PREVIEW_LINES;
  const code = block.canvasKind === "code";
  const meta = code
    ? block.language
      ? t("Code, {language}", { language: block.language })
      : t("Code")
    : t("Document");

  return (
    <section className="chat-block canvas-card" aria-label={block.title}>
      <header className="canvas-card-head">
        <span className="chat-block-row-icon" aria-hidden>
          {code ? <IconCode size={16} /> : <IconFileText size={16} />}
        </span>
        <span className="chat-block-row-body">
          <span className="chat-block-row-title">{block.title}</span>
          <span className="chat-block-row-meta">{meta}</span>
        </span>
      </header>
      {code ? (
        <pre className="canvas-card-preview" data-code data-more={more || undefined}>
          <HighlightedCode code={preview} language={block.language} />
        </pre>
      ) : (
        // A document reads formatted, not as its markdown source.
        <div className="canvas-card-preview" data-more={more || undefined}>
          <SimpleMarkdown text={preview} />
        </div>
      )}
      <footer className="canvas-card-actions">
        {error ? (
          <span className="canvas-card-error" role="alert">
            {error}
          </span>
        ) : null}
        <button
          type="button"
          className="canvas-card-open"
          disabled={opening}
          onClick={() => {
            setOpening(true);
            setError(null);
            void openCanvasBlock(block)
              .catch((cause) =>
                setError(friendlyErrorMessage(cause, t("The canvas did not open. Try again."))),
              )
              .finally(() => setOpening(false));
          }}
        >
          <IconSidebarSimpleRightWide size={14} aria-hidden />
          {block.noteId ? t("Review in canvas") : t("Open in canvas")}
        </button>
      </footer>
    </section>
  );
}
