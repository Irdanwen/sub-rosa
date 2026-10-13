import { useEffect, useState } from "react";

// The clock every long wait shows beside its phase (note processing, the
// long-form summary). Past a few seconds a person needs to know the work is
// alive; past ten, what it is doing; a clock that keeps counting says the
// first, the phase label says the second.

/** "1:04" / "12:07" / "1:22:40". Monospaced digits keep it from twitching. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** A ticking clock, owned here rather than derived from the poll: a poll that
 * misses a beat would make the seconds stutter, which reads as a stall. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
