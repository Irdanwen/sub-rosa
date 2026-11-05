import { useConnectors } from "../../lib/connectors";
import { t } from "../../lib/i18n";
import { ConnectorsPanel } from "../connectors/ConnectorsPanel";
import { SkillPacksPanel } from "../connectors/SkillPacksPanel";

/**
 * Settings › Connectors on the computer (ADR-0092 and its addendum). One
 * catalog for every shell: a connector is signed in here, in the app, and
 * the computer's agent reaches it through the app's own `subrosa_connectors`
 * server, under the same rules as the phones. Skill packs sit beside it, for
 * the same reason.
 *
 * Removing a connector used to also delete a copy the catalog once wrote into
 * the agent's own server list, and only through the sandboxed runtime. No copy
 * outlives a start any more: the app rewrites that list at every start and
 * keeps only the servers a person added in Settings (ADR-0140).
 */
export function ConnectorsSection() {
  const model = useConnectors();
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
