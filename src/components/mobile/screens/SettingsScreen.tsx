import { t, type LocaleChoice, localeChoice, chooseLocaleAndReload } from "../../../lib/i18n";
import { getVersion } from "@tauri-apps/api/app";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useState } from "react";
import { PRODUCT_NAME } from "../../../lib/branding";
import { useCarpeDiemCredits } from "../../../lib/carpe-diem-credits";
import { AUTOMATION_ADDRESSES } from "../../../lib/automations";
import { hapticSelection } from "../../../lib/haptics";
import { formatCredits } from "../../../lib/studio/catalog";
import {
  type MomentSettingsDto,
  type SpotlightSettingsDto,
  carpeDiemOpenDashboard,
  memoryList,
  momentsGetSettings,
  momentsSetSettings,
  spotlightGetSettings,
  spotlightSetSettings,
} from "../../../lib/tauri";
import { type ThemePreference, getStoredTheme, setStoredTheme } from "../../../lib/theme";
import { useCarpeDiem } from "../../settings/CarpeDiemSettings";
import {
  SettingsActionRow,
  SettingsGroup,
  SettingsLinkRow,
  SettingsRow,
  SettingsToggleRow,
} from "../SettingsList";
import { StackHeader } from "../StackHeader";
import type { SettingsSection } from "../../../app/mobile/nav";

