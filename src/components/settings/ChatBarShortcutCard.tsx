import { t } from "../../lib/i18n";
import { useEffect, useState } from "react";
import {
  type ChatBarSettings,
  type ChatBarSettingsResponse,
  chatBarSettings,
  saveChatBarSettings,
  shortcutFromKeyboardEvent,
} from "../../lib/chat-bar";
import { messageFromError } from "../../lib/errors";
import { isMacDesktopPlatform } from "../../lib/platform";
import { KeycapShortcut } from "../shortcuts/KeycapShortcut";
import { Switch } from "../ui/Switch";

/**
 * Settings › Shortcuts: the chat bar's shortcut (ADR-0094). Captured from the
 * focused window's own key events, so no global monitoring is involved; the
 * backend refuses a chord the system or dictation already holds.
 */
export function ChatBarShortcutCard() {
  const [state, setState] = useState<ChatBarSettingsResponse | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.resolve()
      .then(() => chatBarSettings())
      .then((next) => {
        if (next?.settings) setState(next);
      })
      .catch(() => {
        // A build without the chat bar shows nothing here.
      });
  }, []);

  useEffect(() => {
    if (!capturing || !state) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        setCapturing(false);
        return;
      }
      const shortcut = shortcutFromKeyboardEvent(event, isMacDesktopPlatform());
      if (!shortcut) return;
      setCapturing(false);
      void save({ ...state.settings, shortcut });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  if (!state) return null;

  async function save(next: ChatBarSettings) {
    setError(null);
    try {
      setState(await saveChatBarSettings(next));
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  const { settings, defaultShortcut } = state;
  const isDefault = settings.shortcut.label === defaultShortcut.label;

  return (
    <div className="settings-card">
      <div className="settings-rows">
        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title" id="chat-bar-enabled">
              {t("Chat bar")}
            </h3>
            <p className="settings-row-description">
              {t(
                "Press this shortcut anywhere to ask Sub Rosa something without leaving what you are doing.",
              )}
            </p>
            {error ? <p className="settings-row-error">{error}</p> : null}
          </div>
          <div className="settings-row-control">
            <KeycapShortcut label={settings.shortcut.label} capturing={capturing} />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!settings.enabled}
              onClick={() => {
                setError(null);
                setCapturing((current) => !current);
              }}
            >
              {capturing ? t("Cancel") : t("Change")}
            </button>
            {!isDefault && !capturing ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void save({ ...settings, shortcut: defaultShortcut })}
              >
                {t("Reset")}
              </button>
            ) : null}
            <Switch
              checked={settings.enabled}
              onCheckedChange={(enabled) => void save({ ...settings, enabled })}
              aria-labelledby="chat-bar-enabled"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
