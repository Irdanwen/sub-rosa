import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A callback whose identity never changes but which always runs the latest
 * render's function. For handlers passed to memoized rows: a fresh closure per
 * render would defeat the memo on every streamed frame.
 */
export function useEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