const THEME_OPTIONS: Array<{ id: ThemePreference; label: string }> = [
  { id: "system", label: t("System") },
  { id: "light", label: t("Light") },
  { id: "dark", label: t("Dark") },
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
const LANGUAGE_OPTIONS: Array<{ id: LocaleChoice; label: string }> = [
  { id: "system", label: t("System") },
  { id: "en", label: t("English") },
  { id: "fr", label: t("Français") },
];

export function SettingsScreen({ onOpen }: { onOpen: (section: SettingsSection) => void }) {
  const credits = useCarpeDiemCredits();
  const { status } = useCarpeDiem();
  const [theme, setTheme] = useState<ThemePreference>(getStoredTheme);
  const [language, setLanguage] = useState<LocaleChoice>(() => localeChoice());
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

  const [moments, setMoments] = useState<MomentSettingsDto | null>(null);
  useEffect(() => {
    let cancelled = false;
    momentsGetSettings()
      .then((value) => {
        if (!cancelled) setMoments(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  // The router already makes every destination automatable; the only thing
  // missing is that nobody can guess a URL scheme. Tapping copies one.
  const copyAutomation = async (url: string) => {
    await writeText(url).catch(() => {});
    hapticSelection();
  };

  const [spotlight, setSpotlight] = useState<SpotlightSettingsDto | null>(null);
  useEffect(() => {
    let cancelled = false;
    spotlightGetSettings()
      .then((value) => {
        if (!cancelled) setSpotlight(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const updateSpotlight = async (next: SpotlightSettingsDto) => {
    setSpotlight(await spotlightSetSettings(next).catch(() => spotlight));
  };

  const updateMoments = async (next: MomentSettingsDto) => {
    // Keep the last known-good state on failure rather than showing a
    // half-applied toggle.
    setMoments(await momentsSetSettings(next).catch(() => moments));
  };

  const selectTheme = (next: ThemePreference) => {
    hapticSelection();
    setTheme(next);
    setStoredTheme(next);
  };

  return (
    <div className="mobile-screen-root">
      <StackHeader title={t("Settings")} large />
      <div className="mobile-settings-scroll">
        {credits ? (
          // Tappable: the balance is the number people come here to check, and
          // the only useful thing to do with it is top it up.
          <button
            type="button"
            className="mobile-credits-card"
            aria-label={t("Carpe Diem balance, opens the dashboard")}
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
            <span className="mobile-credits-action">{t("Top up")}</span>
          </button>
        ) : null}

        <SettingsGroup title={t("Appearance")}>
          <SettingsRow label={t("Theme")} align="stack">
            <div
              className="mobile-segmented mobile-segmented-flush"
              role="radiogroup"
              aria-label={t("Theme")}
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
          <SettingsRow label={t("Language")} align="stack">
            <div className="mobile-segmented mobile-segmented-flush">
              {LANGUAGE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="mobile-segmented-item"
                  aria-pressed={language === option.id}
                  data-active={language === option.id ? "true" : undefined}
                  onClick={() => {
                    setLanguage(option.id);
                    chooseLocaleAndReload(option.id);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup
          title={t("When the app speaks first")}
          footer={t(
            "Briefs read your calendar on this device and stay quiet when your notes have nothing to say about the people you are meeting.",
          )}
        >
          <SettingsToggleRow
            label={t("Meeting briefs")}
            detail={t("Ten minutes before, what you last decided")}
            checked={moments?.briefEnabled === true}
            disabled={moments === null}
            onChange={(next) =>
              void updateMoments({
                briefEnabled: next,
                recapEnabled: moments?.recapEnabled ?? true,
              })
            }
          />
          <SettingsToggleRow
            label={t("Tell me when a note is ready")}
            checked={moments?.recapEnabled === true}
            disabled={moments === null}
            onChange={(next) =>
              void updateMoments({
                briefEnabled: moments?.briefEnabled ?? false,
                recapEnabled: next,
              })
            }
          />
        </SettingsGroup>

        <SettingsGroup
          title={t("System search")}
          footer={t(
            "Titles and dates go in this device's search index so Spotlight finds your notes. The index is not Sub Rosa's storage, so what the notes say stays out of it until you ask.",
          )}
        >
          <SettingsToggleRow
            label={t("Find notes in Spotlight")}
            checked={spotlight?.enabled === true}
            disabled={spotlight === null}
            onChange={(next) =>
              void updateSpotlight({
                enabled: next,
                includeContent: spotlight?.includeContent ?? false,
              })
            }
          />
          <SettingsToggleRow
            label={t("Include what the notes say")}
            checked={spotlight?.includeContent === true}
            disabled={spotlight === null || spotlight?.enabled !== true}
            onChange={(next) =>
              void updateSpotlight({ enabled: spotlight?.enabled ?? true, includeContent: next })
            }
          />
        </SettingsGroup>

        <SettingsGroup
          title={t("Shortcuts and Siri")}
          footer={t(
            'Put one of these in a Shortcuts "Open URL" action to start a recording from the Action button, from Siri, or from any shortcut you already use.',
          )}
        >
          {AUTOMATION_ADDRESSES.map((automation) => (
            <SettingsActionRow
              key={automation.url}
              label={automation.label}
              onClick={() => void copyAutomation(automation.url)}
            />
          ))}
        </SettingsGroup>

        <SettingsGroup>
          <SettingsLinkRow
            label={t("Memory")}
            value={memorySummary ?? undefined}
            onClick={() => onOpen("memory")}
          />
          <SettingsLinkRow label={t("Usage")} onClick={() => onOpen("usage")} />
          <SettingsLinkRow
            label={t("Connection")}
            value={STATUS_SUMMARY[status?.status ?? "unconfigured"]}
            onClick={() => onOpen("connection")}
          />
        </SettingsGroup>

        <SettingsGroup>
          <SettingsLinkRow label={t("Privacy")} onClick={() => onOpen("privacy")} />
          <SettingsLinkRow label={t("Models")} onClick={() => onOpen("models")} />
          <SettingsLinkRow label={t("Reports")} onClick={() => onOpen("reports")} />
          <SettingsLinkRow label={t("Archive")} onClick={() => onOpen("archive")} />
          <SettingsLinkRow label={t("About")} onClick={() => onOpen("about")} />
        </SettingsGroup>

        <p className="mobile-settings-footnote">
          {t(
            "{product} keeps your notes, audio, and transcripts on this device. AI requests go directly to Carpe Diem with your key.",
            { product: PRODUCT_NAME },
          )}
          {version ? ` ${t("Version {version}.", { version })}` : ""}
        </p>
      </div>
    </div>
  );
}
