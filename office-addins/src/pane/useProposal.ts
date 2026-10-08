import { useCallback, useEffect, useRef, useState } from "react";
import { failureText } from "./errors";

export interface ProposalState<T> {
  text: string;
  pending: boolean;
  /** What the request produced beyond its text, once it finished. */
  value: T | null;
}

/**
 * One proposal at a time: asking again stops the one being written, and
 * discarding drops it without touching the document.
 */
export function useProposal<T>() {
  const [state, setState] = useState<ProposalState<T> | null>(null);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);

  const ask = useCallback(
    async (
      request: (io: {
        signal: AbortSignal;
        onText: (fragment: string) => void;
      }) => Promise<{ text: string; value: T }>,
    ) => {
      controller.current?.abort();
      const own = new AbortController();
      controller.current = own;
      setError("");
      setState({ text: "", pending: true, value: null });
      try {
        const { text, value } = await request({
          signal: own.signal,
          onText: (fragment) =>
            setState((now) => (now?.pending ? { ...now, text: now.text + fragment } : now)),
        });
        if (controller.current !== own) return;
        setState({ text, pending: false, value });
      } catch (err) {
        if (controller.current !== own) return;
        setState(null);
        setError(own.signal.aborted ? "" : failureText(err));
      } finally {
        if (controller.current === own) controller.current = null;
      }
    },
    [],
  );

  const discard = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState(null);
  }, []);

  useEffect(() => () => controller.current?.abort(), []);

  return { proposal: state, error, setError, ask, discard };
}
