// The explanation before the screen is shared for the first time: what is
// taken, when, and what the system asks. macOS asks for Screen Recording;
// Windows asks nothing, so this explanation is the whole consent there.

import { t } from "../../lib/i18n";
import { isMacDesktopPlatform } from "../../lib/platform";

const SCREEN_INTRO_KEY = "subrosa:voice-screen-intro-seen";

export function screenIntroSeen(): boolean {
  try {
    return localStorage.getItem(SCREEN_INTRO_KEY) === "1";
  } catch {
    return false;
  }
}

export function ScreenShareIntro({
  onShare,
  onCancel,
}: {
  onShare: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="voice-sheet" aria-labelledby="voice-screen-intro-title">
      <h2 id="voice-screen-intro-title" className="voice-intro-title">
        {t("Share your screen")}
      </h2>
      <p>
        {t(
          "Each time you finish speaking, one picture of your screen goes with what you said, without this app's own windows. Nothing is recorded in between.",
        )}
      </p>
      <p className="voice-intro-hint">
        {isMacDesktopPlatform()
          ? t(
              "The first time, macOS asks to allow Screen Recording. Allow it in System Settings, then share again.",
            )
          : t(
              "Windows does not ask for permission. Turn sharing off whenever something private is on screen.",
            )}
      </p>
      <div className="voice-intro-actions">
        <button type="button" className="voice-secondary" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button
          type="button"
          className="voice-primary"
          onClick={() => {
            try {
              localStorage.setItem(SCREEN_INTRO_KEY, "1");
            } catch {
              // Explained again next time.
            }
            onShare();
          }}
        >
          {t("Share screen")}
        </button>
      </div>
    </section>
  );
}
