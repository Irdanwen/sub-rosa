import { useEffect, useState } from "react";
import { type Connector, connectorList, connectorReady } from "../../lib/connectors";
import { t } from "../../lib/i18n";

/**
 * The connectors a deep research run may search (ADR-0092), picked when it
 * starts. Only connectors signed in on this device are offered, and none is
 * ticked by default: a report reads someone's mail only when they say so.
 */
export function ResearchConnectorPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [ready, setReady] = useState<Connector[]>([]);
  useEffect(() => {
    let cancelled = false;
    connectorList()
      .then((list) => {
        if (!cancelled) setReady(list.filter(connectorReady));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  if (ready.length === 0) return null;
  return (
    <fieldset className="research-depths" aria-label={t("Also search your connectors")}>
      <legend className="dialog-field-label">{t("Also search your connectors")}</legend>
      {ready.map((connector) => (
        <label key={connector.id} className="research-check">
          <input
            type="checkbox"
            checked={value.includes(connector.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, connector.id]
                  : value.filter((id) => id !== connector.id),
              )
            }
          />
          {connector.name}
        </label>
      ))}
    </fieldset>
  );
}
