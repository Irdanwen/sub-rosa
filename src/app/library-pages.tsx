// The Library's desktop pages: the Library itself, and the two personal data
// views read from it (Health, Finances). They used to be two of the sidebar's
// ten entries; under the Library the sidebar keeps six places (ADR-0111).

import { t } from "../lib/i18n";
import { LibraryView } from "../components/library/LibraryView";
import { FinancesView } from "../components/personal-data/FinancesView";
import { HealthView } from "../components/personal-data/HealthView";
import { BackButton } from "../components/ui/BackButton";

export function LibraryPage({ onOpen }: { onOpen: (view: "health" | "finances") => void }) {
  return (
    <LibraryView
      header={
        <div className="library-view-head">
          <h1 className="library-view-title">{t("Library")}</h1>
          <nav className="page-header-links" aria-label={t("Personal data")}>
            <button type="button" onClick={() => onOpen("health")}>
              {t("Health")}
            </button>
            <button type="button" onClick={() => onOpen("finances")}>
              {t("Finances")}
            </button>
          </nav>
        </div>
      }
    />
  );
}

export function PersonalDataPage({
  view,
  onBack,
}: {
  view: "health" | "finances";
  onBack: () => void;
}) {
  const header = (
    <div className="personal-view-head">
      <BackButton label={t("Library")} onClick={onBack}>
        {t("Library")}
      </BackButton>
      <h1 className="personal-view-title">{view === "health" ? t("Health") : t("Finances")}</h1>
    </div>
  );
  return view === "health" ? <HealthView header={header} /> : <FinancesView header={header} />;
}
