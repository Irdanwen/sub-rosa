import { type AssistantTool, connectorIdOf, connectorPermission } from "../../lib/assistants";
import { useConnectors } from "../../lib/connectors";
import { t } from "../../lib/i18n";

/** One connector an assistant may be given, and whether it has it. */
export type ConnectorChoice = {
  id: string;
  name: string;
  granted: boolean;
  toggle: (next: boolean) => void;
};

/**
 * The connectors an assistant may use (ADR-0092 addendum): its "Connectors"
 * permission is one `connector:<id>` entry per connector in its tools, read
 * by the native turn on every shell. Only connectors this account has are
 * offered; a grant whose connector was removed simply reaches nothing.
 */
export function useConnectorChoices(
  tools: AssistantTool[],
  onChange: (tools: AssistantTool[]) => void,
): ConnectorChoice[] | null {
  const { connectors } = useConnectors();
  if (!connectors) return null;
  const granted = new Set(tools.map(connectorIdOf).filter((id): id is string => id !== null));
  return connectors.map((connector) => ({
    id: connector.id,
    name: connector.name,
    granted: granted.has(connector.id),
    toggle: (next: boolean) => {
      const permission = connectorPermission(connector.id);
      onChange(
        next
          ? [...tools.filter((tool) => tool !== permission), permission]
          : tools.filter((tool) => tool !== permission),
      );
    },
  }));
}

export function connectorChoicesNote(): string {
  return t(
    "Tick the connectors this assistant may use. Their rules stay the ones you set in Settings, Connectors.",
  );
}

export function noConnectorsNote(): string {
  return t("Add a connector in Settings, Connectors, to let an assistant use it.");
}

/** The desktop editor's section, in its checkbox style. */
export function AssistantConnectors({
  tools,
  onChange,
}: {
  tools: AssistantTool[];
  onChange: (tools: AssistantTool[]) => void;
}) {
  const choices = useConnectorChoices(tools, onChange);
  return (
    <>
      <hr />
      <p className="assistant-muted">
        <strong>{t("Connectors")}</strong>
        <br />
        {choices && choices.length === 0 ? noConnectorsNote() : connectorChoicesNote()}
      </p>
      {(choices ?? []).map((choice) => (
        <label className="assistant-option" key={choice.id}>
          <input
            type="checkbox"
            checked={choice.granted}
            onChange={(event) => choice.toggle(event.target.checked)}
          />
          <span>
            <strong>{choice.name}</strong>
            <small>{t("Read and act in {name} under your rules.", { name: choice.name })}</small>
          </span>
        </label>
      ))}
    </>
  );
}
