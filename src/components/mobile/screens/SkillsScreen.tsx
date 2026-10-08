import { t } from "../../../lib/i18n";
import { SkillPacksPanel } from "../../connectors/SkillPacksPanel";
import { SettingsGroup } from "../SettingsList";
import { StackHeader } from "../StackHeader";

/** Skill packs on the phone (ADR-0092): type `/name` in a chat to use one. */
export function SkillsScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className="mobile-screen-root">
      <StackHeader title={t("Skills")} onBack={onBack} backLabel={t("Settings")} />
      <div className="mobile-settings-scroll">
        <SettingsGroup
          footer={t(
            "The assistant reads a skill when your request fits it. Type a slash and its name at the start of a message to use one now.",
          )}
        >
          <div className="mobile-settings-row" data-align="stack">
            <SkillPacksPanel />
          </div>
        </SettingsGroup>
      </div>
    </div>
  );
}
