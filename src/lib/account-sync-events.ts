import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

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
