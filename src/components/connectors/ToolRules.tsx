import { type Connector, type ToolRule, connectorSetToolPolicy } from "../../lib/connectors";
import { t } from "../../lib/i18n";

function ruleLabel(rule: ToolRule): string {
  if (rule === "allow") return t("Allow");
  if (rule === "ask") return t("Ask first");
  return t("Off");
}

/**
 * What each of a connector's tools may do: run, ask first, or never. The
 * same three choices on both shells; a tool the person has not chosen for
 * follows its server's hint (reading runs, anything else asks).
 */
export function ToolRules({
  connector,
  onChanged,
}: {
  connector: Connector;
  onChanged: (next: Connector) => void;
}) {
  if (connector.tools.length === 0) {
    return (
      <p className="connectors-row-meta">
        {connector.signedIn
          ? t("No tools listed yet.")
          : t("Sign in to see what this connector can do.")}
      </p>
    );
  }
  return (
    <ul className="connectors-tools">
      {connector.tools.map((tool) => (
        <li key={tool.name} className="connectors-tool">
          <span className="connectors-row-body">
            <span className="connectors-row-title">{tool.title ?? tool.name}</span>
            {tool.description ? (
              <span className="connectors-row-meta">{tool.description.slice(0, 160)}</span>
            ) : null}
          </span>
          <select
            className="connectors-input"
            aria-label={t("Rule for {tool}", { tool: tool.title ?? tool.name })}
            value={tool.rule}
            onChange={(event) =>
              void connectorSetToolPolicy(
                connector.id,
                tool.name,
                event.currentTarget.value as ToolRule,
              ).then(onChanged)
            }
          >
            {(["allow", "ask", "deny"] as const).map((rule) => (
              <option key={rule} value={rule}>
                {ruleLabel(rule)}
              </option>
            ))}
          </select>
        </li>
      ))}
    </ul>
  );
}

/** What a connector's row says about its state. */
export function connectorStateLabel(connector: Connector): { text: string; error: boolean } {
  if (!connector.enabled) return { text: t("Turned off"), error: false };
  if (connector.status === "needs_sign_in")
    return { text: t("Sign in again to keep using it"), error: true };
  if (connector.status === "error" && connector.lastError)
    return { text: t(connector.lastError), error: true };
  if (!connector.signedIn) return { text: t("Not signed in on this device"), error: false };
  const count = connector.tools.length;
  return {
    text: count === 1 ? t("Connected, 1 tool") : t("Connected, {count} tools", { count }),
    error: false,
  };
}
