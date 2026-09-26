/**
 * Coalesces many requests to publish the same state into at most one per
 * animation frame. A streamed reply delivers a frame per token; publishing each
 * one re-rendered the whole agent workspace per token. The caller keeps its
 * source of truth up to date synchronously (a ref) and only the React publish
 * is deferred, so every reader of the ref still sees every frame at once.
 *
 * Falls back to a 16 ms timeout where `requestAnimationFrame` is missing.
 */
export type FrameBatcher = {
  /** Publish on the next frame, unless a publish is already pending. */
  schedule(): void;
  /** Publish now, dropping any pending frame. */
  flush(): void;
  /** Drop any pending frame without publishing (unmount). */
  cancel(): void;
};

export function createFrameBatcher(publish: () => void): FrameBatcher {
  let cancelPending: (() => void) | undefined;

  const cancel = () => {
    cancelPending?.();
    cancelPending = undefined;
  };

  return {
    schedule() {
      if (cancelPending) return;
      cancelPending = requestFrame(() => {
        cancelPending = undefined;
        publish();
      });
    },
    flush() {
      cancel();
      publish();
    },
    cancel,
  };
}

/** Runs `callback` on the next animation frame; returns a canceller. */
export function requestFrame(callback: () => void): () => void {
  if (typeof window.requestAnimationFrame === "function") {
    const handle = window.requestAnimationFrame(() => callback());
    return () => window.cancelAnimationFrame(handle);
  }
  const handle = window.setTimeout(callback, 16);
  return () => window.clearTimeout(handle);
}
