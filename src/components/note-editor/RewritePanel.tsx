import { IconArrowDownWall } from "central-icons/IconArrowDownWall";
import { IconCheckmark1 } from "central-icons-filled/IconCheckmark1";
import { IconArrowsRepeat } from "central-icons/IconArrowsRepeat";
import { IconX } from "central-icons/IconX";
import { DotSpinner } from "../DotSpinner";
import { InlineNotice } from "../ui/InlineNotice";
import type { RewriteRun } from "../../lib/note-rewrite";
import { type Anchor, useAnchoredPanel } from "./useAnchoredPanel";

/**
 * The revision, before it is anything.
 *
 * A rewrite replaces text the person wrote, so it is shown and never applied —
 * the rule `crate::actions` already states for everything the assistant
 * proposes, and the reason ADR-0038 exists. Discarding is one tap and leaves
 * no trace: an unaccepted revision is not stored anywhere.
 *
 * `Insert below` is the escape hatch that makes accepting safe to try. A
 * translation you want beside the original, or a reorganisation you are not
 * sure about, does not have to destroy anything to be useful.
 */

const KIND_LABELS: Record<RewriteRun["kind"], string> = {
  correct: "Corrected",
  reformulate: "Reformulated",
  shorten: "Shortened",
  expand: "Developed",
  restructure: "Reorganised",
  translate: "Translated",
  custom: "Rewritten",
};

export type RewritePanelProps = {
  run: RewriteRun;
  /** Docked above the keyboard rather than floating at the selection. */
  docked?: boolean;
  keyboardInset?: number;
  position: Anchor;
  onReplace: (text: string) => void;
  onInsertBelow: (text: string) => void;
  onRetry: () => void;
  onStop: () => void;
  onDismiss: () => void;
};

export function RewritePanel({
  run,
  docked,
  keyboardInset = 0,
  position,
  onReplace,
  onInsertBelow,
  onRetry,
  onStop,
  onDismiss,
}: RewritePanelProps) {
  const { ref, style } = useAnchoredPanel(position, !docked);
  const running = run.status === "running";
  const ready = run.status === "ready" && run.text.trim().length > 0;

  return (
    <div
      ref={ref}
      className={docked ? "rewrite-panel rewrite-panel-docked" : "rewrite-panel"}
      role="dialog"
      aria-label={`${KIND_LABELS[run.kind]} text`}
      style={docked ? { bottom: keyboardInset } : style}
      // Keeps a click inside the panel from blurring the editor, which would
      // drop the range the revision is about to replace.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      <header className="rewrite-panel-head">
        <span className="rewrite-panel-title">{KIND_LABELS[run.kind]}</span>
        {running ? <DotSpinner /> : null}
        <button
          type="button"
          className="rewrite-panel-close"
          aria-label="Discard"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onDismiss}
        >
          <IconX size={14} />
        </button>
      </header>

      {run.status === "failed" || run.status === "cancelled" ? (
        <InlineNotice tone="warning" body={run.error ?? "That rewrite did not go through."} />
      ) : (
        <div className="rewrite-panel-body" aria-live="polite" aria-busy={running}>
          {run.text ? (
            run.text
          ) : (
            <span className="rewrite-panel-waiting">Reading the selection</span>
          )}
        </div>
      )}

      <footer className="rewrite-panel-actions">
        {running ? (
          <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={onStop}>
            Stop
          </button>
        ) : (
          <>
            {ready ? (
              <>
                <button
                  type="button"
                  className="rewrite-panel-primary"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => onReplace(run.text)}
                >
                  <IconCheckmark1 size={14} />
                  Replace
                </button>
                <button
                  type="button"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => onInsertBelow(run.text)}
                >
                  <IconArrowDownWall size={14} />
                  Insert below
                </button>
              </>
            ) : null}
            <button
              type="button"
              onPointerDown={(event) => event.preventDefault()}
              onClick={onRetry}
            >
              <IconArrowsRepeat size={14} />
              Try again
            </button>
          </>
        )}
      </footer>
    </div>
  );
}
