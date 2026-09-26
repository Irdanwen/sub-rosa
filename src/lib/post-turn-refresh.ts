/**
 * After a turn ends, the stored transcript has to catch up with the live frames
 * that showed it, and until it does those frames are the only copy of the
 * reply. One fetch shortly after the end was not enough: Hermes can still be
 * writing the turn when it lands, and a fetch that fails or comes back early
 * left the live copy in place, where the next send found it (it was rendered
 * under the new prompt, then twice once the stored copy arrived).
 *
 * So a finished turn gets a short, bounded series of refreshes that stops as
 * soon as one sees the stored reply.
 */
export const POST_TURN_REFRESH_DELAYS_MS = [300, 1000, 3000] as const;

export type PostTurnRefresher = {
  /** Start (or restart) the series for a session. */
  schedule(sessionId: string): void;
  /** Stop a session's series. */
  cancel(sessionId: string): void;
  /** Stop every series (unmount). */
  cancelAll(): void;
};

/**
 * `refresh` fetches the session and resolves true once the stored transcript
 * shows a reply after the user's latest message. A rejection counts as not yet.
 */
export function createPostTurnRefresher(
  refresh: (sessionId: string) => Promise<boolean>,
  delays: readonly number[] = POST_TURN_REFRESH_DELAYS_MS,
): PostTurnRefresher {
  const series = new Map<string, { timers: number[]; done: boolean }>();

  const cancel = (sessionId: string) => {
    const current = series.get(sessionId);
    if (!current) return;
    current.done = true;
    for (const timer of current.timers) window.clearTimeout(timer);
    series.delete(sessionId);
  };

  return {
    schedule(sessionId) {
      cancel(sessionId);
      const current = { timers: [] as number[], done: false };
      series.set(sessionId, current);
      current.timers = delays.map((delay, index) =>
        window.setTimeout(() => {
          if (current.done) return;
          void refresh(sessionId)
            .catch(() => false)
            .then((caughtUp) => {
              if (current.done) return;
              if (caughtUp || index === delays.length - 1) {
                if (series.get(sessionId) === current) cancel(sessionId);
              }
            });
        }, delay),
      );
    },
    cancel,
    cancelAll() {
      for (const sessionId of [...series.keys()]) cancel(sessionId);
    },
  };
}
