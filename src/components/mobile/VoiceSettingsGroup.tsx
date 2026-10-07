import { useState } from "react";
import { t } from "../../lib/i18n";
import { useVoiceSettings } from "../../lib/use-voice-settings";
import { OptionSheet } from "./OptionSheet";
import { SettingsActionRow, SettingsGroup, SettingsLinkRow, SettingsRow } from "./SettingsList";

/**
 * The read-aloud voice on the phone: the same choice as the desktop's
 * Personalization tab (voice-preference.ts), for Read aloud on a reply and a
 * note's spoken recap. Saved on this device as it changes.
 */
export function VoiceSettingsGroup() {
  const voice = useVoiceSettings();
  const [picking, setPicking] = useState<"engine" | "voice" | null>(null);
  const current = voice.current;
  const previewActive = voice.preview === "playing" || voice.preview === "loading";

  return (
    <>
      <SettingsGroup
        title={t("Read-aloud voice")}
        footer={
          voice.error
            ? t("The voices could not be loaded. {reason}", { reason: voice.error })
            : voice.preview === "failed"
              ? t("The preview could not be played. Try again.")
              : t("Reads your replies and notes aloud. It stays on this device.")
        }
      >
        {current ? (
          <>
            <SettingsLinkRow
              label={t("Voice engine")}
              value={current.engine.name}
              onClick={() => setPicking("engine")}
            />
            {current.voices.length > 0 ? (
              <SettingsLinkRow
                label={t("Voice")}
                value={current.voice}
                onClick={() => setPicking("voice")}
              />
            ) : null}
            <SettingsActionRow
              label={
                voice.preview === "loading"
                  ? t("Preparing the preview…")
                  : previewActive
                    ? t("Stop the preview")
                    : t("Listen to a preview")
              }
              onClick={voice.togglePreview}
            />
          </>
        ) : (
          <SettingsRow label={voice.loading ? t("Loading…") : t("No voice is available")} />
        )}
      </SettingsGroup>
      {picking === "engine" && current ? (
        <OptionSheet
          title={t("Voice engine")}
          options={voice.engines.map((engine) => ({ value: engine.id, label: engine.name }))}
          selected={current.engine.id}
          onSelect={(value) => {
            setPicking(null);
            voice.chooseEngine(value);
          }}
          onClose={() => setPicking(null)}
        />
      ) : null}
      {picking === "voice" && current ? (
        <OptionSheet
          title={t("Voice")}
          options={current.voices.map((entry) => ({ value: entry, label: entry }))}
          selected={current.voice ?? ""}
          onSelect={(value) => {
            setPicking(null);
            voice.chooseVoice(value);
          }}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </>
  );
}
