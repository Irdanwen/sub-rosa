import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { CarpeDiemSettings } from "../../settings/CarpeDiemSettings";
import { useCarpeDiemCredits } from "../../../lib/carpe-diem-credits";
import { PRODUCT_NAME } from "../../../lib/branding";
import { formatCredits } from "../../../lib/studio/catalog";
import { type ThemePreference, getStoredTheme, setStoredTheme } from "../../../lib/theme";
import { hapticSelection } from "../../../lib/haptics";
import { MemorySettings } from "../MemorySettings";
import { StackHeader } from "../StackHeader";

const THEME_OPTIONS: Array<{ id: ThemePreference; label: string }> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/**
 * Mobile settings: the Carpe Diem connection (base URL, API key, credits) is
 * the load-bearing section, plus appearance and the app version. Model
 * choices and the dictionary follow in later phases; desktop-only sections
 * (updater, HUDs, dictation shortcuts, Hermes skills) never ship on mobile.
 */
export function SettingsScreen() {
  const credits = useCarpeDiemCredits();
  const [theme, setTheme] = useState<ThemePreference>(getStoredTheme);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => undefined);
  }, []);

  const selectTheme = (next: ThemePreference) => {
    hapticSelection();
    setTheme(next);
    setStoredTheme(next);
  };

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
              <span className="mobile-credits-label">
                {credits.rail === "prepaid" ? "prepaid balance" : "credits available"}
              </span>
            </div>
            <div className="mobile-credits-side">
              {credits.rail === "prepaid" ? <span>prepaid rail</span> : null}
              {credits.rail !== "prepaid" && credits.escrowCredits > 0 ? (
                <span>{formatCredits(credits.escrowCredits)} in escrow</span>
              ) : null}
              {typeof credits.priceMultiplier === "number" ? (
                <span>price factor x{credits.priceMultiplier.toFixed(2)}</span>
              ) : null}
            </div>
          </section>
        ) : null}
        <section className="mobile-settings-section">
          <h2 className="mobile-settings-section-title">Appearance</h2>
          <div
            className="mobile-segmented mobile-segmented-flush"
            role="radiogroup"
            aria-label="Theme"
          >
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className="mobile-segmented-item"
                role="radio"
                aria-checked={theme === option.id}
                data-active={theme === option.id ? "true" : undefined}
                onClick={() => selectTheme(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>
        <section className="mobile-settings-section">
          <h2 className="mobile-settings-section-title">Memory</h2>
          <MemorySettings />
        </section>
        <section className="mobile-settings-section">
          <h2 className="mobile-settings-section-title">Carpe Diem</h2>
          {/* compact: the stacked field layout (and no duplicate group
              heading), sized for a phone column like the first-run gate. */}
          <CarpeDiemSettings compact />
        </section>
        <p className="mobile-settings-footnote">
          {PRODUCT_NAME} keeps your notes, audio, and transcripts on this device. AI requests go
          directly to Carpe Diem with your key.
          {version ? ` Version ${version}.` : ""}
        </p>
      </div>
    </div>
  );
}
