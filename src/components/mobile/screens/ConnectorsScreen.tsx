import { useConnectors } from "../../../lib/connectors";
import { t } from "../../../lib/i18n";
import { ConnectorsPanel } from "../../connectors/ConnectorsPanel";
import { SettingsGroup } from "../SettingsList";
import { StackHeader } from "../StackHeader";

/**
 * Connectors on the phone (ADR-0092): the same catalog as the computer, run
 * by the phone's own client. A connector added on another device shows here
 * and needs one sign-in on this phone, because access never travels.
 */
export function ConnectorsScreen({ onBack }: { onBack: () => void }) {
  const model = useConnectors();
  return (
    <div className="mobile-screen-root">
      <StackHeader title={t("Connectors")} onBack={onBack} backLabel={t("Settings")} />
      <div className="mobile-settings-scroll">
        <SettingsGroup
          footer={t(
            "Actions that change something ask you first, unless you allow them. A connector added on another device needs one sign-in here.",
          )}
        >
          <div className="mobile-settings-row" data-align="stack">
            <ConnectorsPanel
              connectors={model.connectors}
              catalog={model.catalog}
              refresh={model.refresh}
            />
          </div>
        </SettingsGroup>
      </div>
    </div>
  );
}
