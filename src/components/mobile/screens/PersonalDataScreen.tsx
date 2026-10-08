import { t } from "../../../lib/i18n";
import { FinancesView } from "../../personal-data/FinancesView";
import { HealthView } from "../../personal-data/HealthView";
import { StackHeader } from "../StackHeader";

/** Health or Finances on the phone (ADR-0099): the shared view in a pushed screen. */
export function PersonalDataScreen({
  kind,
  onBack,
}: {
  kind: "health" | "finances";
  onBack: () => void;
}) {
  return (
    <div className="mobile-screen-root">
      <StackHeader
        title={kind === "health" ? t("Health") : t("Finances")}
        large
        onBack={onBack}
        backLabel={t("Settings")}
      />
      <div className="mobile-list-scroll">
        {kind === "health" ? <HealthView /> : <FinancesView />}
      </div>
    </div>
  );
}
