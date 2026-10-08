import { useEffect, useRef } from "react";
import { type Destination, subscribeToDestinations } from "../../lib/destinations";
import { type IntentRequest, takeIntent, takePendingIntents } from "../../lib/intents";
import { pendingSharedItems } from "../../lib/share-inbox";

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
 * in, for the request whose URL was lost to a cold start. The share inbox is
 * swept the same way (ADR-0095): Android hands a cold start only the last
 * address of a batch. A share is acted on once per session whichever way it
 * arrives, its address or the sweep.
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
  const sharesTaken = useRef(new Set<string>());

  const act = (destination: Destination) => {
    if (destination.kind === "share") {
      if (sharesTaken.current.has(destination.itemId)) return;
      sharesTaken.current.add(destination.itemId);
    }
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
      void pendingSharedItems().then((ids) => {
        for (const itemId of ids) actRef.current({ kind: "share", itemId });
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
