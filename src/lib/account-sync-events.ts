import { invoke } from "@tauri-apps/api/core";
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
 * Chats another device deleted (ADR-0108). The sync lane removed their rows
 * and keeps each runtime session id until the workspace says it forgot it,
 * so a chat deleted while this window was not open is still dropped. Asked
 * on mount, on every sync event, and when the lane says one just happened.
 * A runtime that no longer has the session is the outcome wanted, so its
 * refusal is not an error to show.
 */
export function useHermesSessionsRemovedElsewhere() {
  useEffect(() => {
    let disposed = false;
    let draining = false;
    const drain = async () => {
      if (draining) return;
      draining = true;
      try {
        const removed = await invoke<string[]>("account_hermes_sessions_removed");
        for (const sessionId of removed) {
          if (disposed) return;
          try {
            await deleteHermesSession(sessionId);
          } catch {
            /* Already gone, or no runtime: the local removal is what matters. */
          }
          window.dispatchEvent(
            new CustomEvent(AGENT_DELETE_SESSION_EVENT, { detail: { sessionId } }),
          );
          await invoke("account_hermes_session_forgotten", { sessionId });
        }
      } catch {
        /* The next sync event asks again. */
      } finally {
        draining = false;
      }
    };
    void drain();
    const subscriptions = [ACCOUNT_SYNC_UPDATED_EVENT, "subrosa://hermes-session-removed"].map(
      (name) =>
        listen(name, () => {
          if (!disposed) void drain();
        }).catch(() => () => {}),
    );
    return () => {
      disposed = true;
      for (const subscription of subscriptions) void subscription.then((unlisten) => unlisten());
    };
  }, []);
}
