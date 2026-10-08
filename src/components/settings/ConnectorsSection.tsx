import { useCallback } from "react";
import type { Connector } from "../../lib/connectors";
import { useConnectors } from "../../lib/connectors";
import { useMcpServers } from "../../lib/hermes-admin";
import { t } from "../../lib/i18n";
import { ConnectorsPanel } from "../connectors/ConnectorsPanel";
import { SkillPacksPanel } from "../connectors/SkillPacksPanel";

/**
 * Settings › Connectors on the computer (ADR-0092 and its addendum). One
 * catalog for every shell: a connector is signed in here, in the app, and
 * the computer's agent reaches it through the app's own `subrosa_connectors`
 * server, under the same rules as the phones. Skill packs sit beside it, for
 * the same reason.
 */
export function ConnectorsSection() {
  const model = useConnectors();
  const servers = useMcpServers("sandboxed");
  // Before the addendum, connecting from the catalog also wrote the server
  // into the agent's own MCP list. Removing the connector removes that copy
  // too, when it is still the catalog's (same name, same address).
  const onRemoved = useCallback(
    async (connector: Connector) => {
      const legacy = servers.servers.find(
        (server) =>
          connector.catalogId !== "" &&
          server.name === connector.catalogId &&
          server.url === connector.url,
      );
      if (legacy) await servers.remove(legacy.name);
    },
    [servers],
  );
  return (
    <section className="settings-group" aria-labelledby="connectors-heading">
      <h2 id="connectors-heading" className="settings-group-heading">
        {t("Connectors")}
      </h2>
      <p className="settings-group-description">
        {t(
          "Let the assistant read and act in your other services. Actions that change something ask you first, unless you allow them. On this computer the agent uses the same connectors and the same rules, through Sub Rosa.",
        )}
      </p>
      <div className="settings-card">
        <ConnectorsPanel
          connectors={model.connectors}
          catalog={model.catalog}
          refresh={model.refresh}
          onRemoved={onRemoved}
        />
      </div>
      <h2 className="settings-group-heading">{t("Skill packs")}</h2>
      <p className="settings-group-description">
        {t(
          "Instructions the assistant can follow on any device. Type a skill's name after a slash on the phone to use it. They sync with your account.",
        )}
      </p>
      <div className="settings-card">
        <SkillPacksPanel />
      </div>
    </section>
  );
}
