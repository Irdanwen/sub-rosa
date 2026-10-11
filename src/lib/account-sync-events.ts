import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { AGENT_DELETE_SESSION_EVENT } from "./agent-events";
import { deleteHermesSession } from "./hermes-adapter";

export const ACCOUNT_SYNC_UPDATED_EVENT = "subrosa://sync-updated";

/** Observe native work. Coalesce repeated notifications; never start sync in JS. */
export function useAccountSyncUpdated(refresh: () => Promise<unknown>) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    let disposed = false;
    let running = false;
    let again = false;
    const update = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      do {
        again = false;
        try {
          await refreshRef.current();
        } catch {
          /* Local work remains available. */
        }
      } while (again && !disposed);
      running = false;
    };
    const subscription = listen(ACCOUNT_SYNC_UPDATED_EVENT, () => {
      if (!disposed) void update();
    }).catch(() => () => {});
    return () => {
      disposed = true;
      void subscription.then((unlisten) => unlisten());
    };
  }, []);
}

/**
 * A chat another device deleted (ADR-0108). The sync lane removed its rows
 * and says which runtime session they belonged to; the desktop's runtime
 * still lists it until it is asked to forget it, and the workspace drops it
 * through the same event the sidebar uses. A runtime that no longer has it
 * is the outcome wanted, so its refusal is not an error to show.
 */
export function useHermesSessionsRemovedElsewhere() {
  useEffect(() => {
    let disposed = false;
    const subscription = listen<{ session_id?: string }>(
      "subrosa://hermes-session-removed",
      (event) => {
        const sessionId = event.payload?.session_id;
        if (disposed || !sessionId) return;
        void deleteHermesSession(sessionId)
          .catch(() => {})
          .then(() => {
            if (disposed) return;
            window.dispatchEvent(
              new CustomEvent(AGENT_DELETE_SESSION_EVENT, { detail: { sessionId } }),
            );
          });
      },
    ).catch(() => () => {});
    return () => {
      disposed = true;
      void subscription.then((unlisten) => unlisten());
    };
  }, []);
}
