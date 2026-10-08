import "../../styles/connectors.css";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useCallback, useEffect, useState } from "react";
import {
  type Connector,
  type ConnectorTrigger,
  connectorList,
  connectorReady,
  connectorTriggerDelete,
  connectorTriggerSave,
  connectorTriggers,
  triggerKindsFor,
} from "../../lib/connectors";
import { friendlyErrorMessage } from "../../lib/errors";
import { t } from "../../lib/i18n";

/** An example address, not copy: resource addresses are the server's. */
const RESOURCE_EXAMPLE = "file:///";

function kindLabel(kind: ConnectorTrigger["kind"]): string {
  switch (kind) {
    case "calendar_event":
      return t("A new calendar event");
    case "email_match":
      return t("A new message matching a search");
    case "tool_poll":
      return t("A new item in a list");
    default:
      return t("A change the service reports");
  }
}

/** What a trigger watches, in a sentence. */
export function describeTrigger(trigger: ConnectorTrigger, connectors: Connector[]): string {
  const name =
    connectors.find((connector) => connector.id === trigger.connectorId)?.name ??
    trigger.connectorId;
  const detail =
    typeof trigger.config.query === "string"
      ? trigger.config.query
      : typeof trigger.config.tool === "string"
        ? trigger.config.tool
        : typeof trigger.config.uri === "string"
          ? trigger.config.uri
          : "";
  return detail
    ? t("{kind} in {name}: {detail}", { kind: kindLabel(trigger.kind), name, detail })
    : t("{kind} in {name}", { kind: kindLabel(trigger.kind), name });
}

/**
 * "When this happens" for an assignment (ADR-0092): connector events that
 * start a run, looked at while the app is open on the device that runs it.
 * The first look only learns what is already there.
 */
export function ConnectorTriggers({ assignmentId }: { assignmentId: string }) {
  const [triggers, setTriggers] = useState<ConnectorTrigger[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [connectorId, setConnectorId] = useState("");
  const [kind, setKind] = useState<ConnectorTrigger["kind"] | "">("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    connectorTriggers(assignmentId)
      .then(setTriggers)
      .catch(() => setTriggers([]));
  }, [assignmentId]);

  useEffect(() => {
    load();
    connectorList()
      .then((list) => setConnectors(list.filter(connectorReady)))
      .catch(() => setConnectors([]));
  }, [load]);

  const connector = connectors.find((item) => item.id === connectorId);
  const kinds = connector ? triggerKindsFor(connector) : [];
  const listingTools = (connector?.tools ?? []).filter((tool) => tool.readOnly);

  const save = async () => {
    if (!connector || !kind) return;
    const config: Record<string, unknown> =
      kind === "email_match"
        ? { query: value }
        : kind === "tool_poll"
          ? { tool: value }
          : kind === "resource_updated"
            ? { uri: value }
            : { days: 7 };
    try {
      await connectorTriggerSave({ assignmentId, connectorId: connector.id, kind, config });
      setValue("");
      setKind("");
      setError(null);
      load();
    } catch (cause) {
      setError(friendlyErrorMessage(cause, t("This trigger could not be saved.")));
    }
  };

  if (connectors.length === 0 && triggers.length === 0) return null;
  return (
    <section className="assignment-section" aria-label={t("When this happens")}>
      <h2 className="assignment-section-title">{t("When this happens")}</h2>
      <p className="assignment-meta">
        {t(
          "Run this when a connected service reports something new, while Sub Rosa is open on the device that runs it.",
        )}
      </p>
      <ul className="connectors-list">
        {triggers.map((trigger) => (
          <li key={trigger.id} className="connectors-row">
            <span className="connectors-row-body">
              <span className="connectors-row-title">{describeTrigger(trigger, connectors)}</span>
              {trigger.lastError ? (
                <span className="connectors-row-meta" data-tone="error">
                  {t(trigger.lastError)}
                </span>
              ) : !trigger.armed ? (
                <span className="connectors-row-meta">{t("Learning what is already there")}</span>
              ) : null}
            </span>
            <button
              type="button"
              className="proposal-do"
              aria-label={t("Remove this trigger")}
              onClick={() => void connectorTriggerDelete(trigger.id).then(load)}
            >
              <IconTrashCan size={14} />
            </button>
          </li>
        ))}
      </ul>
      {connectors.length > 0 ? (
        <div className="connectors-form">
          <select
            className="connectors-input"
            aria-label={t("Connector")}
            value={connectorId}
            onChange={(event) => {
              setConnectorId(event.currentTarget.value);
              setKind("");
              setValue("");
            }}
          >
            <option value="">{t("Choose a connector")}</option>
            {connectors.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          {connector ? (
            <select
              className="connectors-input"
              aria-label={t("What starts it")}
              value={kind}
              onChange={(event) => {
                setKind(event.currentTarget.value as ConnectorTrigger["kind"]);
                setValue("");
              }}
            >
              <option value="">{t("Choose what starts it")}</option>
              {kinds.map((item) => (
                <option key={item} value={item}>
                  {kindLabel(item)}
                </option>
              ))}
            </select>
          ) : null}
          {kind === "email_match" || kind === "resource_updated" ? (
            <input
              className="connectors-input"
              aria-label={kind === "email_match" ? t("Search") : t("Resource address")}
              placeholder={kind === "email_match" ? t("from:billing invoice") : RESOURCE_EXAMPLE}
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          ) : null}
          {kind === "tool_poll" ? (
            <select
              className="connectors-input"
              aria-label={t("The list to watch")}
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            >
              <option value="">{t("Choose a tool that lists things")}</option>
              {listingTools.map((tool) => (
                <option key={tool.name} value={tool.name}>
                  {tool.title ?? tool.name}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            className="proposal-do"
            disabled={!kind || (kind !== "calendar_event" && !value.trim())}
            onClick={() => void save()}
          >
            {t("Add trigger")}
          </button>
          {error ? (
            <p className="connectors-row-meta" data-tone="error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
