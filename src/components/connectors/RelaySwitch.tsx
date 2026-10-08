import { useEffect, useState } from "react";
import { connectorRelaySetEnabled, connectorRelaySettings } from "../../lib/connector-relay";
import { t } from "../../lib/i18n";
import { Switch } from "../ui/Switch";

/**
 * "Run connectors for my browser" (ADR-0107). The machine that makes the
 * calls is the one whose sign-ins act, so the decision belongs here and
 * starts as no, as for errands (ADR-0054).
 */
export function RelaySwitch() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void connectorRelaySettings()
      .then((value) => active && setEnabled(value.enabled))
      .catch(() => active && setEnabled(false));
    return () => {
      active = false;
    };
  }, []);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError("");
    try {
      setEnabled((await connectorRelaySetEnabled(next)).enabled);
    } catch {
      setError(t("The setting could not be saved. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connectors-row">
      <span className="connectors-row-body">
        <span className="connectors-row-title">{t("Run connectors for my browser")}</span>
        <span className="connectors-row-meta">
          {t(
            "Some services refuse a web page. With this on, Sub Rosa on the web asks this device to make their calls, while it is open, under the rules you set here.",
          )}
        </span>
        {error ? (
          <span className="connectors-row-meta" data-tone="error" role="alert">
            {error}
          </span>
        ) : null}
      </span>
      <Switch
        checked={enabled === true}
        disabled={enabled === null || busy}
        aria-label={t("Run connectors for my browser")}
        onCheckedChange={(next) => void toggle(next)}
      />
    </div>
  );
}
