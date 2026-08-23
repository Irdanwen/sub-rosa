import { useEffect, useState } from "react";
import {
  type MomentSettingsDto,
  type SpotlightSettingsDto,
  momentsGetSettings,
  momentsSetSettings,
  spotlightGetSettings,
  spotlightSetSettings,
} from "../../lib/tauri";
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
  const [spotlight, setSpotlight] = useState<SpotlightSettingsDto | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    momentsGetSettings()
      .then((value) => {
        if (!cancelled) setSettings(value);
      })
      .catch(() => {});
    spotlightGetSettings()
      .then((value) => {
        if (!cancelled) setSpotlight(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const updateSpotlight = async (next: SpotlightSettingsDto) => {
    setSaving(true);
    try {
      setSpotlight(await spotlightSetSettings(next));
    } catch {
      // Keep the last known-good state.
    } finally {
      setSaving(false);
    }
  };

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
        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">Find notes in system search</h3>
            <p className="settings-row-description">
              Put your note titles and dates in this device's search index, so Spotlight finds them.
              Turning this off removes what is already indexed.
            </p>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={spotlight?.enabled === true}
              disabled={spotlight === null || saving}
              onCheckedChange={(enabled) =>
                void updateSpotlight({
                  enabled,
                  includeContent: spotlight?.includeContent ?? false,
                })
              }
              aria-label="Find notes in system search"
            />
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">Include what the notes say</h3>
            <p className="settings-row-description">
              Also index the first lines of each note, so searching for something said inside one
              finds it. The system index is not Sub Rosa's storage, so this is off until you ask for
              it.
            </p>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={spotlight?.includeContent === true}
              disabled={spotlight === null || saving || spotlight?.enabled !== true}
              onCheckedChange={(includeContent) =>
                void updateSpotlight({ enabled: spotlight?.enabled ?? true, includeContent })
              }
              aria-label="Include what the notes say"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
