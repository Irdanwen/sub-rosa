// The content of the settings tabs that AppSettings renders inline: each tab
// takes the state and handlers it needs from AppSettings, which still owns
// them, so switching tabs keeps what the page already loaded.
import { t, type LocaleChoice, chooseLocaleAndReload } from "../../lib/i18n";
import { PRODUCT_NAME } from "../../lib/branding";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleQuestionmark } from "central-icons/IconCircleQuestionmark";
import { IconCircleX } from "central-icons/IconCircleX";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { JUNE_COMMUNITY_URL, juneOpenCommunityPage, juneOpenVerifyPage } from "../../lib/tauri";
import type {
  DictationSettingsDto,
  DictationShortcutKind,
  DictationShortcutModifiers,
  DictationShortcutSetting,
  ProviderModelMode,
  PlatformCapabilitiesDto,
  ProviderModelSettingsDto,
  RecordingSourceMode,
  RecordingSourceReadinessDto,
  VeniceModelDto,
} from "../../lib/tauri";
import { LANGUAGE_OPTIONS, languageLabel } from "../../lib/dictation-languages";
import { autostartEnabled, autostartSupported, setAutostartEnabled } from "../../lib/autostart";
import { replayOnboarding } from "../../lib/onboarding";
import { KeycapShortcut } from "../shortcuts/KeycapShortcut";
import { ChatBarShortcutCard } from "./ChatBarShortcutCard";
import { Select, type SelectPopoverPlacement } from "../ui/Select";
import { SegmentedControl } from "../ui/SegmentedControl";
import { InlineNotice } from "../ui/InlineNotice";
import { Switch } from "../ui/Switch";
import { APP_COMMIT_HASH, APP_VERSION } from "../../app/build-info";
import type { ReportCategory } from "../agent/composer/reportCategory";
import { setStoredTheme, type ThemePreference } from "../../lib/theme";
import { DEFAULT_BRAND, setStoredBrand, type BrandId } from "../../lib/brand";
import { AccentWheel } from "./AccentWheel";
import type { ReleaseChannel } from "../../lib/updater";
import { isMacLikePlatform } from "../../lib/platform";
import { unavailableOn } from "../../lib/platform-capabilities";
import { ProviderLogo } from "./ProviderLogo";
import { ModelMeta, ModelPickerDialog, selectedModel } from "./ModelPickerDialog";
import { IMAGE_GENERATION_ENABLED } from "../../lib/feature-flags";
import { DictionarySettingsSection } from "./DictionarySettingsSection";
import { ImportSettingsSection } from "./ImportSettingsSection";
import { MicTestControl, type MicTestState } from "./MicTestControl";
import { StyleSettingsSection } from "./StyleSettingsSection";
import { THEME_OPTIONS, UI_LANGUAGE_OPTIONS } from "./appearance-options";

const RELEASE_CHANNEL_OPTIONS: readonly {
  value: ReleaseChannel;
  label: ReactNode;
}[] = [
  { value: "stable", label: t("Stable") },
  { value: "rc", label: t("Release candidate") },
];

const EMPTY_MODIFIERS: DictationShortcutModifiers = {
  command: false,
  control: false,
  option: false,
  shift: false,
  function: false,
};

export const DEFAULT_SETTINGS: DictationSettingsDto = {
  pushToTalkShortcut: {
    keyCode: 0x02,
    code: "KeyD",
    label: t("Ctrl+Opt+D"),
    pressCount: 1,
    modifiers: {
      ...EMPTY_MODIFIERS,
      control: true,
      option: true,
    },
  },
  toggleShortcut: {
    keyCode: 0x11,
    code: "KeyT",
    label: t("Ctrl+Opt+T"),
    pressCount: 1,
    modifiers: {
      ...EMPTY_MODIFIERS,
      control: true,
      option: true,
    },
  },
  microphone: {},
  style: "standard",
  language: undefined,
};

const DEFAULT_SHORTCUTS: Record<DictationShortcutKind, DictationShortcutSetting> = {
  push_to_talk: DEFAULT_SETTINGS.pushToTalkShortcut,
  toggle: DEFAULT_SETTINGS.toggleShortcut,
};

export const MIC_TEST_DURATION_SECONDS = 5;

type SourceReadiness = RecordingSourceReadinessDto["sources"][number];

