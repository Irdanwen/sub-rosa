import { t } from "../../lib/i18n";
import { useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { isMacDesktopPlatform } from "../../lib/platform";
import {
  type ScreenAwarenessSettings,
  saveScreenAwarenessSettings,
  screenAwarenessSettings,
  screenRecordingPermission,
} from "../../lib/screen-awareness";
import { Dialog } from "../ui/Dialog";
import { Switch } from "../ui/Switch";

/**
 * Settings › Privacy: "What I'm looking at" (ADR-0094). Off by default; on,
 * a click in the chat or the chat bar attaches the app, its window title
 * and the selected text. A window picture is a second opt-in, explained
 * before macOS asks for Screen Recording.
 *
 * The capture runs in the dictation helper, a separate app bundle the app
 * starts, and macOS holds the helper responsible for its own permission
 * requests: the prompt and the System Settings entry say "Sub Rosa
 * Dictation Helper", not "Sub Rosa" (ADR-0094, addendum). The copy names it
 * so the person turns on the right switch.
 */
export function ScreenAwarenessCard() {
  const [settings, setSettings] = useState<ScreenAwarenessSettings | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mac = isMacDesktopPlatform();

  useEffect(() => {
    Promise.resolve()
      .then(() => screenAwarenessSettings())
      .then((next) => {
        if (next) setSettings(next);
      })
      .catch(() => {
        // A build without it shows nothing here.
      });
  }, []);

  if (!settings) return null;
  const current = settings;

  async function save(next: ScreenAwarenessSettings) {
    setSaving(true);
    setError(null);
    try {
      setSettings(await saveScreenAwarenessSettings(next));
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(false);
    }
  }

  async function allowPictures() {
    setExplaining(false);
    setSaving(true);
    try {
      const granted = await screenRecordingPermission(true);
      if (!granted) {
        setError(
          t(
            "macOS did not allow Screen Recording yet. In System Settings, Privacy and Security, Screen Recording, turn on Sub Rosa Dictation Helper, restart Sub Rosa, then turn this on again.",
          ),
        );
        return;
      }
      await save({ ...current, screenshots: true });
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-card">
      <div className="settings-rows">
        <div className="settings-row">
          <div className="settings-row-text">
            <h3 className="settings-row-title" id="screen-awareness-title">
              {t("What I’m looking at")}
            </h3>
            <p className="settings-row-description">
              {mac
                ? t(
                    "Lets you attach the app you are in, its window title and the text you selected to a question. Nothing is read until you click to attach it, and you can remove it before sending.",
                  )
                : t(
                    "Lets you attach the title of the window you are in to a question. Nothing is read until you click to attach it, and you can remove it before sending.",
                  )}
            </p>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={settings.enabled}
              disabled={saving}
              onCheckedChange={(enabled) => void save({ ...settings, enabled })}
              aria-labelledby="screen-awareness-title"
            />
          </div>
        </div>
        {mac && settings.enabled ? (
          <div className="settings-row">
            <div className="settings-row-text">
              <h3 className="settings-row-title" id="screen-awareness-pictures">
                {t("Include a picture of the window")}
              </h3>
              <p className="settings-row-description">
                {t("Offers a second button that attaches a picture of that one window.")}
              </p>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={settings.screenshots}
                disabled={saving}
                onCheckedChange={(screenshots) =>
                  screenshots ? setExplaining(true) : void save({ ...settings, screenshots })
                }
                aria-labelledby="screen-awareness-pictures"
              />
            </div>
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="settings-row-error" role="alert">
          {error}
        </p>
      ) : null}
      <Dialog
        open={explaining}
        onClose={() => setExplaining(false)}
        title={t("Pictures of a window")}
        description={t(
          "To take a picture of a window, macOS needs you to allow Screen Recording. It asks for Sub Rosa Dictation Helper, the part of Sub Rosa that reads the window you are in, and lists it under that name in System Settings.",
        )}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setExplaining(false)}
            >
              {t("Not now")}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void allowPictures()}>
              {t("Continue")}
            </button>
          </>
        }
      >
        <p className="settings-row-description">
          {t(
            "Sub Rosa only takes a picture when you click the picture button, of the window you were in, never of the whole screen, and it is attached to your message where you can remove it.",
          )}
        </p>
      </Dialog>
    </div>
  );
}
