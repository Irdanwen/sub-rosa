// Sub Rosa fork: the one-time notice that reflexes are on (ADR-0064).
//
// Reflexes are on by default, and they are the one kind of request that
// leaves the Carpe Diem enclave (anonymized). Settings › Privacy says so next
// to the switch; this says it once to the person who never opens Settings.
// Whether it was read is kept in `reflex.json`, not in the webview's storage.
import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { type ReflexSettingsDto, reflexSettings, setReflexSettings } from "../../lib/reflex";

export function ReflexNotice({ compact = false }: { compact?: boolean }) {
  const [settings, setSettings] = useState<ReflexSettingsDto | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => reflexSettings())
      .then((next) => {
        // A bridge without the command stays quiet.
        if (live && next && typeof next.enabled === "boolean") setSettings(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!settings || !settings.enabled || settings.noticeSeen !== false) return null;

  async function settle(enabled: boolean) {
    setBusy(true);
    try {
      setSettings(await setReflexSettings({ enabled, noticeSeen: true }));
    } catch {
      // Hide it for this session anyway: a notice that cannot be dismissed
      // is worse than one shown again next launch.
      setSettings((current) => (current ? { ...current, noticeSeen: true } : current));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`carpe-diem-rail-prompt${compact ? " compact" : ""}`} role="status">
      <span className="carpe-diem-rail-prompt-text">
        {t(
          "Sub Rosa now checks which passages of your notes and memory bear on a question before answering. These checks go to a fast decision model outside the Carpe Diem enclave, without your identity.",
        )}
      </span>
      <div className="carpe-diem-rail-prompt-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void settle(true)}
        >
          {t("Got it")}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => void settle(false)}
        >
          {t("Turn off")}
        </button>
      </div>
    </div>
  );
}
