import { useState } from "react";
import { CarpeDiemSettings } from "../settings/CarpeDiemSettings";
import { BrandGradientMark } from "../brand/Marks";
import { BrandPrimaryButton } from "../ui/BrandPrimaryButton";
import { CARPE_DIEM_DASHBOARD_URL, PRODUCT_NAME } from "../../lib/branding";
import { isMobilePlatform } from "../../lib/mobile";
import { carpeDiemRestartSidecar } from "../../lib/tauri";

/**
 * First-run gate: shown until a Carpe Diem API key is configured and the
 * sidecar is not in a failed state. Reuses the welcome-screen chrome so it
 * matches the app's existing sign-in flow. App.tsx dismisses it by re-deriving
 * `carpeDiemRequired` from the sidecar status event.
 *
 * Two reasons land here and they are not the same thing. Without a key, this is
 * the first screen of the product and it should read like one. With a key that
 * the engine then failed to start on, the same screen greeted a returning user
 * as a stranger and told them to get started -- which is both wrong and useless,
 * because getting started is exactly what just failed. The second case now says
 * what happened and what to do about it.
 *
 * Neither case invents a diagnosis. The app knows the engine did not come up;
 * it does not know why, and guessing at a cause the user would then chase is
 * worse than naming the two things actually worth checking.
 */
export function CarpeDiemGate({
  reason = "no-key",
}: {
  /** Why the gate is up: nothing configured yet, or configured and failed. */
  reason?: "no-key" | "failed";
}) {
  const mobile = isMobilePlatform();
  const failed = reason === "failed";
  // The engine can be asked to start again from here. It used to require a
  // trip to Settings, or a relaunch, for a failure that is often a network
  // blip at boot.
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    void carpeDiemRestartSidecar().finally(() => setRetrying(false));
  };

  return (
    <div className="welcome-screen">
      <div className="welcome-card welcome-card-wide">
        <span className="welcome-mark welcome-mark-symbol" aria-hidden>
          <BrandGradientMark />
        </span>
        <h1 className="welcome-title">
          {failed ? `${PRODUCT_NAME} could not start` : `Welcome to ${PRODUCT_NAME}`}
        </h1>
        <p className="welcome-subtitle">
          {failed
            ? "The local engine did not come up. Your notes are untouched. This is almost always the key or the connection: check the key below, then try again."
            : mobile
              ? `${PRODUCT_NAME} turns your meetings into notes, right on your iPhone. Paste your Carpe Diem key to get started.`
              : `${PRODUCT_NAME} turns your meetings into notes on your computer. Connect your Carpe Diem key to get started: no terminal, no config files.`}
        </p>

        <CarpeDiemSettings compact />

        {failed ? (
          <div className="welcome-providers">
            <BrandPrimaryButton disabled={retrying} onClick={retry}>
              {retrying ? "Starting…" : "Try again"}
            </BrandPrimaryButton>
          </div>
        ) : null}

        <p className="welcome-terms">
          {failed ? (
            <>
              Still stuck? Check that the key has credits in the{" "}
              <a href={CARPE_DIEM_DASHBOARD_URL} target="_blank" rel="noreferrer">
                Carpe Diem dashboard
              </a>
              .
            </>
          ) : (
            <>
              Need a key?{" "}
              <a href={CARPE_DIEM_DASHBOARD_URL} target="_blank" rel="noreferrer">
                Create one and add credits
              </a>{" "}
              in the Carpe Diem dashboard, then paste it above.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
