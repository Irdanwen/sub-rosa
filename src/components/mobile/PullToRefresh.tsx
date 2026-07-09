import { type ReactNode, useRef, useState } from "react";
import { hapticImpact } from "../../lib/haptics";
import { Spinner } from "../ui/Spinner";

/** Pull distance (px, post-resistance) that arms a refresh on release. */
const TRIGGER = 56;
/** Indicator height while a refresh is running. */
const HOLD = 44;

/**
 * iOS-style pull-to-refresh around a scroll pane: dragging down from the top
 * reveals a spinner with rubber-band resistance; releasing past the threshold
 * runs `onRefresh` and holds the spinner until it settles. Touch-driven only,
 * so desktop pointers and the browser preview never trigger it by accident.
 */
export function PullToRefresh({
  onRefresh,
  className,
  children,
}: {
  onRefresh: () => Promise<unknown>;
  /** Class(es) of the scroll pane this replaces (e.g. "mobile-list-scroll"). */
  className: string;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pull, setPull] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const start = useRef<{ y: number; buzzed: boolean } | null>(null);

  const onTouchStart = (event: React.TouchEvent) => {
    if (refreshing) return;
    const el = scrollRef.current;
    start.current = el && el.scrollTop <= 0 ? { y: event.touches[0].clientY, buzzed: false } : null;
  };

  const onTouchMove = (event: React.TouchEvent) => {
    const state = start.current;
    const el = scrollRef.current;
    if (!state || !el || refreshing) return;
    // The pane scrolled away from the top mid-gesture: this is a scroll.
    if (el.scrollTop > 0 && pull === 0) {
      start.current = null;
      return;
    }
    const delta = event.touches[0].clientY - state.y;
    if (delta <= 0) {
      if (pull !== 0) setPull(0);
      return;
    }
    const next = Math.min(88, delta * 0.45);
    if (next >= TRIGGER && !state.buzzed) {
      state.buzzed = true;
      hapticImpact("light");
    }
    setDragging(true);
    setPull(next);
  };

  const onTouchEnd = () => {
    const state = start.current;
    start.current = null;
    setDragging(false);
    if (!state || refreshing) return;
    if (pull >= TRIGGER) {
      setRefreshing(true);
      setPull(HOLD);
      void Promise.resolve(onRefresh())
        .catch(() => undefined)
        .finally(() => {
          setRefreshing(false);
          setPull(0);
        });
    } else {
      setPull(0);
    }
  };

  return (
    <div
      className={className}
      ref={scrollRef}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div
        className="mobile-ptr-indicator"
        data-dragging={dragging ? "true" : undefined}
        aria-hidden={pull === 0}
        style={{ height: pull, opacity: refreshing ? 1 : Math.min(1, pull / TRIGGER) }}
      >
        <Spinner />
      </div>
      {children}
    </div>
  );
}
