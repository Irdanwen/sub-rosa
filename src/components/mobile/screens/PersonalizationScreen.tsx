import "../../../styles/personalization.css";
import { useEffect, useId, useState } from "react";
import { messageFromError } from "../../../lib/errors";
import { t } from "../../../lib/i18n";
import {
  PERSONALITIES,
  PERSONALIZATION_MAX_CHARS,
  type Personality,
  type PersonalizationSettings,
  personalityLabel,
  personalizationGetSettings,
  personalizationSetSettings,
} from "../../../lib/personalization";
import { OptionSheet } from "../OptionSheet";
import { SettingsGroup, SettingsLinkRow, SettingsRow, SettingsToggleRow } from "../SettingsList";
import { StackHeader } from "../StackHeader";

/**
 * Personalization on the phone (ADR-0081): the same three settings as the
 * desktop tab. The phone rebuilds its prompt every turn, so a saved change
 * applies from the next message.
 */
export function PersonalizationScreen({ onBack }: { onBack: () => void }) {
  const [saved, setSaved] = useState<PersonalizationSettings | null>(null);
  const [aboutYou, setAboutYou] = useState("");
  const [responseStyle, setResponseStyle] = useState("");
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    personalizationGetSettings()
      .then((settings) => {
        if (cancelled) return;
        setSaved(settings);
        setAboutYou(settings.aboutYou);
        setResponseStyle(settings.responseStyle);
      })
      .catch((caught) => {
        if (!cancelled) setError(messageFromError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(next: PersonalizationSettings) {
    setSaving(true);
    try {
      const stored = await personalizationSetSettings(next);
      setSaved(stored);
      setAboutYou(stored.aboutYou);
      setResponseStyle(stored.responseStyle);
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSaving(false);
    }
  }

  const enabled = saved?.enabled === true;
  const dirty =
    saved !== null && (aboutYou !== saved.aboutYou || responseStyle !== saved.responseStyle);

  return (
    <div className="mobile-screen-root">
      <StackHeader title={t("Personalization")} onBack={onBack} backLabel={t("Settings")} />
      <div className="mobile-settings-scroll">
        <SettingsGroup
          footer={t(
            "Applies to your chats from your next message, not to custom assistants. It stays on this device.",
          )}
        >
          <SettingsToggleRow
            label={t("Use personalization")}
            checked={enabled}
            disabled={saved === null || saving}
            onChange={(next) => saved && void save({ ...saved, enabled: next })}
          />
          {enabled ? (
            <SettingsLinkRow
              label={t("Personality")}
              value={personalityLabel(saved?.personality ?? "default")}
              onClick={() => setPicking(true)}
            />
          ) : null}
        </SettingsGroup>

        <MobileField
          title={t("What should Sub Rosa know about you?")}
          placeholder={t("e.g. I run a small bakery in Lyon and I am learning Spanish.")}
          value={aboutYou}
          disabled={saved === null || !enabled}
          onChange={setAboutYou}
        />
        <MobileField
          title={t("How should Sub Rosa respond?")}
          placeholder={t("e.g. Answer in French, use bullet points, skip the disclaimers.")}
          value={responseStyle}
          disabled={saved === null || !enabled}
          onChange={setResponseStyle}
        />

        <SettingsGroup>
          <SettingsRow align="stack">
            <button
              type="button"
              className="personalization-mobile-save"
              disabled={!dirty || saving}
              onClick={() => saved && void save({ ...saved, aboutYou, responseStyle })}
            >
              {t("Save")}
            </button>
          </SettingsRow>
        </SettingsGroup>

        {error ? <p className="mobile-memory-error">{error}</p> : null}
      </div>
      {picking && saved ? (
        <OptionSheet
          title={t("Personality")}
          options={PERSONALITIES.map((item) => ({
            value: item.id,
            label: `${item.label} · ${item.detail}`,
          }))}
          selected={saved.personality}
          onSelect={(value) => {
            setPicking(false);
            void save({ ...saved, personality: value as Personality });
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}

function MobileField({
  title,
  placeholder,
  value,
  disabled,
  onChange,
}: {
  title: string;
  placeholder: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const counterId = useId();
  return (
    <SettingsGroup title={title}>
      <SettingsRow align="stack">
        <div className="personalization-mobile-field">
          <textarea
            id={id}
            aria-label={title}
            aria-describedby={counterId}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            maxLength={PERSONALIZATION_MAX_CHARS}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
          <span id={counterId} className="personalization-counter">
            {t("{count} of {max}", { count: value.length, max: PERSONALIZATION_MAX_CHARS })}
          </span>
        </div>
      </SettingsRow>
    </SettingsGroup>
  );
}
