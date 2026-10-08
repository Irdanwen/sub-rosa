import { useMemo } from "react";
import { useConnectors } from "../../lib/connectors";
import { useMcpServers } from "../../lib/hermes-admin";
import { t } from "../../lib/i18n";
import { hermesMcpOauthLogin } from "../../lib/tauri";
import { ConnectorsPanel, type HermesConnectorBridge } from "../connectors/ConnectorsPanel";
import { SkillPacksPanel } from "../connectors/SkillPacksPanel";

/**
 * Settings › Connectors on the computer (ADR-0092). One catalog for both
 * shells: connecting here writes the agent runtime's MCP server list (and
 * signs in there) and files the connector's definition, which reaches the
 * phones through the account. Skill packs sit beside it, for the same reason.
 */
export function ConnectorsSection() {
  const model = useConnectors();
  const servers = useMcpServers("sandboxed");
  const hermes = useMemo<HermesConnectorBridge | null>(() => {
    if (servers.status !== "ready") return null;
    return {
      has: (name) => servers.servers.some((server) => server.name === name),
      add: (server) =>
        servers.add({
          name: server.id,
          url: server.url,
          ...(server.auth === "oauth" ? { auth: "oauth" } : {}),
        }),
      signIn: (name) => hermesMcpOauthLogin({ mode: "sandboxed", server: name }),
    };
  }, [servers]);
  return (
    <section className="settings-group" aria-labelledby="connectors-heading">
      <h2 id="connectors-heading" className="settings-group-heading">
        {t("Connectors")}
      </h2>
      <p className="settings-group-description">
        {t(
          "Let the assistant read and act in your other services. Actions that change something ask you first, unless you allow them. On this computer, connecting also adds the server to the agent's MCP servers.",
        )}
      </p>
      <div className="settings-card">
        <ConnectorsPanel
          connectors={model.connectors}
          catalog={model.catalog}
          refresh={model.refresh}
          hermes={hermes}
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
