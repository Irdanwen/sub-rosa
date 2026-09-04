import { t } from "../../lib/i18n";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconClipboard } from "central-icons/IconClipboard";
import { useState } from "react";
import { AUTOMATION_ADDRESSES } from "../../lib/automations";
import { PRODUCT_NAME } from "../../lib/branding";

/**
 * The app, from outside the app.
 *
 * Every destination the router understands is a plain URL, which means
 * Shortcuts can already drive Sub Rosa today with nothing but its "Open URL"
 * action — on the Action button, from Siri, on a schedule, or at the end of
 * somebody else's shortcut. That is what App Intents would buy for these
 * three verbs, without a Swift target, an app group, or a provisioning
 * change (see FORK_NOTES for what the native route would actually cost).
 *
 * So the job here is discoverability: the addresses exist, and nobody can
 * guess them.
 */
const AUTOMATIONS = AUTOMATION_ADDRESSES;

export function AutomationsSection() {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      window.setTimeout(() => setCopied((current) => (current === url ? null : current)), 1600);
    } catch {
      // Copying is the convenience, not the feature: the address is on screen.
    }
  };

  return (
    <div className="settings-card">
      <div className="settings-rows">
        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">{t("Shortcuts and Siri")}</h3>
            <p className="settings-row-description">
              {t(
                '{PRODUCT_NAME} answers to addresses. Put one in a Shortcuts "Open URL" action and you can start a recording from the Action button, from Siri, or from the end of any shortcut you already use.',
                { PRODUCT_NAME },
              )}
            </p>
          </div>
        </div>
        {AUTOMATIONS.map((automation) => (
          <div className="settings-row" key={automation.url}>
            <div className="settings-row-info">
              <h3 className="settings-row-title">{automation.label}</h3>
              <p className="settings-row-description">{automation.detail}</p>
              <p className="automation-url">
                <code>{automation.url}</code>
              </p>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void copy(automation.url)}
              >
                {copied === automation.url ? (
                  <IconCheckmark1Small size={13} />
                ) : (
                  <IconClipboard size={13} />
                )}
                {copied === automation.url ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
