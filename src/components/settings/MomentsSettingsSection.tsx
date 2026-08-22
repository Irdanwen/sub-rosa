import { useEffect, useState } from "react";
import { type MomentSettingsDto, momentsGetSettings, momentsSetSettings } from "../../lib/tauri";
import { Switch } from "../ui/Switch";

/**
 * When the app is allowed to speak first.
 *
 * The brief is off until it is asked for: nothing should start talking to
 * someone who never said yes. The recap is on, because it only ever answers
 * a question the user already has — "is my recording done yet" — about a
 * thing they just did.
 */
export function MomentsSettingsSection() {
  const [settings, setSettings] = useState<MomentSettingsDto | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    momentsGetSettings()
      .then((value) => {
        if (!cancelled) setSettings(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const update = async (next: MomentSettingsDto) => {
    setSaving(true);
    try {
      setSettings(await momentsSetSettings(next));
    } catch {
      // Keep the last known-good state rather than showing a half-applied one.
    } finally {
      setSaving(false);
    }
  };

  const disabled = settings === null || saving;

  return (
    <div className="settings-card">
      <div className="settings-rows">
        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">Meeting briefs</h3>
            <p className="settings-row-description">
              Ten minutes before a meeting with other people, a reminder of what you last decided
              with them and what is still open. It stays quiet when your notes have nothing to say
              about them, and it reads your calendar on this device only.
            </p>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={settings?.briefEnabled === true}
              disabled={disabled}
              onCheckedChange={(briefEnabled) =>
                void update({ briefEnabled, recapEnabled: settings?.recapEnabled ?? true })
              }
              aria-label="Meeting briefs"
            />
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">Tell me when a note is ready</h3>
            <p className="settings-row-description">
              A recording usually finishes becoming a note while you are doing something else. This
              says so, and opens the note when you tap it.
            </p>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={settings?.recapEnabled === true}
              disabled={disabled}
              onCheckedChange={(recapEnabled) =>
                void update({ briefEnabled: settings?.briefEnabled ?? false, recapEnabled })
              }
              aria-label="Tell me when a note is ready"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
