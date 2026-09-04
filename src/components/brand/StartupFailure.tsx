import { t } from "../../lib/i18n";
import { useState } from "react";
import { PRODUCT_NAME } from "../../lib/branding";
import { BrandPrimaryButton } from "../ui/BrandPrimaryButton";
import { BrandGradientMark } from "./Marks";

type Props = {
  message: string;
  onRetry: () => Promise<unknown>;
};

/**
 * Retryable card for a boot step that stalled or errored.
 *
 * This is the blank-window guard (upstream #853): the shell holds a loading
 * screen until boot state resolves, so a lookup that never settles leaves an
 * empty window with no way out. It backed the OS Accounts lookup upstream;
 * with accounts gone it backs the sidecar status probe, which is now the one
 * boot call the first paint waits on.
 */
export function StartupFailure({ message, onRetry }: Props) {
  const [retrying, setRetrying] = useState(false);

  async function handleRetry() {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="welcome-screen">
      <div className="welcome-card">
        <span className="welcome-mark welcome-mark-symbol" aria-hidden>
          <BrandGradientMark />
        </span>
        <h1 className="welcome-title">
          {t("{PRODUCT_NAME} could not finish starting", { PRODUCT_NAME })}
        </h1>
        <p className="welcome-subtitle">{message}</p>
        <div className="welcome-providers">
          <BrandPrimaryButton disabled={retrying} onClick={() => void handleRetry()}>
            {retrying ? "Trying again..." : "Try again"}
          </BrandPrimaryButton>
        </div>
      </div>
    </div>
  );
}