export function GeneralSettingsTab({
  theme,
  setTheme,
  language,
  setLanguage,
  brand,
  setBrand,
  microphonePermissionStatus,
  microphoneReadiness,
  accessibilityPermissionStatus,
  systemReadiness,
  onEnableMicrophone,
  onEnableAccessibility,
  onEnableSystemAudio,
}: {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  language: LocaleChoice;
  setLanguage: (language: LocaleChoice) => void;
  brand: BrandId;
  setBrand: (brand: BrandId) => void;
  microphonePermissionStatus?: string;
  microphoneReadiness?: SourceReadiness;
  accessibilityPermissionStatus?: string;
  systemReadiness?: SourceReadiness;
  onEnableMicrophone?: () => void;
  onEnableAccessibility?: () => void;
  onEnableSystemAudio: () => void;
}) {
  return (
    <>
      <section className="settings-group" aria-labelledby="appearance-heading">
        <h2 id="appearance-heading" className="settings-group-heading">
          {t("Appearance")}
        </h2>
        <div className="settings-card">
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">{t("Theme")}</h3>
                <p className="settings-row-description">
                  {t("Match the system or force light or dark mode.")}
                </p>
              </div>
              <div className="settings-row-control">
                <SegmentedControl<ThemePreference>
                  aria-label={t("App theme")}
                  value={theme}
                  options={THEME_OPTIONS}
                  onValueChange={(next) => {
                    setTheme(next);
                    setStoredTheme(next);
                  }}
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">{t("Language")}</h3>
                <p className="settings-row-description">
                  {t("Follow the system, or pick one. Dates and numbers follow too.")}
                </p>
              </div>
              <div className="settings-row-control">
                <Select
                  ariaLabel={t("Language")}
                  value={language}
                  placeholder={t("System")}
                  options={[...UI_LANGUAGE_OPTIONS]}
                  onChange={(next) => {
                    setLanguage(next as LocaleChoice);
                    chooseLocaleAndReload(next as LocaleChoice);
                  }}
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">{t("Accent")}</h3>
                <p className="settings-row-description">
                  {t("The brand color used across buttons, highlights, and the recorder.")}
                </p>
              </div>
              <div className="settings-row-control">
                {brand !== DEFAULT_BRAND ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    aria-label={t("Reset accent color to default")}
                    onClick={() => {
                      setBrand(DEFAULT_BRAND);
                      setStoredBrand(DEFAULT_BRAND);
                    }}
                  >
                    {t("Reset")}
                  </button>
                ) : null}
                <AccentWheel
                  value={brand}
                  onChange={(id) => {
                    setBrand(id);
                    setStoredBrand(id);
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <PermissionsSettingsSection
        microphonePermissionStatus={microphonePermissionStatus}
        microphoneReadiness={microphoneReadiness}
        accessibilityPermissionStatus={accessibilityPermissionStatus}
        systemReadiness={systemReadiness}
        onEnableMicrophone={onEnableMicrophone}
        onEnableAccessibility={onEnableAccessibility}
        onEnableSystemAudio={onEnableSystemAudio}
      />

      <StartupSettingsSection />
    </>
  );
}

export function ShortcutsSettingsTab({
  dictationHotkeyAvailable,
  capabilities,
  settings,
  capturingShortcut,
  shortcutError,
  startShortcutCapture,
  saveShortcut,
  cancelShortcutCapture,
}: {
  dictationHotkeyAvailable: boolean;
  capabilities: PlatformCapabilitiesDto | null;
  settings: DictationSettingsDto;
  capturingShortcut?: DictationShortcutKind;
  shortcutError?: string;
  startShortcutCapture: (kind: DictationShortcutKind) => Promise<void>;
  saveShortcut: (kind: DictationShortcutKind, shortcut: DictationShortcutSetting) => Promise<void>;
  cancelShortcutCapture: () => Promise<void>;
}) {
  return (
    <section className="settings-group" aria-labelledby="shortcuts-heading">
      <h2 id="shortcuts-heading" className="settings-group-heading">
        {t("Shortcuts")}
      </h2>
      <div className="settings-card">
        <div className="settings-rows">
          {dictationHotkeyAvailable ? (
            <>
              <ShortcutRow
                title={t("Push to talk")}
                description={t("Hold this shortcut to dictate, then release to paste.")}
                shortcut={settings.pushToTalkShortcut}
                defaultShortcut={DEFAULT_SHORTCUTS.push_to_talk}
                capturing={capturingShortcut === "push_to_talk"}
                disabled={!!capturingShortcut && capturingShortcut !== "push_to_talk"}
                error={capturingShortcut === "push_to_talk" ? shortcutError : undefined}
                onChange={() => void startShortcutCapture("push_to_talk")}
                onReset={() => void saveShortcut("push_to_talk", DEFAULT_SHORTCUTS.push_to_talk)}
                onCancel={() => void cancelShortcutCapture()}
              />

              <ShortcutRow
                title={t("Toggle dictation")}
                description={t("Press this shortcut to start or stop dictation.")}
                shortcut={settings.toggleShortcut}
                defaultShortcut={DEFAULT_SHORTCUTS.toggle}
                capturing={capturingShortcut === "toggle"}
                disabled={!!capturingShortcut && capturingShortcut !== "toggle"}
                error={capturingShortcut === "toggle" ? shortcutError : undefined}
                onChange={() => void startShortcutCapture("toggle")}
                onReset={() => void saveShortcut("toggle", DEFAULT_SHORTCUTS.toggle)}
                onCancel={() => void cancelShortcutCapture()}
              />
            </>
          ) : (
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">{t("Dictation shortcuts unavailable")}</h3>
                <p className="settings-row-description">
                  {unavailableOn(capabilities, "A global dictation shortcut")}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      <ChatBarShortcutCard />
    </section>
  );
}

export function DictationSettingsTab({
  settings,
  languageWrapRef,
  languageOpen,
  setLanguageOpen,
  languagePopoverPlacement,
  languagePopoverStyle,
  selectLanguage,
}: {
  settings: DictationSettingsDto;
  languageWrapRef: RefObject<HTMLDivElement>;
  languageOpen: boolean;
  setLanguageOpen: (update: (open: boolean) => boolean) => void;
  languagePopoverPlacement: SelectPopoverPlacement;
  languagePopoverStyle: CSSProperties;
  selectLanguage: (language: string) => Promise<void>;
}) {
  return (
    <>
      <section className="settings-group" aria-labelledby="dictation-heading">
        <h2 id="dictation-heading" className="settings-group-heading">
          {t("Dictation")}
        </h2>
        <div className="settings-card">
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">{t("Language")}</h3>
                <p className="settings-row-description">
                  {t("Default language hint for note transcription and dictation.")}
                </p>
              </div>
              <div className="settings-row-control" ref={languageWrapRef}>
                <button
                  type="button"
                  className="select-trigger settings-language-select"
                  aria-label={t("Default transcription language")}
                  aria-haspopup="listbox"
                  aria-expanded={languageOpen}
                  onClick={() => setLanguageOpen((value) => !value)}
                >
                  <span>{languageLabel(settings.language ?? "")}</span>
                  <IconChevronDownSmall size={14} />
                </button>
                {languageOpen ? (
                  <ul
                    className="select-popover"
                    role="listbox"
                    data-placement={languagePopoverPlacement}
                    style={languagePopoverStyle}
                  >
                    {LANGUAGE_OPTIONS.map((option) => {
                      const selected = option.value === (settings.language ?? "");
                      return (
                        <li key={option.value || "auto"}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={selected}
                            data-selected={selected}
                            onClick={() => void selectLanguage(option.value)}
                          >
                            <span>{option.label}</span>
                            <span className="select-check" aria-hidden>
                              {selected ? <IconCheckmark1Small size={14} /> : null}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </section>

      <StyleSettingsSection />

      <DictionarySettingsSection />
    </>
  );
}

export function AudioSettingsTab({
  settings,
  microphoneName,
  microphoneDescription,
  microphoneOptions,
  micWrapRef,
  micOpen,
  setMicOpen,
  micPopoverPlacement,
  microphonePopoverStyle,
  requestMicrophones,
  selectMicrophone,
  macLikePlatform,
  micTestState,
  micTestLevel,
  micTestElapsedMs,
  micTestSampleSrc,
  micTestError,
  micTestPlaying,
  startMicTest,
  startOverMicTest,
  onMicTestPlaybackError,
  setMicTestPlaying,
  systemUnavailable,
  systemDenied,
  systemLocked,
  systemOn,
  checkingSourceReadiness,
  onEnableSystemAudio,
  onSourceModeChange,
}: {
  settings: DictationSettingsDto;
  microphoneName: string;
  microphoneDescription: string;
  microphoneOptions: { id?: string; name: string }[];
  micWrapRef: RefObject<HTMLDivElement>;
  micOpen: boolean;
  setMicOpen: (update: (open: boolean) => boolean) => void;
  micPopoverPlacement: SelectPopoverPlacement;
  microphonePopoverStyle: CSSProperties;
  requestMicrophones: () => Promise<void>;
  selectMicrophone: (id?: string, name?: string) => Promise<void>;
  macLikePlatform: boolean;
  micTestState: MicTestState;
  micTestLevel: number;
  micTestElapsedMs: number;
  micTestSampleSrc?: string;
  micTestError?: string;
  micTestPlaying: boolean;
  startMicTest: () => Promise<void>;
  startOverMicTest: () => Promise<void>;
  onMicTestPlaybackError: () => void;
  setMicTestPlaying: (playing: boolean) => void;
  systemUnavailable: boolean;
  systemDenied: boolean;
  systemLocked: boolean;
  systemOn: boolean;
  checkingSourceReadiness: boolean;
  onEnableSystemAudio: () => void;
  onSourceModeChange: (mode: RecordingSourceMode) => void;
}) {
  return (
    <>
      <section className="settings-group" aria-labelledby="audio-heading">
        <h2 id="audio-heading" className="settings-group-heading">
          {t("Audio")}
        </h2>
        <div className="settings-card">
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">{t("Microphone")}</h3>
                <p className="settings-row-description">{microphoneDescription}</p>
              </div>
              <div className="settings-row-control" ref={micWrapRef}>
                <button
                  type="button"
                  className="select-trigger"
                  aria-haspopup="listbox"
                  aria-expanded={micOpen}
                  onClick={() => {
                    setMicOpen((value) => !value);
                    void requestMicrophones();
                  }}
                >
                  <span>{microphoneName}</span>
                  <IconChevronDownSmall size={14} />
                </button>
                {micOpen ? (
                  // 2px = (trigger 32 - item 28) / 2, so the selected item
                  // overlays the trigger label exactly with no visual jump.
                  <ul
                    className="select-popover"
                    role="listbox"
                    data-placement={micPopoverPlacement}
                    style={microphonePopoverStyle}
                  >
                    {microphoneOptions.map((option) => {
                      const selected = (option.id ?? "") === (settings.microphone.id ?? "");
                      return (
                        <li key={option.id ?? "auto"}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={selected}
                            data-selected={selected}
                            onClick={() =>
                              void selectMicrophone(option.id, option.id ? option.name : undefined)
                            }
                          >
                            <span>{option.name}</span>
                            <span className="select-check" aria-hidden>
                              {selected ? <IconCheckmark1Small size={14} /> : null}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            </div>

            {macLikePlatform ? (
              <MicTestControl
                state={micTestState}
                level={micTestLevel}
                elapsedMs={micTestElapsedMs}
                sampleSrc={micTestSampleSrc}
                error={micTestError}
                playing={micTestPlaying}
                durationSeconds={MIC_TEST_DURATION_SECONDS}
                onStart={() => void startMicTest()}
                onStartOver={() => void startOverMicTest()}
                onPlaybackError={onMicTestPlaybackError}
                onPlayingChange={setMicTestPlaying}
              />
            ) : null}

            {systemUnavailable ? null : (
              <div className="settings-row">
                <div className="settings-row-info">
                  <h3 className="settings-row-title">{t("System audio")}</h3>
                  <p className="settings-row-description">
                    {t("Capture audio from other apps along with your microphone.")}
                  </p>
                </div>
                <div className="settings-row-control">
                  {systemDenied ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={onEnableSystemAudio}
                    >
                      {t("Enable")}
                    </button>
                  ) : null}
                  <Switch
                    checked={systemOn}
                    disabled={checkingSourceReadiness || systemLocked}
                    aria-label={t("Capture system audio for notes")}
                    onCheckedChange={(next) =>
                      onSourceModeChange(next ? "microphonePlusSystem" : "microphoneOnly")
                    }
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
      <ImportSettingsSection />
    </>
  );
}

export function ModelsSettingsTab({
  pickerMode,
  setPickerMode,
  pickerValue,
  pickerOptions,
  modelSearch,
  setModelSearch,
  selectVeniceModel,
  openModelPicker,
  providerSettings,
  transcriptionOptions,
  generationOptions,
  imageOptions,
  showMoreModelOptions,
  setShowMoreModelOptions,
  onOpenCarpeDiemSettings,
  removeVeniceApiKey,
}: {
  pickerMode?: ProviderModelMode;
  setPickerMode: (mode: ProviderModelMode | undefined) => void;
  pickerValue: string;
  pickerOptions: VeniceModelDto[];
  modelSearch: string;
  setModelSearch: (search: string) => void;
  selectVeniceModel: (mode: ProviderModelMode, modelId: string) => Promise<void>;
  openModelPicker: (mode: ProviderModelMode) => void;
  providerSettings: ProviderModelSettingsDto;
  transcriptionOptions: VeniceModelDto[];
  generationOptions: VeniceModelDto[];
  imageOptions: VeniceModelDto[];
  showMoreModelOptions: boolean;
  setShowMoreModelOptions: (update: (open: boolean) => boolean) => void;
  onOpenCarpeDiemSettings: () => void;
  removeVeniceApiKey: () => Promise<void>;
}) {
  return (
    <>
      <ModelPickerDialog
        open={!!pickerMode}
        mode={pickerMode ?? "transcription"}
        value={pickerValue}
        options={pickerOptions}
        search={modelSearch}
        onSearchChange={setModelSearch}
        onClose={() => setPickerMode(undefined)}
        onSelect={(modelId) => {
          if (!pickerMode) return;
          void selectVeniceModel(pickerMode, modelId);
          setPickerMode(undefined);
        }}
      />

      <section className="settings-group" aria-labelledby="models-heading">
        <h2 id="models-heading" className="settings-group-heading">
          {t("AI models")}
        </h2>
        <div className="settings-card">
          <div className="settings-rows">
            <ModelRow
              title={t("Transcription")}
              description={t("Speech-to-text for note recordings and dictation.")}
              value={providerSettings.transcriptionModel}
              options={transcriptionOptions}
              onOpen={() => openModelPicker("transcription")}
            />
            <ModelRow
              title={t("Text")}
              description={t("Used for generated notes and agent responses.")}
              value={providerSettings.generationModel}
              options={generationOptions}
              onOpen={() => openModelPicker("generation")}
            />
            <button
              type="button"
              className="settings-row settings-more-options-trigger"
              aria-expanded={showMoreModelOptions}
              aria-controls="models-more-options"
              onClick={() => setShowMoreModelOptions((open) => !open)}
            >
              <span className="settings-row-info">
                <span className="settings-row-title">{t("More options")}</span>
                <span className="settings-row-description">{t("Advanced model settings.")}</span>
              </span>
              <IconChevronDownSmall
                className="settings-more-options-chevron"
                size={14}
                aria-hidden
              />
            </button>
            {showMoreModelOptions ? (
              <CarpeDiemKeyRow
                id="models-more-options"
                legacyVeniceKeyConfigured={providerSettings.veniceApiKeyConfigured}
                onOpenCarpeDiemSettings={onOpenCarpeDiemSettings}
                onRemoveLegacyKey={() => void removeVeniceApiKey()}
              />
            ) : null}
          </div>
        </div>
      </section>

      {IMAGE_GENERATION_ENABLED ? (
        <section className="settings-group" aria-labelledby="image-generation-heading">
          <h2 id="image-generation-heading" className="settings-group-heading">
            {t("Image generation")}
          </h2>
          <p className="settings-group-description">
            {t("Choose the model Sub Rosa uses when you ask it to generate an image.")}
          </p>
          <div className="settings-card">
            <div className="settings-rows">
              <ModelRow
                title={t("Image")}
                description={t("Used when you generate an image from chat.")}
                value={providerSettings.imageModel}
                options={imageOptions}
                onOpen={() => openModelPicker("image")}
              />
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}

export function AboutSettingsTab({
  onCheckForUpdates,
  releaseChannel,
  handleReleaseChannelChange,
  reconcileVersion,
  onDismissReconcile,
  confirmReconcileToStable,
  onVerifyPageError,
  onReportIssue,
}: {
  onCheckForUpdates?: () => void;
  releaseChannel: ReleaseChannel;
  handleReleaseChannelChange: (next: ReleaseChannel) => void;
  reconcileVersion?: string;
  onDismissReconcile: () => void;
  confirmReconcileToStable: () => void;
  onVerifyPageError: (error: unknown) => void;
  onReportIssue?: (category: ReportCategory) => void;
}) {
  return (
    <section className="settings-group" aria-labelledby="about-heading">
      <h2 id="about-heading" className="settings-group-heading">
        {t("About")}
      </h2>
      <div className="settings-card">
        <div className="settings-rows">
          <div className="settings-row settings-row-meta">
            <div className="settings-row-info">
              <h3 className="settings-row-title settings-meta-label">{t("Release version")}</h3>
            </div>
            <div className="settings-row-control">
              <span className="settings-meta-value">{APP_VERSION}</span>
            </div>
          </div>

          <div className="settings-row settings-row-meta">
            <div className="settings-row-info">
              <h3 className="settings-row-title settings-meta-label">{t("Commit")}</h3>
            </div>
            <div className="settings-row-control">
              <span className="settings-meta-value settings-meta-value-mono">
                {APP_COMMIT_HASH}
              </span>
            </div>
          </div>

          {onCheckForUpdates ? (
            <>
              <div className="settings-row">
                <div className="settings-row-info">
                  <h3 className="settings-row-title">{t("Updates")}</h3>
                  <p className="settings-row-description">
                    {t("Check whether a newer version of Sub Rosa is available.")}
                  </p>
                </div>
                <div className="settings-row-control">
                  <button type="button" className="btn btn-secondary" onClick={onCheckForUpdates}>
                    {t("Check for updates")}
                  </button>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-info">
                  <h3 className="settings-row-title">{t("Release channel")}</h3>
                  <p className="settings-row-description">
                    {t("Stable is recommended. Release candidate gets early builds for testing.")}
                  </p>
                </div>
                <div className="settings-row-control">
                  <SegmentedControl<ReleaseChannel>
                    aria-label={t("Release channel")}
                    value={releaseChannel}
                    options={RELEASE_CHANNEL_OPTIONS}
                    onValueChange={handleReleaseChannelChange}
                  />
                </div>
              </div>

              {reconcileVersion ? (
                <div className="settings-row">
                  <InlineNotice
                    aria-label={t("Switch to stable now")}
                    eyebrow={t("Switch to stable now?")}
                    body={t(
                      "Installs {reconcileVersion}, replacing your release candidate build. You'll get {version} when it reaches stable.",
                      { reconcileVersion: reconcileVersion, version: baseVersion() },
                    )}
                    actions={
                      <>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={onDismissReconcile}
                        >
                          {t("Not now")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={confirmReconcileToStable}
                        >
                          {t("Switch to stable")}
                        </button>
                      </>
                    }
                  />
                </div>
              ) : null}
            </>
          ) : null}

          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">{t("Community")}</h3>
              <p className="settings-row-description">
                {t("Join us in the Sub Rosa community on Telegram at {url}.", {
                  url: JUNE_COMMUNITY_URL.replace("https://", ""),
                })}
              </p>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void juneOpenCommunityPage().catch(() => undefined)}
              >
                {t("Join community")}
              </button>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">{t("Where your data goes")}</h3>
              <p className="settings-row-description">
                {t(
                  "{PRODUCT_NAME}'s backend runs on this machine, on loopback. See what it keeps, what leaves the device, and how to check both yourself.",
                  { PRODUCT_NAME },
                )}
              </p>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void juneOpenVerifyPage().catch(onVerifyPageError)}
              >
                {t("Open")}
              </button>
            </div>
          </div>

          {onReportIssue ? (
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">{t("Report an issue")}</h3>
                <p className="settings-row-description">
                  {t(
                    "Something not working? Describe it to Sub Rosa, attach a screenshot if you have one, and Sub Rosa will send the report to the team along with its own diagnosis.",
                  )}
                </p>
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => onReportIssue("bug")}
                >
                  {t("Report an issue")}
                </button>
              </div>
            </div>
          ) : null}

          {import.meta.env.DEV ? (
            // Dev builds only: same helper the devtools console exposes
            // as june.replayOnboarding() — clears completion and
            // reloads into the wizard.
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">{t("Replay onboarding")}</h3>
                <p className="settings-row-description">
                  {t(
                    "Dev only. Forget that onboarding finished and reload into the first-run wizard.",
                  )}
                </p>
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => replayOnboarding()}
                >
                  {t("Replay onboarding")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

type PermissionStatusTone = "allowed" | "attention" | "blocked" | "unsupported" | "unknown";

type PermissionStatusView = {
  label: string;
  tone: PermissionStatusTone;
};

/** Launch-at-login toggle. Reads and writes the OS login item directly (the
 * LaunchAgent is the single source of truth), so state here can never drift
 * from what System Settings shows. Hidden in browser previews, where no
 * autostart backend exists. */
function StartupSettingsSection() {
  const [enabled, setEnabled] = useState<boolean>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!autostartSupported()) return;
    let cancelled = false;
    autostartEnabled()
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch(() => {
        if (!cancelled) setError(t("Could not read the login item state."));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    setError(undefined);
    try {
      await setAutostartEnabled(next);
      setEnabled(next);
    } catch {
      setError(t("Could not update the login item. Try again."));
    } finally {
      setSaving(false);
    }
  }

  if (!autostartSupported() || (enabled === undefined && !error)) return null;

  return (
    <section className="settings-group" aria-labelledby="startup-heading">
      <h2 id="startup-heading" className="settings-group-heading">
        {t("Startup")}
      </h2>
      <p className="settings-group-description">
        {t(
          "Dictation shortcuts, meeting detection, and scheduled routines only work while Sub Rosa is running.",
        )}
      </p>
      <div className="settings-card">
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">{t("Open Sub Rosa at login")}</h3>
              <p className="settings-row-description">
                {t("Start Sub Rosa automatically when you sign in to your computer.")}
              </p>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={enabled === true}
                disabled={saving || enabled === undefined}
                aria-label={t("Open Sub Rosa at login")}
                onCheckedChange={(next) => void toggle(next)}
              />
            </div>
          </div>
          {error ? <p className="settings-row-description">{error}</p> : null}
        </div>
      </div>
    </section>
  );
}

function PermissionsSettingsSection({
  microphonePermissionStatus,
  microphoneReadiness,
  accessibilityPermissionStatus,
  systemReadiness,
  onEnableMicrophone,
  onEnableAccessibility,
  onEnableSystemAudio,
}: {
  microphonePermissionStatus?: string;
  microphoneReadiness?: RecordingSourceReadinessDto["sources"][number];
  accessibilityPermissionStatus?: string;
  systemReadiness?: RecordingSourceReadinessDto["sources"][number];
  onEnableMicrophone?: () => void;
  onEnableAccessibility?: () => void;
  onEnableSystemAudio: () => void;
}) {
  const macLikePlatform = isMacLikePlatform();
  return (
    <section className="settings-group" aria-labelledby="permissions-heading">
      <h2 id="permissions-heading" className="settings-group-heading">
        {t("System permissions")}
      </h2>
      <p className="settings-group-description">
        {macLikePlatform
          ? t(
              "macOS access used for recording audio, pasting dictation, and capturing system sound.",
            )
          : t("Access used for recording audio.")}
      </p>
      <div className="settings-card">
        <div className="settings-rows">
          <PermissionRow
            title={t("Microphone")}
            description={t("Record dictation and note audio.")}
            status={permissionStatus(
              microphonePermissionStatus ?? microphoneReadiness?.permissionState,
            )}
            onManage={onEnableMicrophone}
          />

          {macLikePlatform ? (
            <>
              <PermissionRow
                title={t("Accessibility")}
                description={t("Paste dictated text into the active app.")}
                status={permissionStatus(accessibilityPermissionStatus)}
                onManage={onEnableAccessibility}
              />

              <PermissionRow
                title={t("System audio")}
                description={t("Record audio from other apps when system audio is enabled.")}
                status={sourcePermissionStatus(systemReadiness)}
                onManage={onEnableSystemAudio}
              />
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function PermissionRow({
  title,
  description,
  status,
  onManage,
}: {
  title: string;
  description: string;
  status: PermissionStatusView;
  onManage?: () => void;
}) {
  const actionDisabled = status.tone === "unsupported" || !onManage;
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <h3 className="settings-row-title">{title}</h3>
        <p className="settings-row-description">{description}</p>
      </div>
      <div className="settings-row-control settings-permission-control">
        <span
          className="settings-permission-status"
          data-status={status.tone}
          role="img"
          aria-label={status.label}
          title={status.label}
        >
          <PermissionStatusIcon tone={status.tone} />
        </span>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={actionDisabled}
          aria-label={t("Manage {title} permission", { title: title })}
          onClick={onManage}
        >
          {t("Manage")}
        </button>
      </div>
    </div>
  );
}

function PermissionStatusIcon({ tone }: { tone: PermissionStatusTone }) {
  if (tone === "allowed") return <IconCircleCheck size={16} />;
  if (tone === "unknown") return <IconCircleQuestionmark size={16} />;
  if (tone === "unsupported") return <IconCircleX size={16} />;
  return <IconExclamationCircle size={16} />;
}

function permissionStatus(state?: string): PermissionStatusView {
  switch (state) {
    case "granted":
      return { label: t("Allowed"), tone: "allowed" };
    case "denied":
      return { label: t("Blocked"), tone: "blocked" };
    case "restricted":
      return { label: t("Restricted"), tone: "blocked" };
    case "missing":
      return { label: t("Needs access"), tone: "attention" };
    case "not_determined":
      return { label: t("Not requested"), tone: "attention" };
    case "unsupported":
      return { label: t("Unsupported"), tone: "unsupported" };
    case "unknown":
      return { label: t("Unknown"), tone: "unknown" };
    default:
      return { label: t("Checking"), tone: "unknown" };
  }
}

function sourcePermissionStatus(
  source?: RecordingSourceReadinessDto["sources"][number],
): PermissionStatusView {
  if (!source) return { label: t("Checking"), tone: "unknown" };
  // The two halves are independent: permissionState is the grant, `ready` is
  // whether this Mac can actually capture. A microphone-only check never asks
  // for the grant, and a granted source can still be uncapturable (the helper
  // reports `system_audio_capture_unavailable`, recoverable by restarting).
  if (source.permissionState === "granted") {
    return source.ready
      ? { label: t("Allowed"), tone: "allowed" }
      : { label: t("Unavailable"), tone: "attention" };
  }
  return permissionStatus(source.permissionState);
}

function ModelRow({
  title,
  description,
  value,
  options,
  onOpen,
}: {
  title: string;
  description: string;
  value: string;
  options: VeniceModelDto[];
  onOpen: () => void;
}) {
  const model = selectedModel(options, value);
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <h3 className="settings-row-title">{title}</h3>
        <p className="settings-row-description">{description}</p>
      </div>
      <div className="settings-row-control settings-model-control">
        <button
          type="button"
          className="model-summary-button"
          onClick={onOpen}
          aria-label={t("Change {value} model", { value: title.toLowerCase() })}
        >
          <span className="model-summary-logo" aria-hidden>
            <ProviderLogo provider={model.provider} id={model.id} name={model.name} />
          </span>
          <span className="model-summary-name">{model.name}</span>
          <IconChevronDownSmall size={14} />
          <span className="model-summary-meta">
            <ModelMeta model={model} />
          </span>
        </button>
      </div>
    </div>
  );
}

function CarpeDiemKeyRow({
  id,
  legacyVeniceKeyConfigured,
  onOpenCarpeDiemSettings,
  onRemoveLegacyKey,
}: {
  id?: string;
  legacyVeniceKeyConfigured: boolean;
  onOpenCarpeDiemSettings: () => void;
  onRemoveLegacyKey: () => void;
}) {
  return (
    <>
      <div id={id} className="settings-row">
        <div className="settings-row-info">
          <h3 className="settings-row-title">{t("Carpe Diem API key")}</h3>
          <p className="settings-row-description">
            {t("Model requests use the Carpe Diem key stored in your system keychain.")}
          </p>
        </div>
        <div className="settings-row-control">
          <button type="button" className="btn btn-secondary" onClick={onOpenCarpeDiemSettings}>
            {t("Manage key")}
          </button>
        </div>
      </div>
      {legacyVeniceKeyConfigured ? (
        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">{t("Legacy Venice key")}</h3>
            <p className="settings-row-description">
              {t(
                "A Venice API key saved by an earlier version overrides your Carpe Diem key on every request. Remove it to use the Carpe Diem key.",
              )}
            </p>
          </div>
          <div className="settings-row-control">
            <button type="button" className="btn btn-secondary" onClick={onRemoveLegacyKey}>
              {t("Remove")}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ShortcutRow({
  title,
  description,
  shortcut,
  defaultShortcut,
  capturing,
  disabled,
  error,
  onChange,
  onReset,
  onCancel,
}: {
  title: string;
  description: string;
  shortcut: DictationShortcutSetting;
  defaultShortcut: DictationShortcutSetting;
  capturing: boolean;
  disabled: boolean;
  error?: string;
  onChange: () => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const canReset = !capturing && !shortcutsMatch(shortcut, defaultShortcut) && !disabled;

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <h3 className="settings-row-title">{title}</h3>
        <p className="settings-row-description">{description}</p>
        {error ? <p className="settings-row-error">{error}</p> : null}
      </div>
      <div className="settings-row-control">
        <KeycapShortcut label={shortcut.label} capturing={capturing} />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={disabled}
          onClick={capturing ? onCancel : onChange}
        >
          {capturing ? t("Cancel") : t("Change")}
        </button>
        {canReset ? (
          <button
            type="button"
            className="btn btn-secondary"
            aria-label={t("Reset {title} shortcut to default", { title: title })}
            onClick={onReset}
          >
            {t("Reset")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function shortcutsMatch(first: DictationShortcutSetting, second: DictationShortcutSetting) {
  const keyCodesMatch =
    first.keyCode === undefined || second.keyCode === undefined || first.keyCode === second.keyCode;

  return (
    keyCodesMatch &&
    first.code === second.code &&
    first.label === second.label &&
    first.pressCount === second.pressCount &&
    first.modifiers.command === second.modifiers.command &&
    first.modifiers.control === second.modifiers.control &&
    first.modifiers.option === second.modifiers.option &&
    first.modifiers.shift === second.modifiers.shift &&
    first.modifiers.function === second.modifiers.function
  );
}

// The base version an rc will become once promoted (0.0.25-rc.2 -> 0.0.25), used
// to reassure the user which stable they will land on when it ships.
function baseVersion() {
  return APP_VERSION.split("-")[0];
}
