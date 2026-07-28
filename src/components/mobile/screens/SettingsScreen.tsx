import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { PRODUCT_NAME } from "../../../lib/branding";
import { useCarpeDiemCredits } from "../../../lib/carpe-diem-credits";
import { hapticSelection } from "../../../lib/haptics";
import { formatCredits } from "../../../lib/studio/catalog";
import { carpeDiemOpenDashboard, memoryList } from "../../../lib/tauri";
import { type ThemePreference, getStoredTheme, setStoredTheme } from "../../../lib/theme";
import { useCarpeDiem } from "../../settings/CarpeDiemSettings";
import { SettingsGroup, SettingsLinkRow, SettingsRow } from "../SettingsList";
import { StackHeader } from "../StackHeader";
import type { SettingsSection } from "../../../app/mobile/nav";

const THEME_OPTIONS: Array<{ id: ThemePreference; label: string }> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const STATUS_SUMMARY: Record<string, string> = {
  unconfigured: "Not connected",
  starting: "Starting",
  ready: "Connected",
  failed: "Backend error",
};

/**
 * Mobile settings, root screen.
 *
 * The shape is the platform's: a short list where the things you change often
 * (theme) are one tap, and the things you set once (the Carpe Diem key,
 * endpoint and payment rail) live one push away behind a row that summarises
 * their state. Everything used to be inlined on this screen, which put the
 * connection controls two and a half screens down, below however many memories
 * the user had accumulated.
 */
export function SettingsScreen({ onOpen }: { onOpen: (section: SettingsSection) => void }) {
  const credits = useCarpeDiemCredits();
  const { status } = useCarpeDiem();
  const [theme, setTheme] = useState<ThemePreference>(getStoredTheme);
  const [version, setVersion] = useState<string | null>(null);
  const [memorySummary, setMemorySummary] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => undefined);
  }, []);

  // Summarise what is behind the Memory row, so the list says something
  // instead of making the user open it to find out.
  useEffect(() => {
    memoryList()
      .then((response) => {
        if (!response.settings.enabled) {
          setMemorySummary("Off");
          return;
        }
        const count = response.items.filter((item) => !item.disabled).length;
        setMemorySummary(count === 0 ? "On" : `On · ${count} remembered`);
      })
      .catch(() => setMemorySummary(null));
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
          // Tappable: the balance is the number people come here to check, and
          // the only useful thing to do with it is top it up.
          <button
            type="button"
            className="mobile-credits-card"
            aria-label="Carpe Diem balance, opens the dashboard"
            onClick={() => {
              hapticSelection();
              void carpeDiemOpenDashboard();
            }}
          >
            <span className="mobile-credits-main">
              <span className="mobile-credits-value">
                {formatCredits(credits.availableCredits)}
              </span>
              <span className="mobile-credits-label">
                {credits.rail === "prepaid" ? "prepaid balance" : "credits available"}
              </span>
            </span>
            <span className="mobile-credits-action">Top up</span>
          </button>
        ) : null}

        <SettingsGroup title="Appearance">
          <SettingsRow label="Theme" align="stack">
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
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup>
          <SettingsLinkRow
            label="Memory"
            value={memorySummary ?? undefined}
            onClick={() => onOpen("memory")}
          />
          <SettingsLinkRow
            label="Connection"
            value={STATUS_SUMMARY[status?.status ?? "unconfigured"]}
            onClick={() => onOpen("connection")}
          />
        </SettingsGroup>

        <p className="mobile-settings-footnote">
          {PRODUCT_NAME} keeps your notes, audio, and transcripts on this device. AI requests go
          directly to Carpe Diem with your key.
          {version ? ` Version ${version}.` : ""}
        </p>
      </div>
    </div>
  );
}
