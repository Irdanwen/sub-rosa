import { t } from "../../../lib/i18n";
import { CARPE_DIEM_DASHBOARD_URL, PRODUCT_NAME } from "../../../lib/branding";
import { CarpeDiemSettings } from "../../settings/CarpeDiemSettings";
import { StepActions, StepCard } from "../StepChrome";

/**
 * The key, as a step of the first run rather than a gate in front of it.
 *
 * Until 2026-09-03 a fresh install met two screens that did not know each
 * other: a gate that took the key, then a wizard that welcomed the user as if
 * nothing had happened. The key is now the second screen of one sequence.
 * The form is the same settings form the app uses later; what changes is
 * only that the step will not let go until the local engine has come up on
 * that key, so the permissions and the practice that follow can rely on it.
 */
export function KeyStep({
  ready,
  onContinue,
}: {
  /** The engine is running on a stored key: the step may be left. */
  ready: boolean;
  onContinue: () => void;
}) {
  return (
    <StepCard
      title={t("Connect your Carpe Diem key")}
      subtitle={`${PRODUCT_NAME} sends your requests to Carpe Diem with your own key, and nowhere else. Paste it once; it is kept in the system keychain.`}
      wide
    >
      <CarpeDiemSettings compact />
      <p className="welcome-terms" aria-live="polite">
        {ready ? (
          "Connected. Your key works and the engine is running."
        ) : (
          <>
            {t("Need a key?")}{" "}
            <a href={CARPE_DIEM_DASHBOARD_URL} target="_blank" rel="noreferrer">
              {t("Create one and add credits")}
            </a>{" "}
            {t("in the Carpe Diem dashboard, then paste it above.")}
          </>
        )}
      </p>
      <StepActions continueDisabled={!ready} onContinue={onContinue} />
    </StepCard>
  );
}
