import { type ReactNode, useRef, useState } from "react";
import { hapticSelection } from "../../lib/haptics";
import { FLICK_VELOCITY, rubberband } from "../../lib/motion";

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
 * buttons (delete/archive). Touch-events based (the webview delivers touch,
 * not pointer, for these drags); vertical scrolling wins when the gesture is
 * steeper than sideways.
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
  // Short position/time history so release knows the finger's velocity — a
  // quick flick should open the actions even under the distance threshold.
  const motionState = useRef({ lastX: 0, lastT: 0, vx: 0 });
  const maxOffset = actions.length * ACTION_WIDTH;

  const onTouchStart = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    start.current = { x: touch.clientX, y: touch.clientY, offset };
    motionState.current = { lastX: touch.clientX, lastT: event.timeStamp, vx: 0 };
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
    const deltaT = event.timeStamp - motionState.current.lastT;
    if (deltaT > 0) {
      motionState.current.vx = (touch.clientX - motionState.current.lastX) / deltaT;
    }
    motionState.current.lastX = touch.clientX;
    motionState.current.lastT = event.timeStamp;
    // Past fully-open, resist progressively (rubber-band) instead of a wall.
    const raw = Math.min(0, start.current.offset + deltaX);
    const next = raw < -maxOffset ? -maxOffset + rubberband(raw + maxOffset, ACTION_WIDTH) : raw;
    setOffset(next);
  };

  const onTouchEnd = () => {
    setDragging(false);
    if (!start.current) return;
    const { vx } = motionState.current;
    setOffset((current) => {
      // Velocity decides ties: a leftward flick opens from any distance, a
      // rightward flick closes even while past the open threshold.
      const flickOpen = vx < -FLICK_VELOCITY;
      const flickClose = vx > FLICK_VELOCITY;
      const next = flickClose ? 0 : flickOpen || current < -OPEN_THRESHOLD ? -maxOffset : 0;
      // A soft tick when the actions snap open, like the platform's rows.
      if (next !== 0 && start.current && start.current.offset === 0) hapticSelection();
      return next;
    });
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
          // The iOS drawer curve, not bare `ease` — the settle should read
          // like the row carrying its momentum home.
          transition: dragging ? "none" : "transform 240ms var(--ease-spring)",
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
