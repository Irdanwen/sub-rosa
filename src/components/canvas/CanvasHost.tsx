import "../../styles/canvas.css";
import { type ReactNode, useEffect, useState } from "react";
import { OPEN_CANVAS_EVENT, type OpenCanvasDetail } from "../../lib/canvas";
import { CanvasPane } from "./CanvasPane";

/**
 * The desktop's split view: the chat on the left, the canvas on the right
 * (ADR-0087). Wraps the agent workspace in App.tsx and answers
 * `openCanvas()` from anywhere in the chat.
 *
 * The wrapper is always rendered, open or not, and the chat always sits in the
 * same child: swapping the tree around the workspace would remount it and
 * throw away the conversation's live state the moment a canvas opens. Closed,
 * both wrappers are `display: contents`, so the workspace lays out exactly as
 * it did before this existed.
 */
export function CanvasHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<(OpenCanvasDetail & { seq: number }) | null>(null);

  useEffect(() => {
    let seq = 0;
    function onOpen(event: Event) {
      const detail = (event as CustomEvent<OpenCanvasDetail>).detail;
      if (!detail?.noteId) return;
      seq += 1;
      setOpen({ ...detail, seq });
    }
    window.addEventListener(OPEN_CANVAS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CANVAS_EVENT, onOpen);
  }, []);

  return (
    <div className="canvas-split" data-open={open ? true : undefined}>
      <div className="canvas-split-chat">{children}</div>
      {open ? (
        <CanvasPane
          // A new open of the same note keeps the editor; another note gets its own.
          key={open.noteId}
          noteId={open.noteId}
          proposal={open.proposal}
          proposalSeq={open.seq}
          layout="split"
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
