// Sub Rosa fork: live Carpe Diem balance for the sidebar footer.
import { useCallback, useEffect, useState } from "react";
import { carpeDiemGetCredits } from "./tauri";
import type { CarpeDiemCreditsDto } from "./tauri";

// Credits drain with every AI call, so attention-refresh alone would show a
// stale balance during an active session; a slow poll keeps it honest without
// hammering the endpoint.
const POLL_INTERVAL_MS = 60_000;

/** Polls the Carpe Diem balance. Returns null until the first successful
 * fetch — no stored key, the browser preview, or an unreachable endpoint all
 * leave it null so callers can fall back to the account name. A refresh that
 * fails after a success keeps the last known balance. */
export function useCarpeDiemCredits(): CarpeDiemCreditsDto | null {
  const [credits, setCredits] = useState<CarpeDiemCreditsDto | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCredits(await carpeDiemGetCredits());
    } catch {
      // Keep the last known balance (or the name fallback before first load).
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Same attention-refresh pattern as useAccountStatus: `focus` and
  // `visibilitychange` both fire in Tauri webviews; the inFlight flag de-dupes
  // a focus event that arrives while a fetch is still pending.
  useEffect(() => {
    let inFlight = false;
    function maybeRefresh() {
      if (inFlight) return;
      if (document.visibilityState === "hidden") return;
      inFlight = true;
      void refresh().finally(() => {
        inFlight = false;
      });
    }
    window.addEventListener("focus", maybeRefresh);
    document.addEventListener("visibilitychange", maybeRefresh);
    return () => {
      window.removeEventListener("focus", maybeRefresh);
      document.removeEventListener("visibilitychange", maybeRefresh);
    };
  }, [refresh]);

  return credits;
}
