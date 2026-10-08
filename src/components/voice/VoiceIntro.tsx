// What the person reads before their first voice conversation: how it
// works, what a minute costs, and (on a computer without echo
// cancellation) why headphones help. Shown once per device.

import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import type { VoiceCost } from "../../lib/voice/voice-cost";
import { fetchVoiceCost } from "../../lib/voice/voice-setup";

const INTRO_KEY = "subrosa:voice-intro-seen";

export function voiceIntroSeen(): boolean {
  try {
    return localStorage.getItem(INTRO_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberVoiceIntro() {
  try {
    localStorage.setItem(INTRO_KEY, "1");
  } catch {
    // Shown again next time; nothing else depends on it.
  }
}

/** The sentence that prices a minute of conversation. */
export function voiceCostSentence(cost: VoiceCost): string {
  return cost.creditsPerMinute !== undefined
    ? t(
        "About {credits} credits a minute for listening and speaking, plus the replies themselves.",
        {
          credits: cost.creditsPerMinute,
        },
      )
    : t(
        "Listening is priced by the second and speaking by the character, plus the replies themselves.",
      );
}

export function VoiceIntro({
  headphones,
  onStart,
  onCancel,
}: {
  /** Suggest headphones (no echo cancellation on this shell). */
  headphones: boolean;
  onStart: () => void;
  onCancel: () => void;
}) {
  const [cost, setCost] = useState<VoiceCost | null>(null);
  useEffect(() => {
    let live = true;
    void fetchVoiceCost()
      .catch(() => ({}))
      .then((value) => {
        if (live) setCost(value);
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="voice-intro">
      <h2 className="voice-intro-title">{t("Talk instead of typing")}</h2>
      <p>
        {t(
          "Speak naturally. The assistant listens, answers out loud, and stops when you talk over it. Your conversation is saved as a normal chat.",
        )}
      </p>
      <p className="voice-intro-cost">
        {cost ? voiceCostSentence(cost) : t("Checking the price…")}
      </p>
      {headphones ? (
        <p className="voice-intro-hint">
          {t("Use headphones if you can: without them, talking over a reply takes a louder voice.")}
        </p>
      ) : null}
      <div className="voice-intro-actions">
        <button type="button" className="voice-secondary" onClick={onCancel}>
          {t("Not now")}
        </button>
        <button type="button" className="voice-primary" onClick={onStart}>
          {t("Start talking")}
        </button>
      </div>
    </div>
  );
}
