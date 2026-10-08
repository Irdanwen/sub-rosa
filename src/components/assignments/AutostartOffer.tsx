import { useEffect, useState } from "react";
import { autostartEnabled, autostartSupported, setAutostartEnabled } from "../../lib/autostart";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";

const DISMISSED_KEY = "subrosa.assignments.autostartOfferDismissed";

function dismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Assignments run only while the app is open, and the menu bar counts. So
 * the first assignment is the moment to offer launch at login: the person has
 * just asked for something that needs the app running tomorrow morning.
 * Offered once; "Not now" is remembered, and the switch stays in Settings.
 */
export function AutostartOffer({ hasAssignments }: { hasAssignments: boolean }) {
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasAssignments || !autostartSupported() || dismissed()) {
      setVisible(false);
      return;
    }
    let live = true;
    void autostartEnabled()
      .then((enabled) => {
        if (live) setVisible(!enabled);
      })
      .catch(() => {
        if (live) setVisible(false);
      });
    return () => {
      live = false;
    };
  }, [hasAssignments]);

  if (!visible) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Without storage the offer comes back next time, which is harmless.
    }
    setVisible(false);
  };

  return (
    <aside className="assignment-notice" aria-label={t("Open at login")}>
      <p>
        {t(
          "Assignments run while Sub Rosa is open, in the menu bar too. Open it at login so tomorrow's runs happen even if you have not opened it yet.",
        )}
      </p>
      <div className="assignment-actions">
        <button
          type="button"
          className="assignment-button"
          data-tone="primary"
          onClick={() =>
            void setAutostartEnabled(true)
              .then(() => setVisible(false))
              .catch((caught) => setError(messageFromError(caught)))
          }
        >
          {t("Open at login")}
        </button>
        <button type="button" className="assignment-button" onClick={dismiss}>
          {t("Not now")}
        </button>
      </div>
      {error ? (
        <p className="assignment-error" role="alert">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
