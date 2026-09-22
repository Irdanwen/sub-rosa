import { useEffect, useRef } from "react";
import { type Destination, subscribeToDestinations } from "../../lib/destinations";
import { type IntentRequest, takeIntent, takePendingIntents } from "../../lib/intents";

/**
 * Destinations wait for the shell.
 *
 * A Shortcuts action or a link can launch the app cold, and the address then
 * arrives while the local engine is still starting or the key gate is up:
 * acting on it there created a note against a sidecar that was not ready, on
 * whichever tab happened to be showing. Destinations that arrive early are
 * held, and replayed once the shell has something to put them in.
 *
 * Intent addresses are resolved here too, and the inbox is swept on the way
 * in, for the request whose URL was lost to a cold start.
 */
export function useDestinationQueue({
  ready,
  onDestination,
  onIntent,
}: {
  ready: boolean;
  onDestination: (destination: Destination) => void;
  onIntent: (request: IntentRequest) => void;
}) {
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const destinationRef = useRef(onDestination);
  destinationRef.current = onDestination;
  const intentRef = useRef(onIntent);
  intentRef.current = onIntent;
  const pending = useRef<Destination[]>([]);

  const act = (destination: Destination) => {
    if (destination.kind === "intent") {
      void takeIntent(destination.intentId).then((request) => {
        if (request) intentRef.current(request);
      });
      return;
    }
    destinationRef.current(destination);
  };
  const actRef = useRef(act);
  actRef.current = act;

  // Mount-once: a resubscribe would read the launch URL again.
  useEffect(
    () =>
      subscribeToDestinations((destination) => {
        if (readyRef.current) actRef.current(destination);
        else pending.current.push(destination);
      }),
    [],
  );

  useEffect(() => {
    if (!ready) return;
    const sweep = () => {
      void takePendingIntents().then((requests) => {
        for (const request of requests) intentRef.current(request);
      });
    };
    for (const destination of pending.current.splice(0)) actRef.current(destination);
    sweep();
    // A Shortcuts action brings the app to the foreground whether or not its
    // address arrives, so the inbox is swept on the way back too. Taking a
    // request is single-use: the address and the sweep cannot both act.
    const onVisible = () => {
      if (document.visibilityState === "visible") sweep();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [ready]);
}
