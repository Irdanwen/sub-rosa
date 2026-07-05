import { CarpeDiemSettings } from "../../settings/CarpeDiemSettings";
import { useCarpeDiemCredits } from "../../../lib/carpe-diem-credits";
import { PRODUCT_NAME } from "../../../lib/branding";
import { formatCredits } from "../../../lib/studio/catalog";
import { StackHeader } from "../StackHeader";

/**
 * Mobile settings: the Carpe Diem connection (base URL, API key, credits) is
 * the load-bearing section. Model choices and the dictionary follow in later
 * phases; desktop-only sections (updater, HUDs, dictation shortcuts, Hermes
 * skills) never ship on mobile.
 */
export function SettingsScreen() {
  const credits = useCarpeDiemCredits();

  return (
    <div className="mobile-screen-root">
      <StackHeader title="Settings" large />
      <div className="mobile-settings-scroll">
        {credits ? (
          <section className="mobile-credits-card" aria-label="Carpe Diem balance">
            <div className="mobile-credits-main">
              <span className="mobile-credits-value">
                {formatCredits(credits.availableCredits)}
              </span>
              <span className="mobile-credits-label">credits available</span>
            </div>
            <div className="mobile-credits-side">
              {credits.escrowCredits > 0 ? (
                <span>{formatCredits(credits.escrowCredits)} in escrow</span>
              ) : null}
              {typeof credits.priceMultiplier === "number" ? (
                <span>price factor x{credits.priceMultiplier.toFixed(2)}</span>
              ) : null}
            </div>
          </section>
        ) : null}
        <section className="mobile-settings-section">
          <h2 className="mobile-settings-section-title">Carpe Diem</h2>
          <CarpeDiemSettings />
        </section>
        <p className="mobile-settings-footnote">
          {PRODUCT_NAME} keeps your notes, audio, and transcripts on this device. AI requests go
          directly to Carpe Diem with your key.
        </p>
      </div>
    </div>
  );
}
