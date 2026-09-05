// Sub Rosa fork: proactive Carpe Diem rail-switch prompt.
//
// When the active payment rail runs dry but the OTHER rail still holds funds,
// don't wait for a 402 — offer a one-click switch. The suggestion comes from
// the same balance poll that feeds the sidebar footer (`suggestSwitchTo`), so
// this needs no extra polling. Dismissible per-suggestion so it never nags.
import { t } from "../../lib/i18n";
import { useCallback, useState } from "react";
import { useCarpeDiemCredits } from "../../lib/carpe-diem-credits";
import { carpeDiemSetRail } from "../../lib/tauri";

const RAIL_NAMES = { credits: "credits", prepaid: "prepaid account" } as const;

export function RailSwitchBanner({ compact = false }: { compact?: boolean }) {
  const credits = useCarpeDiemCredits();
  const suggest = credits?.suggestSwitchTo;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const switchRail = useCallback(async () => {
    if (!suggest) return;
    setBusy(true);
    try {
      await carpeDiemSetRail(suggest);
      // The next balance poll clears the suggestion; hide immediately.
      setDismissed(suggest);
    } catch {
      // Leave the prompt up — the user can retry or open Settings.
    } finally {
      setBusy(false);
    }
  }, [suggest]);

  if (!suggest || dismissed === suggest) return null;
  const to = RAIL_NAMES[suggest];
  const from = suggest === "credits" ? "prepaid account" : "credits";

  return (
    <div className={`carpe-diem-rail-prompt${compact ? " compact" : ""}`} role="status">
      <span className="carpe-diem-rail-prompt-text">
        {t(
          "Your {from} balance is empty, but your {to} balance still has funds. Switch to keep going?",
          { from, to },
        )}
      </span>
      <div className="carpe-diem-rail-prompt-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void switchRail()}
        >
          {busy ? t("Switching…") : t("Switch to {name}", { name: to })}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setDismissed(suggest)}>
          {t("Not now")}
        </button>
      </div>
    </div>
  );
}
