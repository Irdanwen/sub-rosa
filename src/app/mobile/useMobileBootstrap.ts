import { type Dispatch, useCallback, useEffect, useRef, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { bootstrapApp } from "../../lib/tauri";
import type { NotesAction } from "../state/app-state";

/** A failed first read is retryable; only a successful read completes boot. */
export function useMobileBootstrap(blocked: boolean, dispatch: Dispatch<NotesAction>) {
  const completed = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const retry = useCallback(() => {
    setError(null);
    setLoading(true);
    setAttempt((value) => value + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed read.
  useEffect(() => {
    if (blocked || completed.current) return;
    let active = true;
    setLoading(true);
    setError(null);
    void bootstrapApp()
      .then((payload) => {
        if (!active) return;
        dispatch({ type: "bootstrapLoaded", payload });
        completed.current = true;
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(messageFromError(err));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [blocked, attempt, dispatch]);

  return { loading, error, retry };
}
