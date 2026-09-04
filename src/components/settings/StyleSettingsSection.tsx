import { t } from "../../lib/i18n";
import { useEffect, useState } from "react";
import { dictationSettings, setDictationStyle } from "../../lib/tauri";
import type { DictationStyle } from "../../lib/tauri";
import { SegmentedControl } from "../ui/SegmentedControl";

const STYLE_OPTIONS = [
  { value: "standard" as const, label: t("Standard") },
  { value: "casualLowercase" as const, label: t("Casual") },
  { value: "formal" as const, label: t("Formal") },
];

const SAMPLES: Record<DictationStyle, { description: string; sample: string }> = {
  standard: {
    description: t("Sentence case with light cleanup. Keeps your natural tone."),
    sample:
      "Got it. Let me know when you're free to chat about the Q3 plan. Happy to jump on in the morning.",
  },
  casualLowercase: {
    description: t("Lowercase sentences, contractions, minimal cleanup."),
    sample:
      "got it. let me know when you're free to chat about the q3 plan. happy to jump on in the morning.",
  },
  formal: {
    description: t("Full words and conventional capitalization. Keeps your wording."),
    sample:
      "Got it. Let me know when you are free to chat about the Q3 plan. Happy to jump on in the morning.",
  },
};

export function StyleSettingsSection() {
  const [style, setStyle] = useState<DictationStyle>("standard");
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    dictationSettings()
      .then((response) => {
        if (!cancelled) setStyle(response.settings.style);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(messageFromError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function selectStyle(nextStyle: DictationStyle) {
    setStyle(nextStyle);
    try {
      const next = await setDictationStyle(nextStyle);
      setStyle(next.style);
      setError(undefined);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  const current = SAMPLES[style];

  return (
    <section className="settings-group" aria-labelledby="style-heading">
      <h2 id="style-heading" className="settings-group-heading">
        {t("Style")}
      </h2>
      <div className="settings-card">
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">{t("Output style")}</h3>
              <p className="settings-row-description">{current.description}</p>
              {error ? <p className="settings-row-error">{error}</p> : null}
            </div>
            <div className="settings-row-control">
              <SegmentedControl
                value={style}
                onValueChange={(value) => void selectStyle(value)}
                options={STYLE_OPTIONS}
                aria-label={t("Dictation style")}
              />
            </div>
          </div>
        </div>
        <div className="style-preview" aria-live="polite">
          <p className="style-preview-text">{current.sample}</p>
        </div>
      </div>
    </section>
  );
}

function messageFromError(caught: unknown) {
  if (caught && typeof caught === "object" && "message" in caught) {
    return String((caught as { message: unknown }).message);
  }
  return String(caught);
}
