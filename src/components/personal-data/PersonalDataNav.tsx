import { IconBank } from "central-icons/IconBank";
import { IconHeartBeat } from "central-icons/IconHeartBeat";
import { t } from "../../lib/i18n";

/** The desktop sidebar's two entries for Health and Finances (ADR-0099). */
export function PersonalDataNav<View extends string>({
  activeView,
  onChangeView,
}: {
  activeView: View;
  onChangeView: (view: "health" | "finances") => void;
}) {
  return (
    <>
      {(["health", "finances"] as const).map((view) => (
        <button
          key={view}
          type="button"
          className="sidebar-nav-item"
          data-active={activeView === view}
          aria-current={activeView === view ? "page" : undefined}
          onClick={() => onChangeView(view)}
        >
          <span className="sidebar-nav-icon">
            {view === "health" ? <IconHeartBeat size={16} /> : <IconBank size={16} />}
          </span>
          <span className="sidebar-nav-label">
            {view === "health" ? t("Health") : t("Finances")}
          </span>
        </button>
      ))}
    </>
  );
}
