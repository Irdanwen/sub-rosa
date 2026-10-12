import { t } from "../../lib/i18n";
import { BackButton } from "../ui/BackButton";
import { TodaySurface } from "./TodaySurface";

/** Today on the desktop: a page of its own in the sidebar (ADR-0091). The
 * routines, which schedule the work Today shows, open from its header. */
export function TodayView({ onOpenRoutines }: { onOpenRoutines?: () => void }) {
  return (
    <TodaySurface
      platform="desktop"
      renderHeader={({ title, onBack }) => (
        <header className="today-page-header">
          {onBack ? <BackButton label={t("Back")} onClick={onBack} /> : null}
          <h1 className="today-page-title">{title}</h1>
          {!onBack && onOpenRoutines ? (
            <nav className="page-header-links" aria-label={t("Routines")}>
              <button type="button" onClick={onOpenRoutines}>
                {t("Routines")}
              </button>
            </nav>
          ) : null}
        </header>
      )}
    />
  );
}
