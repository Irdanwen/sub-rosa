import { type ReactNode, useRef, useState } from "react";

export type SwipeAction = {
  label: string;
  /** "destructive" renders red, "neutral" renders gray. */
  tone: "destructive" | "neutral";
  onAction: () => void;
};

const ACTION_WIDTH = 76;
const OPEN_THRESHOLD = 40;

/**
 * iOS-style swipe-to-reveal row: dragging left uncovers trailing action
 * buttons (delete/archive). Pointer-events based so it works in the webview;
 * vertical scrolling wins when the gesture is steeper than sideways.
 */
export function SwipeableRow({
  actions,
  children,
}: {
  actions: SwipeAction[];
  children: ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; offset: number } | null>(null);
  const locked = useRef<"horizontal" | "vertical" | null>(null);
  const maxOffset = actions.length * ACTION_WIDTH;

  const onTouchStart = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    start.current = { x: touch.clientX, y: touch.clientY, offset };
    locked.current = null;
  };

  const onTouchMove = (event: React.TouchEvent) => {
    if (!start.current) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - start.current.x;
    const deltaY = touch.clientY - start.current.y;
    if (!locked.current) {
      if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) return;
      locked.current = Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
      if (locked.current === "horizontal") setDragging(true);
    }
    if (locked.current !== "horizontal") return;
    const next = Math.min(0, Math.max(-maxOffset * 1.2, start.current.offset + deltaX));
    setOffset(next);
  };

  const onTouchEnd = () => {
    setDragging(false);
    if (!start.current) return;
    setOffset((current) => (current < -OPEN_THRESHOLD ? -maxOffset : 0));
    start.current = null;
    locked.current = null;
  };

  return (
    <div className="swipe-row" data-open={offset < 0 ? "true" : undefined}>
      <div className="swipe-row-actions" style={{ width: maxOffset }}>
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className="swipe-row-action"
            data-tone={action.tone}
            style={{ width: ACTION_WIDTH }}
            onClick={() => {
              setOffset(0);
              action.onAction();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
      <div
        className="swipe-row-content"
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? "none" : "transform 200ms ease",
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onClickCapture={(event) => {
          // A tap while the row is open closes it instead of navigating.
          if (offset < 0) {
            event.stopPropagation();
            event.preventDefault();
            setOffset(0);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
