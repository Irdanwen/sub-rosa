import { IconSpeaker } from "central-icons/IconSpeaker";
import { IconStop } from "central-icons/IconStop";
import { useId } from "react";
import { t } from "../../lib/i18n";
import { useVoiceSettings } from "../../lib/use-voice-settings";
import { Spinner } from "../ui/Spinner";

/**
 * The voice Sub Rosa reads aloud with (voice-preference.ts): an engine, one of
 * its voices, and a short preview. One choice for Read aloud on a reply and
 * for a note's spoken recap. Saved on this device as it changes.
 */
export function VoiceSettingsCard() {
  const voice = useVoiceSettings();
  const engineId = useId();
  const voiceId = useId();
  const current = voice.current;
  const previewActive = voice.preview === "playing" || voice.preview === "loading";

  return (
    <div className="settings-card voice-settings">
      <div className="settings-rows">
        <div className="settings-row">
          <div className="settings-row-info">
            <label htmlFor={engineId} className="settings-row-title">
              {t("Read-aloud voice")}
            </label>
            <p className="settings-row-description">
              {t("Reads your replies and notes aloud. It stays on this device.")}
            </p>
          </div>
          <div className="settings-row-control">
            <select
              id={engineId}
              className="mcp-tools-select"
              aria-label={t("Voice engine")}
              value={current?.engine.id ?? ""}
              disabled={!current}
              onChange={(event) => voice.chooseEngine(event.currentTarget.value)}
            >
              {voice.loading ? <option value="">{t("Loading…")}</option> : null}
              {voice.engines.map((engine) => (
                <option key={engine.id} value={engine.id}>
                  {engine.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {current && current.voices.length > 0 ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <label htmlFor={voiceId} className="settings-row-title">
                {t("Voice")}
              </label>
            </div>
            <div className="settings-row-control">
              <select
                id={voiceId}
                className="mcp-tools-select"
                value={current.voice ?? ""}
                onChange={(event) => voice.chooseVoice(event.currentTarget.value)}
              >
                {current.voices.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}
        {current ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">{t("Preview")}</h3>
              <p className="settings-row-description">
                {t("One short sentence in this voice, billed like any reading.")}
              </p>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                className="btn btn-secondary voice-settings-preview"
                aria-pressed={previewActive}
                onClick={voice.togglePreview}
              >
                {voice.preview === "loading" ? (
                  <Spinner aria-hidden />
                ) : previewActive ? (
                  <IconStop size={14} aria-hidden />
                ) : (
                  <IconSpeaker size={14} aria-hidden />
                )}
                <span>{previewActive ? t("Stop") : t("Listen")}</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {voice.preview === "failed" ? (
        <p className="settings-row-error">{t("The preview could not be played. Try again.")}</p>
      ) : null}
      {voice.error ? (
        <p className="settings-row-error">
          {t("The voices could not be loaded. {reason}", { reason: voice.error })}
        </p>
      ) : null}
    </div>
  );
}
