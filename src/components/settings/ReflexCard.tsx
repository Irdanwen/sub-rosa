import { useCallback, useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { type ReflexSettingsDto, reflexSettings, setReflexSettings } from "../../lib/reflex";
import { Switch } from "../ui/Switch";

/**
 * Settings › Privacy: whether search results and memories are screened for
 * relevance by a quick decision model (ADR-0064). On by default, and this is
 * where the one thing that differs from the rest of the app is said: the
 * request leaves the Carpe Diem enclave, anonymized, for the model's operator.
 */
export function ReflexCard() {
  const [settings, setSettings] = useState<ReflexSettingsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    Promise.resolve()
      .then(() => reflexSettings())
      .then((next) => {
        // A bridge without the command (a preview page, an older build)
        // answers nothing, and the card stays quiet rather than crashing.
        if (next && typeof next.enabled === "boolean") setSettings(next);
      })
      .catch((err) => setError(messageFromError(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(enabled: boolean) {
    setSaving(true);
    setError(null);
    try {
      setSettings(await setReflexSettings({ enabled }));
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-card">
      <div className="settings-row">
        <div className="settings-row-text">
          <h3 className="settings-row-title" id="reflex-title">
            {t("Check relevance with quick decisions")}
          </h3>
          <p className="settings-row-description">
            {t(
              "Before a question is answered from your notes or your memory, the passages found are checked by a fast decision model, and only the ones that bear on it are kept. Unlike your other requests, these leave the Carpe Diem enclave for the model's operator, without your identity attached. Off, results are cut by rank alone.",
            )}
          </p>
          {error ? <p className="settings-row-description">{error}</p> : null}
        </div>
        <div className="settings-row-control">
          <Switch
            checked={settings?.enabled === true}
            disabled={settings === null || saving}
            onCheckedChange={(next) => void toggle(next)}
            aria-labelledby="reflex-title"
          />
        </div>
      </div>
    </div>
  );
}
