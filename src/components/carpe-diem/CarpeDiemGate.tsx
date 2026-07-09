import { CarpeDiemSettings } from "../settings/CarpeDiemSettings";
import { JuneGradientMark } from "../account/AccountGate";
import { CARPE_DIEM_DASHBOARD_URL, PRODUCT_NAME } from "../../lib/branding";
import { isMobilePlatform } from "../../lib/mobile";

/**
 * First-run gate: shown until a Carpe Diem API key is configured and the
 * sidecar is not in a failed state. Reuses the welcome-screen chrome so it
 * matches the app's existing sign-in flow. App.tsx dismisses it by re-deriving
 * `carpeDiemRequired` from the sidecar status event.
 */
export function CarpeDiemGate() {
  const mobile = isMobilePlatform();
  return (
    <div className="welcome-screen">
      <div className="welcome-card welcome-card-wide">
        <span className="welcome-mark welcome-mark-symbol" aria-hidden>
          <JuneGradientMark />
        </span>
        <h1 className="welcome-title">Welcome to {PRODUCT_NAME}</h1>
        <p className="welcome-subtitle">
          {mobile
            ? `${PRODUCT_NAME} turns your meetings into notes, right on your iPhone. Paste your Carpe Diem key to get started.`
            : `${PRODUCT_NAME} turns your meetings into notes on your computer. Connect your Carpe Diem key to get started: no terminal, no config files.`}
        </p>

        <CarpeDiemSettings compact />

        <p className="welcome-terms">
          Need a key?{" "}
          <a href={CARPE_DIEM_DASHBOARD_URL} target="_blank" rel="noreferrer">
            Create one and add credits
          </a>{" "}
          in the Carpe Diem dashboard, then paste it above.
        </p>
      </div>
    </div>
  );
}
