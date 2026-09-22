import { t, type LocaleChoice, localeChoice, chooseLocaleAndReload } from "../../../lib/i18n";
import { getVersion } from "@tauri-apps/api/app";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useState } from "react";
import { PRODUCT_NAME } from "../../../lib/branding";
import { useCarpeDiemCredits } from "../../../lib/carpe-diem-credits";
import { type Automation, AUTOMATION_ADDRESSES } from "../../../lib/automations";
import { messageFromError } from "../../../lib/errors";
import { openShortcutsApp } from "../../../lib/intents";
import { isIosPlatform } from "../../../lib/mobile";
import { openTopUp } from "../../../lib/top-up";
import { hapticSelection } from "../../../lib/haptics";
import { formatCredits } from "../../../lib/studio/catalog";
import {
  type MomentSettingsDto,
  type SpotlightSettingsDto,
  memoryList,
  momentsGetSettings,
  momentsSetSettings,
  spotlightGetSettings,
  spotlightSetSettings,
} from "../../../lib/tauri";
import { type ThemePreference, getStoredTheme, setStoredTheme } from "../../../lib/theme";
import { useCarpeDiem } from "../../settings/CarpeDiemSettings";
import { accountStatus } from "../../../lib/account";
import { SettingsGroup, SettingsLinkRow, SettingsRow, SettingsToggleRow } from "../SettingsList";
import { ActionSheet } from "../ActionSheet";
import { StackHeader } from "../StackHeader";
import type { SettingsSection } from "../../../app/mobile/nav";

const THEME_OPTIONS: Array<{ id: ThemePreference; label: string }> = [
  { id: "system", label: t("System") },
  { id: "light", label: t("Light") },
  { id: "dark", label: t("Dark") },
];

const STATUS_SUMMARY: Record<string, string> = {
  unconfigured: t("Not connected"),
  starting: t("Starting"),
  ready: t("Connected"),
  failed: t("Backend error"),
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
  const [accountEmail, setAccountEmail] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => undefined);
  }, []);

  // Name the account on the row itself: which one you are signed in to should
  // not require opening the screen to find out.
  useEffect(() => {
    accountStatus()
      .then((s) => setAccountEmail(s.account?.email ?? null))
      .catch(() => undefined);
  }, []);

  // Summarise what is behind the Memory row, so the list says something
  // instead of making the user open it to find out.
  useEffect(() => {
    memoryList()
      .then((response) => {
        if (!response.settings.enabled) {
          setMemorySummary(t("Off"));
          return;
        }
        const count = response.items.filter((item) => !item.disabled).length;
        setMemorySummary(count === 0 ? t("On") : t("On · {count} remembered", { count }));
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
  // A shortcut row used to copy an address, silently: nothing on screen said
  // anything had happened. It now opens a sheet that says what the action
  // does and where to find it, with the address as the fallback.
  const [automation, setAutomation] = useState<Automation | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const copyAutomation = async (url: string) => {
    try {
      await writeText(url);
      hapticSelection();
      setNotice({ ok: true, text: t("Address copied") });
    } catch (err) {
      setNotice({ ok: false, text: messageFromError(err) });
    }
  };
  const ios = isIosPlatform();
  // "Top up" did nothing on an iPhone: the link went to a process launcher
  // iOS does not have. It now opens the account site's Top up tab, and says
  // so when it cannot.
  const [topUpError, setTopUpError] = useState<string | null>(null);

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
            aria-label={t("Carpe Diem balance, opens the Top up page")}
            onClick={() => {
              hapticSelection();
              setTopUpError(null);
              void openTopUp().catch((err) => setTopUpError(messageFromError(err)));
            }}
          >
            <span className="mobile-credits-main">
              <span className="mobile-credits-value">
                {formatCredits(credits.availableCredits)}
              </span>
              <span className="mobile-credits-label">
                {credits.rail === "prepaid" ? t("prepaid balance") : t("credits available")}
              </span>
            </span>
            <span className="mobile-credits-action">{t("Top up")}</span>
          </button>
        ) : null}
        {topUpError ? (
          <p className="mobile-settings-result" data-ok="false" role="alert">
            {topUpError}
          </p>
        ) : null}

        <SettingsGroup title={t("Account")}>
          <SettingsLinkRow
            label={t("Account and sync")}
            value={accountEmail ?? t("Not signed in")}
            onClick={() => onOpen("account")}
          />
        </SettingsGroup>

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
          title={t("Shortcuts")}
          footer={
            ios
              ? t(
                  "In the Shortcuts app, search for Sub Rosa: these actions are there, ready for the Action button, a widget or the Home Screen.",
                )
              : t('Put one of these addresses in an "Open URL" shortcut to start it in one tap.')
          }
        >
          {AUTOMATION_ADDRESSES.map((entry) => (
            <SettingsLinkRow
              key={entry.url}
              label={entry.label}
              onClick={() => setAutomation(entry)}
            />
          ))}
          {notice ? (
            <p className="mobile-settings-result" data-ok={notice.ok} role="status">
              {notice.text}
            </p>
          ) : null}
        </SettingsGroup>
        {automation ? (
          <ActionSheet
            title={automation.label}
            subtitle={automation.detail}
            actions={[
              ...(ios
                ? [
                    {
                      label: t("Open Shortcuts"),
                      onAction: () =>
                        void openShortcutsApp().catch((err) =>
                          setNotice({ ok: false, text: messageFromError(err) }),
                        ),
                    },
                  ]
                : []),
              { label: t("Copy the address"), onAction: () => void copyAutomation(automation.url) },
            ]}
            closeLabel={t("Close")}
            onClose={() => setAutomation(null)}
          />
        ) : null}

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
