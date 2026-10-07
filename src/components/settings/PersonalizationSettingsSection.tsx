import "../../styles/personalization.css";
import { useEffect, useId, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  PERSONALITIES,
  PERSONALIZATION_MAX_CHARS,
  type Personality,
  type PersonalizationSettings,
  personalizationGetSettings,
  personalizationSetSettings,
} from "../../lib/personalization";
import { Switch } from "../ui/Switch";

/**
 * Settings › Personalization (ADR-0081): what Sub Rosa should know about the
 * user, how it should answer, and a personality preset. It shapes the default
 * chat only; a custom assistant keeps its own instructions.
 *
 * The switch and the preset save as they change. The two texts are drafts
 * until "Save", so a half-typed sentence never reaches a chat.
 */
export function PersonalizationSettingsSection() {
  const [saved, setSaved] = useState<PersonalizationSettings | null>(null);
  const [aboutYou, setAboutYou] = useState("");
  const [responseStyle, setResponseStyle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const personalityId = useId();

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
      setError(undefined);
      setNotice(t("Saved. New chats use it."));
    } catch (caught) {
      setError(messageFromError(caught));
      setNotice(undefined);
    } finally {
      setSaving(false);
    }
  }

  const enabled = saved?.enabled === true;
  const dirty =
    saved !== null && (aboutYou !== saved.aboutYou || responseStyle !== saved.responseStyle);
  const tooLong =
    aboutYou.length > PERSONALIZATION_MAX_CHARS || responseStyle.length > PERSONALIZATION_MAX_CHARS;

  return (
    <section className="settings-group" aria-labelledby="personalization-heading">
      <h2 id="personalization-heading" className="settings-group-heading">
        {t("Personalization")}
      </h2>
      <p className="settings-group-description">
        {t(
          "Tell Sub Rosa about yourself and how you like answers. It applies to your chats, not to custom assistants, and stays on this device. Changes apply to new chats.",
        )}
      </p>
      <div className="settings-card">
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">{t("Use personalization")}</h3>
              <p className="settings-row-description">
                {t("Turning this off keeps what you wrote but stops using it.")}
              </p>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={enabled}
                disabled={saved === null || saving}
                onCheckedChange={(next) => saved && void save({ ...saved, enabled: next })}
                aria-label={t("Use personalization")}
              />
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <label htmlFor={personalityId} className="settings-row-title">
                {t("Personality")}
              </label>
              <p className="settings-row-description">
                {t("The tone Sub Rosa takes. Your own instructions below come first.")}
              </p>
            </div>
            <div className="settings-row-control">
              <select
                id={personalityId}
                className="mcp-tools-select"
                value={saved?.personality ?? "default"}
                disabled={saved === null || saving || !enabled}
                onChange={(event) =>
                  saved &&
                  void save({ ...saved, personality: event.currentTarget.value as Personality })
                }
              >
                {PERSONALITIES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {`${item.label} · ${item.detail}`}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>
      <div className="settings-card personalization-fields">
        <PersonalizationField
          label={t("What should Sub Rosa know about you?")}
          placeholder={t("e.g. I run a small bakery in Lyon and I am learning Spanish.")}
          value={aboutYou}
          disabled={saved === null || !enabled}
          onChange={setAboutYou}
        />
        <PersonalizationField
          label={t("How should Sub Rosa respond?")}
          placeholder={t("e.g. Answer in French, use bullet points, skip the disclaimers.")}
          value={responseStyle}
          disabled={saved === null || !enabled}
          onChange={setResponseStyle}
        />
        <div className="personalization-actions">
          {notice && !dirty ? (
            <p className="settings-row-description" role="status">
              {notice}
            </p>
          ) : null}
          <button
            type="button"
            className="primary-action primary-solid"
            disabled={!dirty || saving || tooLong}
            onClick={() => saved && void save({ ...saved, aboutYou, responseStyle })}
          >
            {t("Save")}
          </button>
        </div>
      </div>
      {error ? <p className="settings-row-error">{error}</p> : null}
    </section>
  );
}

function PersonalizationField({
  label,
  placeholder,
  value,
  disabled,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const counterId = useId();
  const over = value.length > PERSONALIZATION_MAX_CHARS;
  return (
    <div className="personalization-field">
      <label htmlFor={id} className="settings-row-title">
        {label}
      </label>
      <textarea
        id={id}
        className="dialog-textarea"
        rows={4}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={PERSONALIZATION_MAX_CHARS}
        aria-describedby={counterId}
        aria-invalid={over ? true : undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <span id={counterId} className="personalization-counter" data-over={over || undefined}>
        {t("{count} of {max}", { count: value.length, max: PERSONALIZATION_MAX_CHARS })}
      </span>
    </div>
  );
}
