import { t } from "../../lib/i18n";
import { BackButton } from "../ui/BackButton";
import { TodaySurface } from "./TodaySurface";

/** Today on the desktop: a page of its own in the sidebar (ADR-0091). */
export function TodayView() {
  return (
    <TodaySurface
      platform="desktop"
      renderHeader={({ title, onBack }) => (
        <header className="today-page-header">
          {onBack ? <BackButton label={t("Back")} onClick={onBack} /> : null}
          <h1 className="today-page-title">{title}</h1>
        </header>
      )}
    />
  );
}
