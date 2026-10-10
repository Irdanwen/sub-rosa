import { t, type LocaleChoice, localeChoice } from "../../lib/i18n";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  dictationHelperCommand,
  dictationSettings,
  listVeniceModels,
  localAudioFileSrc,
  providerModelSettings,
  clearVeniceApiKey,
  setDictationLanguage,
  setDictationMicrophone,
  setDictationShortcut,
  setVeniceModel,
} from "../../lib/tauri";
import { LANGUAGE_OPTIONS, languageLabel } from "../../lib/dictation-languages";
import type {
  DictationHelperEvent,
  DictationMicrophoneDeviceDto,
  DictationShortcutKind,
  DictationSettingsDto,
  DictationShortcutSetting,
  ProviderModelMode,
  ProviderModelSettingsDto,
  RecordingSourceMode,
  RecordingSourceReadinessDto,
  VeniceModelDto,
} from "../../lib/tauri";
import { AgentBrowserSettingsSection } from "./AgentBrowserSettingsSection";
import {
  MODIFIER_REQUIRED_MESSAGE,
  chordFromKeyEvent,
  shortcutFromCapturePayload,
} from "../shortcuts/use-shortcut-capture";
import {
  selectPopoverPlacement,
  selectPopoverStyle,
  type SelectPopoverPlacement,
} from "../ui/Select";
import { APP_VERSION } from "../../app/build-info";
import type { ReportCategory } from "../agent/composer/reportCategory";
import { getStoredTheme, type ThemePreference } from "../../lib/theme";
import { getStoredBrand, type BrandId } from "../../lib/brand";
import { CarpeDiemSettings } from "./CarpeDiemSettings";
import { AccountSettingsSection } from "./AccountSettingsSection";
import { AutomationsSection } from "./AutomationsSection";
import { MomentsSettingsSection } from "./MomentsSettingsSection";
import { PlacesSettingsSection } from "./PlacesSettingsSection";
import {
  getReleaseChannel,
  reconcileToStable,
  setReleaseChannel,
  type ReleaseChannel,
} from "../../lib/updater";
import { isMacLikePlatform } from "../../lib/platform";
import { usePlatformCapabilities } from "../../lib/platform-capabilities";
import { systemAudioAvailability } from "../../lib/source-readiness";
import { parseDictationHelperEvent } from "../../lib/dictation-events";
import { dispatchProviderModelSettingsChanged } from "../../lib/model-privacy";
import { modelOptions } from "./ModelPickerDialog";
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from "../../lib/image-models";
import { IMAGE_GENERATION_ENABLED } from "../../lib/feature-flags";
import { AgentSettingsSection } from "./AgentSettingsSection";
import { ExternalDirsSection } from "./ExternalDirsSection";
import { InstalledSkillsSection } from "./InstalledSkillsSection";
import { McpDiagnosticsSection } from "./McpDiagnosticsSection";
import { McpSecuritySection } from "./McpSecuritySection";
import { ConnectorsSection } from "./ConnectorsSection";
import { BrowserExtensionSection } from "./BrowserExtensionSection";
import { McpServersSection } from "./McpServersSection";
import { SetupSnapshotSection } from "./SetupSnapshotSection";
import { ArchiveSection } from "./ArchiveSection";
import { ToolsetsSection } from "./ToolsetsSection";
import { CouncilSettingsSection } from "./CouncilSettingsSection";
import { MemorySettingsSection } from "./MemorySettingsSection";
import { PersonalizationSettingsSection } from "./PersonalizationSettingsSection";
import { PrivacySettingsSection } from "./PrivacySettingsSection";
import { ReportsSettingsSection } from "./ReportsSettingsSection";
import { StorageSettingsSection } from "./StorageSettingsSection";
import type { MicTestState } from "./MicTestControl";
import {
  AboutSettingsTab,
  AudioSettingsTab,
  DEFAULT_SETTINGS,
  DictationSettingsTab,
  GeneralSettingsTab,
  MIC_TEST_DURATION_SECONDS,
  ModelsSettingsTab,
  ShortcutsSettingsTab,
} from "./AppSettingsTabs";

const DEFAULT_PROVIDER_MODELS: ProviderModelSettingsDto = {
  transcriptionProvider: "venice",
  transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
  // Mirrors DEFAULT_GENERATION_MODEL in the Rust providers module and the
  // leading Suggested pick in lib/suggested-models.ts.
  generationModel: "zai-org-glm-5-2",
  // Mirrors DEFAULT_IMAGE_MODEL in the Rust providers module.
  imageModel: DEFAULT_IMAGE_MODEL,
  veniceApiKeyConfigured: false,
};

export type SettingsTab =
  | "general"
  | "account"
  | "carpe-diem"
  | "shortcuts"
  | "dictation"
  | "audio"
  | "models"
  | "agent"
  | "personalization"
  | "memory"
  | "privacy"
  | "council"
  | "skills"
  | "external-dirs"
  | "mcp"
  | "connectors"
  | "browser-extension"
  | "mcp-diagnostics"
  | "mcp-security"
  | "toolsets"
  | "import-export"
  | "storage"
  | "reports"
  | "about";

export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: t("General") },
  { id: "account", label: t("Account and sync") },
  { id: "carpe-diem", label: t("Carpe Diem") },
  { id: "shortcuts", label: t("Shortcuts") },
  { id: "dictation", label: t("Dictation") },
  { id: "audio", label: t("Audio") },
  { id: "models", label: t("Models") },
  { id: "agent", label: t("Agent") },
  { id: "personalization", label: t("Personalization") },
  { id: "memory", label: t("Memory") },
  { id: "privacy", label: t("Privacy") },
  { id: "council", label: t("Council") },
  { id: "skills", label: t("Installed skills") },
  { id: "external-dirs", label: t("External skill directories") },
  { id: "mcp", label: t("MCP servers") },
  { id: "connectors", label: t("Connectors") },
  { id: "browser-extension", label: t("Browser extension") },
  { id: "mcp-diagnostics", label: t("MCP diagnostics") },
  { id: "mcp-security", label: t("MCP security") },
  { id: "toolsets", label: t("Toolsets") },
  { id: "import-export", label: t("Import / export") },
  { id: "storage", label: t("Storage") },
  { id: "reports", label: t("Reports") },
  { id: "about", label: t("About") },
];

type AppSettingsProps = {
  sourceMode: RecordingSourceMode;
  sourceReadiness?: RecordingSourceReadinessDto;
  checkingSourceReadiness: boolean;
  microphonePermissionStatus?: string;
  accessibilityPermissionStatus?: string;
  onSourceModeChange: (mode: RecordingSourceMode) => void;
  onEnableMicrophone?: () => void;
  onEnableAccessibility?: () => void;
  onEnableSystemAudio: () => void;
  // When the host (the sidebar settings nav) drives the active section, it
  // passes both of these so AppSettings becomes a controlled panel and hides
  // its own header + in-page tab nav. Left undefined, AppSettings keeps its
  // own nav — the standalone path exercised by app-settings tests.
  activeTab?: SettingsTab;
  onTabChange?: (tab: SettingsTab) => void;
  // Runs the app updater's manual check flow.
  onCheckForUpdates?: () => void;
  // Confirmed leave-rc reconcile: downloads and installs the current stable,
  // even if it is older than the running prerelease build (Q4-Q8).
  onReconcileToStable?: () => void;
  // Opens a new agent session seeded with a report category chip.
  onReportIssue?: (category: ReportCategory) => void;
  // Opens a new agent session that runs a skill bundle's slash command.
};

export function AppSettings({
  sourceMode,
  sourceReadiness,
  checkingSourceReadiness,
  microphonePermissionStatus,
  accessibilityPermissionStatus,
  onSourceModeChange,
  onEnableMicrophone,
  onEnableAccessibility,
  onEnableSystemAudio,
  activeTab: controlledTab,
  onTabChange,
  onCheckForUpdates,
  onReconcileToStable,
  onReportIssue,
}: AppSettingsProps) {
  const [settings, setSettings] = useState<DictationSettingsDto>(DEFAULT_SETTINGS);
  const [providerSettings, setProviderSettings] =
    useState<ProviderModelSettingsDto>(DEFAULT_PROVIDER_MODELS);
  const [veniceModels, setVeniceModels] = useState<Record<ProviderModelMode, VeniceModelDto[]>>({
    transcription: [],
    generation: [],
    // Image options come from a curated local list, not the fetched catalog;
    // this stays empty and `imageOptions` supplies the picker.
    image: [],
  });
  const [microphones, setMicrophones] = useState<DictationMicrophoneDeviceDto[]>([]);
  const [defaultMicrophone, setDefaultMicrophone] = useState<DictationMicrophoneDeviceDto>();
  const [capturingShortcut, setCapturingShortcut] = useState<DictationShortcutKind>();
  const capturingShortcutRef = useRef<DictationShortcutKind>();
  const [shortcutError, setShortcutError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [micOpen, setMicOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(() => getStoredTheme());
  const [language, setLanguage] = useState<LocaleChoice>(() => localeChoice());
  const [brand, setBrand] = useState<BrandId>(() => getStoredBrand());
  const [releaseChannel, setReleaseChannelValue] = useState<ReleaseChannel>("stable");
  // Set only when a leave-rc switch turns up an installable stable, so the
  // bespoke in-context confirm below the toggle can name the exact version.
  const [reconcileVersion, setReconcileVersion] = useState<string>();
  const [pickerMode, setPickerMode] = useState<ProviderModelMode>();
  const [modelSearch, setModelSearch] = useState("");
  const [showMoreModelOptions, setShowMoreModelOptions] = useState(false);
  const [internalTab, setInternalTab] = useState<SettingsTab>("general");
  const [micPopoverPlacement, setMicPopoverPlacement] =
    useState<SelectPopoverPlacement>("align-selected");
  const [languageOpen, setLanguageOpen] = useState(false);
  const [languagePopoverPlacement, setLanguagePopoverPlacement] =
    useState<SelectPopoverPlacement>("align-selected");
  const [micTestState, setMicTestState] = useState<MicTestState>("idle");
  const [micTestLevel, setMicTestLevel] = useState(0);
  const [micTestStartedAt, setMicTestStartedAt] = useState<number>();
  const [micTestElapsedMs, setMicTestElapsedMs] = useState(0);
  const [micTestSampleSrc, setMicTestSampleSrc] = useState<string>();
  const [micTestError, setMicTestError] = useState<string>();
  const [micTestPlaying, setMicTestPlaying] = useState(false);
  const controlled = controlledTab !== undefined && onTabChange !== undefined;
  const activeTab = controlled ? controlledTab : internalTab;
  const settingsTabs = SETTINGS_TABS;
  // What the webview runs on, and what this build compiled in: the second
  // is the one that decides whether a control exists (diagnostics::capabilities).
  const macLikePlatform = isMacLikePlatform();
  const capabilities = usePlatformCapabilities();
  const dictationHotkeyAvailable = capabilities?.dictationHotkey ?? macLikePlatform;
  const setActiveTab = (tab: SettingsTab) => {
    if (controlled) {
      onTabChange?.(tab);
    } else {
      setInternalTab(tab);
    }
  };
  const micWrapRef = useRef<HTMLDivElement>(null);
  const languageWrapRef = useRef<HTMLDivElement>(null);
  const systemOn = sourceMode === "microphonePlusSystem";
  const systemReadiness = sourceReadiness?.sources.find((source) => source.source === "system");
  const microphoneReadiness = sourceReadiness?.sources.find(
    (source) => source.source === "microphone",
  );
  const systemAvailability = systemAudioAvailability(sourceReadiness);
  // Denied and granted-but-uncapturable both lock the switch, but only a real
  // denial is fixable in System Settings: the uncapturable helper recovers on
  // restart, so sending the user to grant an already-granted permission would
  // be a dead end. The status label tells the two apart.
  const systemDenied = systemAvailability === "denied";
  const systemLocked = systemDenied || systemAvailability === "unavailable";
  const systemUnavailable = !macLikePlatform || systemAvailability === "unsupported";

  useEffect(() => {
    capturingShortcutRef.current = capturingShortcut;
  }, [capturingShortcut]);

  // Load the persisted release channel once the updater is available. Gated on
  // a stable boolean (not the onCheckForUpdates prop itself, which is an inline
  // arrow with a new identity each render) so this loads once, not per render.
  const updaterAvailable = Boolean(onCheckForUpdates);
  useEffect(() => {
    if (!updaterAvailable) return;
    let active = true;
    void getReleaseChannel()
      .then((channel) => {
        if (active) setReleaseChannelValue(channel);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [updaterAvailable]);

  const handleReleaseChannelChange = (next: ReleaseChannel) => {
    setReleaseChannelValue(next);
    // Any channel change dismisses a stale reconcile offer (e.g. toggling back
    // to rc, or stable -> rc -> stable) before we decide whether to re-offer.
    setReconcileVersion(undefined);
    void setReleaseChannel(next)
      .then(() => {
        // Leaving rc for stable while running a prerelease build: stable is
        // normally older than the rc you are on, so a routine check would never
        // pull it. Offer a one-time reconcile down onto the current stable (Q4-Q8).
        if (next === "stable" && isPrereleaseBuild()) {
          void offerReconcileToStable();
        }
      })
      .catch(() => {
        // Persist failed: re-read so the toggle reflects the real saved channel
        // rather than an optimistic value that never reached disk.
        void getReleaseChannel()
          .then(setReleaseChannelValue)
          .catch(() => undefined);
      });
  };

  async function offerReconcileToStable() {
    try {
      const update = await reconcileToStable();
      // Only prompt when a stable is actually installable. If stable has already
      // caught up or passed the rc, the routine updater handles it (no reconcile).
      if (update) setReconcileVersion(update.version);
    } catch {
      // A failed reconcile check is silent: the channel is already saved and the
      // routine update flow will retry on its next check.
    }
  }

  function confirmReconcileToStable() {
    setReconcileVersion(undefined);
    onReconcileToStable?.();
  }

  useEffect(() => {
    setMicOpen(false);
    setLanguageOpen(false);
    if (activeTab !== "audio" && micTestState !== "idle") {
      void resetMicTestState(true);
    }
  }, [activeTab]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    async function boot() {
      try {
        const response = await dictationSettings();
        if (cancelled) return;
        setSettings(response.settings);
        const modelResponse = await providerModelSettings();
        if (cancelled) return;
        // Merge over defaults so a settings payload that predates a field
        // (e.g. imageModel from an older backend) still has every model set.
        setProviderSettings({
          ...DEFAULT_PROVIDER_MODELS,
          ...modelResponse.settings,
        });
        await requestMicrophones();
        await Promise.all([
          requestVeniceModels("transcription"),
          requestVeniceModels("generation"),
        ]);
      } catch (error) {
        if (!cancelled) setStatus(messageFromError(error));
      }
    }

    void listen<string>("dictation-event", (event) => {
      const helperEvent = parseDictationHelperEvent(event.payload);
      if (helperEvent) handleHelperEvent(helperEvent);
    }).then((cleanup) => {
      // Unmount can race the listen() promise — unsubscribe immediately
      // instead of leaking the listener.
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    void boot();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!micOpen) return;
    function onPointer(event: MouseEvent) {
      if (!micWrapRef.current?.contains(event.target as Node)) {
        setMicOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMicOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [micOpen]);

  useEffect(() => {
    if (!languageOpen) return;
    function onPointer(event: MouseEvent) {
      if (!languageWrapRef.current?.contains(event.target as Node)) {
        setLanguageOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setLanguageOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [languageOpen]);

  // The capture effect below must call the latest saveShortcut, not the one
  // from the render in which capturing began (it is a plain function,
  // redefined every render). Same ref pattern as use-shortcut-capture.
  const saveShortcutRef = useRef(saveShortcut);
  useEffect(() => {
    saveShortcutRef.current = saveShortcut;
  });

  useEffect(() => {
    if (!capturingShortcut) return;
    const kind = capturingShortcut;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancelShortcutCapture();
        return;
      }
      // Key chords are read here in the DOM (the window is focused during a
      // rebind); the helper's flagsChanged monitor only contributes fn and
      // bare-modifier chords. This split is what lets the helper run without
      // the Input Monitoring permission.
      const result = chordFromKeyEvent(event);
      if (result.kind === "ignore") return;
      event.preventDefault();
      event.stopPropagation();
      if (result.kind === "needsModifier") {
        setShortcutError(MODIFIER_REQUIRED_MESSAGE);
        setStatus(MODIFIER_REQUIRED_MESSAGE);
        return;
      }
      setShortcutError(undefined);
      void dictationHelperCommand({ type: "cancel_shortcut_capture" }).catch(() => undefined);
      void saveShortcutRef.current(kind, result.shortcut);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturingShortcut]);

  async function requestMicrophones() {
    try {
      await dictationHelperCommand({ type: "list_microphones" });
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function requestVeniceModels(mode: ProviderModelMode) {
    try {
      const response = await listVeniceModels(mode);
      setVeniceModels((models) => ({
        ...models,
        [mode]: response.models,
      }));
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  function handleHelperEvent(helperEvent: DictationHelperEvent) {
    if (helperEvent.type === "microphone_devices") {
      setMicrophones(helperEvent.payload?.devices ?? []);
      setDefaultMicrophone(helperEvent.payload?.defaultDevice);
      return;
    }
    if (helperEvent.type === "mic_test_started") {
      setMicTestState("recording");
      setMicTestError(undefined);
      setMicTestSampleSrc(undefined);
      setMicTestLevel(0);
      setMicTestStartedAt(Date.now());
      setMicTestElapsedMs(0);
      setMicTestPlaying(false);
      return;
    }
    if (helperEvent.type === "mic_test_level") {
      setMicTestLevel(numericPayload(helperEvent.payload?.level));
      return;
    }
    if (helperEvent.type === "mic_test_ready") {
      const path = stringPayload(helperEvent.payload?.path);
      if (!path) {
        setMicTestState("error");
        setMicTestError("Microphone test did not return a playable sample.");
        return;
      }
      setMicTestState("ready");
      setMicTestStartedAt(undefined);
      setMicTestElapsedMs(0);
      setMicTestLevel(numericPayload(helperEvent.payload?.observedAudioLevel));
      setMicTestError(undefined);
      setMicTestPlaying(false);
      setMicTestSampleSrc(localAudioFileSrc(path));
      return;
    }
    if (helperEvent.type === "mic_test_error") {
      const message = helperEvent.payload?.message ?? "Microphone test could not record.";
      setMicTestState("error");
      setMicTestStartedAt(undefined);
      setMicTestError(message);
      setMicTestPlaying(false);
      setStatus(message);
      return;
    }
    if (helperEvent.type === "fn_monitor_unavailable") {
      setStatus(helperEvent.payload?.message ?? "Global shortcut monitoring is unavailable.");
      return;
    }
    if (helperEvent.type === "shortcut_capture_started") {
      setStatus(t("Press the shortcut to record it."));
      return;
    }
    if (helperEvent.type === "shortcut_capture_error") {
      const message = helperEvent.payload?.message ?? "Shortcut could not be captured.";
      setShortcutError(message);
      setStatus(message);
      return;
    }
    if (helperEvent.type === "shortcut_captured") {
      const kind = capturingShortcutRef.current;
      if (!kind) {
        setShortcutError("Shortcut capture returned without an active target.");
        setStatus(t("Shortcut capture returned without an active target."));
        return;
      }
      const shortcut = shortcutFromCapturePayload(helperEvent.payload?.shortcut, 1);
      if (!shortcut) {
        setShortcutError("Shortcut capture returned invalid data.");
        setStatus(t("Shortcut capture returned invalid data."));
        return;
      }
      setShortcutError(undefined);
      void saveShortcut(kind, shortcut);
      return;
    }
    if (helperEvent.type === "error") {
      setStatus(helperEvent.payload?.message ?? "Settings helper failed.");
    }
  }

  async function selectMicrophone(id?: string, name?: string) {
    try {
      if (micTestState !== "idle") {
        await resetMicTestState(true);
      }
      const next = await setDictationMicrophone(id, name);
      setSettings(next);
      setMicOpen(false);
      setStatus(
        name ? t("Microphone set to {name}.", { name }) : t("Microphone set to auto-detect."),
      );
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function saveShortcut(
    kind: DictationShortcutKind,
    shortcut: Pick<DictationShortcutSetting, "code" | "modifiers" | "label" | "pressCount">,
  ) {
    try {
      const next = await setDictationShortcut(kind, shortcut);
      setSettings(next);
      setCapturingShortcut(undefined);
      setStatus(
        t("{kind} set to {shortcut}.", {
          kind: shortcutKindLabel(kind),
          shortcut: shortcutForKind(next, kind).label,
        }),
      );
    } catch (error) {
      setShortcutError(messageFromError(error));
      setStatus(messageFromError(error));
    }
  }

  async function startShortcutCapture(kind: DictationShortcutKind) {
    setShortcutError(undefined);
    setCapturingShortcut(kind);
    try {
      await dictationHelperCommand({
        type: "start_shortcut_capture",
        pressCount: 1,
      });
    } catch (error) {
      setCapturingShortcut(undefined);
      setShortcutError(messageFromError(error));
      setStatus(messageFromError(error));
    }
  }

  async function cancelShortcutCapture() {
    setCapturingShortcut(undefined);
    setShortcutError(undefined);
    try {
      await dictationHelperCommand({ type: "cancel_shortcut_capture" });
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function startMicTest() {
    setMicTestState("recording");
    setMicTestError(undefined);
    setMicTestSampleSrc(undefined);
    setMicTestLevel(0);
    setMicTestStartedAt(Date.now());
    setMicTestElapsedMs(0);
    setMicTestPlaying(false);
    try {
      await dictationHelperCommand({
        type: "start_mic_test",
        durationSeconds: MIC_TEST_DURATION_SECONDS,
      });
    } catch (error) {
      const message = messageFromError(error);
      setMicTestState("error");
      setMicTestStartedAt(undefined);
      setMicTestError(message);
      setStatus(message);
    }
  }

  async function startOverMicTest() {
    await resetMicTestState(true);
    await startMicTest();
  }

  async function resetMicTestState(discardHelper = false) {
    setMicTestState("idle");
    setMicTestLevel(0);
    setMicTestStartedAt(undefined);
    setMicTestElapsedMs(0);
    setMicTestSampleSrc(undefined);
    setMicTestError(undefined);
    setMicTestPlaying(false);
    if (!discardHelper) return;
    try {
      await dictationHelperCommand({ type: "discard_mic_test" });
    } catch {
      // Resetting the settings UI should not surface stale helper cleanup errors.
    }
  }

  async function selectVeniceModel(mode: ProviderModelMode, modelId: string) {
    try {
      const next = await setVeniceModel(mode, modelId);
      setProviderSettings(next);
      dispatchProviderModelSettingsChanged({ mode, modelId });
      setStatus(
        mode === "transcription"
          ? t("Transcription model updated.")
          : mode === "image"
            ? t("Image model updated.")
            : t("Text model updated."),
      );
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function removeVeniceApiKey() {
    try {
      const next = await clearVeniceApiKey();
      setProviderSettings(next);
      setStatus(t("Legacy Venice key removed."));
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function selectLanguage(language: string) {
    try {
      const next = await setDictationLanguage(language || undefined);
      setSettings(next);
      setLanguageOpen(false);
      setStatus(
        language
          ? t("Default transcription language set to {language}.", {
              language: languageLabel(language),
            })
          : t("Default transcription language set to auto-detect."),
      );
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  const microphoneName = settings.microphone.name ?? t("Auto-detect");
  const microphoneDescription = settings.microphone.id
    ? t("Input device used for dictation.")
    : defaultMicrophone?.name
      ? t("Auto-detect uses {name}.", { name: defaultMicrophone.name })
      : t("Auto-detect uses the current system input.");
  const microphoneOptions = [{ id: undefined, name: t("Auto-detect") }, ...microphones];
  const selectedMicrophoneIndex = Math.max(
    0,
    microphoneOptions.findIndex((option) => (option.id ?? "") === (settings.microphone.id ?? "")),
  );
  const selectedLanguageIndex = Math.max(
    0,
    LANGUAGE_OPTIONS.findIndex((option) => option.value === (settings.language ?? "")),
  );
  const transcriptionOptions = modelOptions(
    veniceModels.transcription,
    providerSettings.transcriptionModel,
  );
  const generationOptions = modelOptions(veniceModels.generation, providerSettings.generationModel);
  const imageOptions = IMAGE_GENERATION_ENABLED
    ? modelOptions(IMAGE_MODELS, providerSettings.imageModel)
    : [];
  const pickerOptions = pickerMode ? modelOptionsForMode(pickerMode) : [];
  const pickerValue = pickerMode ? modelValueForMode(pickerMode) : "";

  useEffect(() => {
    if (micOpen) updateMicrophonePopoverPlacement();
  }, [micOpen, microphoneOptions.length, selectedMicrophoneIndex]);

  useEffect(() => {
    if (languageOpen) updateLanguagePopoverPlacement();
  }, [languageOpen, selectedLanguageIndex]);

  useEffect(() => {
    if (micTestState !== "recording" || !micTestStartedAt) return;
    const interval = window.setInterval(() => {
      setMicTestElapsedMs(Date.now() - micTestStartedAt);
    }, 100);
    return () => window.clearInterval(interval);
  }, [micTestState, micTestStartedAt]);

  function updateMicrophonePopoverPlacement() {
    setMicPopoverPlacement(
      selectPopoverPlacement(micWrapRef.current, microphoneOptions.length, selectedMicrophoneIndex),
    );
  }

  function updateLanguagePopoverPlacement() {
    setLanguagePopoverPlacement(
      selectPopoverPlacement(
        languageWrapRef.current,
        LANGUAGE_OPTIONS.length,
        selectedLanguageIndex,
      ),
    );
  }

  function modelOptionsForMode(mode: ProviderModelMode) {
    if (mode === "transcription") return transcriptionOptions;
    if (mode === "image") return IMAGE_GENERATION_ENABLED ? imageOptions : [];
    return generationOptions;
  }

  function modelValueForMode(mode: ProviderModelMode) {
    if (mode === "transcription") return providerSettings.transcriptionModel;
    if (mode === "image") return providerSettings.imageModel;
    return providerSettings.generationModel;
  }

  function openModelPicker(mode: ProviderModelMode) {
    if (mode === "image" && !IMAGE_GENERATION_ENABLED) return;
    setPickerMode(mode);
    setModelSearch("");
    // Image models are a curated local list, not a fetched catalog.
    if (mode !== "image") void requestVeniceModels(mode);
  }

  function microphonePopoverStyle(): CSSProperties {
    return selectPopoverStyle(micPopoverPlacement, selectedMicrophoneIndex);
  }

  function languagePopoverStyle(): CSSProperties {
    return selectPopoverStyle(languagePopoverPlacement, selectedLanguageIndex);
  }

  return (
    <div className="settings-page" data-controlled={controlled || undefined}>
      {controlled ? null : (
        <>
          <header className="settings-header">
            <h1 className="settings-title">{t("Settings")}</h1>
            <p className="settings-description">
              {t("Manage audio, dictation, AI models, and agent capabilities.")}
            </p>
          </header>

          <nav className="settings-nav" role="tablist" aria-label={t("Settings sections")}>
            {settingsTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`settings-panel-${tab.id}`}
                id={`settings-tab-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </>
      )}

      <div
        className="settings-tab-panel"
        role="tabpanel"
        // Remount per tab so the section cross-fades in instead of teleporting.
        key={activeTab}
        id={`settings-panel-${activeTab}`}
        aria-labelledby={`settings-tab-${activeTab}`}
      >
        {activeTab === "account" ? <AccountSettingsSection /> : null}
        {activeTab === "carpe-diem" ? (
          <>
            <CarpeDiemSettings />
            <PlacesSettingsSection />
          </>
        ) : null}
        {activeTab === "general" ? (
          <GeneralSettingsTab
            theme={theme}
            setTheme={setTheme}
            language={language}
            setLanguage={setLanguage}
            brand={brand}
            setBrand={setBrand}
            microphonePermissionStatus={microphonePermissionStatus}
            microphoneReadiness={microphoneReadiness}
            accessibilityPermissionStatus={accessibilityPermissionStatus}
            systemReadiness={systemReadiness}
            onEnableMicrophone={onEnableMicrophone}
            onEnableAccessibility={onEnableAccessibility}
            onEnableSystemAudio={onEnableSystemAudio}
          />
        ) : null}

        {activeTab === "shortcuts" ? (
          <ShortcutsSettingsTab
            dictationHotkeyAvailable={dictationHotkeyAvailable}
            capabilities={capabilities}
            settings={settings}
            capturingShortcut={capturingShortcut}
            shortcutError={shortcutError}
            startShortcutCapture={startShortcutCapture}
            saveShortcut={saveShortcut}
            cancelShortcutCapture={cancelShortcutCapture}
          />
        ) : null}

        {activeTab === "dictation" ? (
          <DictationSettingsTab
            settings={settings}
            languageWrapRef={languageWrapRef}
            languageOpen={languageOpen}
            setLanguageOpen={setLanguageOpen}
            languagePopoverPlacement={languagePopoverPlacement}
            languagePopoverStyle={languagePopoverStyle()}
            selectLanguage={selectLanguage}
          />
        ) : null}

        {activeTab === "audio" ? (
          <AudioSettingsTab
            settings={settings}
            microphoneName={microphoneName}
            microphoneDescription={microphoneDescription}
            microphoneOptions={microphoneOptions}
            micWrapRef={micWrapRef}
            micOpen={micOpen}
            setMicOpen={setMicOpen}
            micPopoverPlacement={micPopoverPlacement}
            microphonePopoverStyle={microphonePopoverStyle()}
            requestMicrophones={requestMicrophones}
            selectMicrophone={selectMicrophone}
            macLikePlatform={macLikePlatform}
            micTestState={micTestState}
            micTestLevel={micTestLevel}
            micTestElapsedMs={micTestElapsedMs}
            micTestSampleSrc={micTestSampleSrc}
            micTestError={micTestError}
            micTestPlaying={micTestPlaying}
            startMicTest={startMicTest}
            startOverMicTest={startOverMicTest}
            onMicTestPlaybackError={() => {
              setMicTestError("Microphone test recorded, but playback is unavailable.");
            }}
            setMicTestPlaying={setMicTestPlaying}
            systemUnavailable={systemUnavailable}
            systemDenied={systemDenied}
            systemLocked={systemLocked}
            systemOn={systemOn}
            checkingSourceReadiness={checkingSourceReadiness}
            onEnableSystemAudio={onEnableSystemAudio}
            onSourceModeChange={onSourceModeChange}
          />
        ) : null}

        {activeTab === "models" ? (
          <ModelsSettingsTab
            pickerMode={pickerMode}
            setPickerMode={setPickerMode}
            pickerValue={pickerValue}
            pickerOptions={pickerOptions}
            modelSearch={modelSearch}
            setModelSearch={setModelSearch}
            selectVeniceModel={selectVeniceModel}
            openModelPicker={openModelPicker}
            providerSettings={providerSettings}
            transcriptionOptions={transcriptionOptions}
            generationOptions={generationOptions}
            imageOptions={imageOptions}
            showMoreModelOptions={showMoreModelOptions}
            setShowMoreModelOptions={setShowMoreModelOptions}
            onOpenCarpeDiemSettings={() => setActiveTab("carpe-diem")}
            removeVeniceApiKey={removeVeniceApiKey}
          />
        ) : null}

        {activeTab === "agent" ? <AgentSettingsSection /> : null}
        {activeTab === "agent" ? <AgentBrowserSettingsSection /> : null}
        {activeTab === "privacy" ? <PrivacySettingsSection /> : null}
        {activeTab === "personalization" ? <PersonalizationSettingsSection /> : null}
        {activeTab === "memory" ? (
          <>
            <MemorySettingsSection />
            <MomentsSettingsSection />
            <AutomationsSection />
          </>
        ) : null}

        {activeTab === "council" ? <CouncilSettingsSection /> : null}

        {activeTab === "reports" ? <ReportsSettingsSection /> : null}
        {activeTab === "storage" ? <StorageSettingsSection /> : null}

        {activeTab === "skills" ? <InstalledSkillsSection /> : null}
        {activeTab === "external-dirs" ? <ExternalDirsSection /> : null}

        {activeTab === "mcp" ? <McpServersSection /> : null}
        {activeTab === "connectors" ? <ConnectorsSection /> : null}
        {activeTab === "browser-extension" ? <BrowserExtensionSection /> : null}
        {activeTab === "mcp-diagnostics" ? <McpDiagnosticsSection /> : null}
        {activeTab === "mcp-security" ? <McpSecuritySection /> : null}
        {activeTab === "toolsets" ? <ToolsetsSection /> : null}
        {activeTab === "import-export" ? (
          <>
            <ArchiveSection />
            <SetupSnapshotSection />
          </>
        ) : null}

        {activeTab === "about" ? (
          <AboutSettingsTab
            onCheckForUpdates={onCheckForUpdates}
            releaseChannel={releaseChannel}
            handleReleaseChannelChange={handleReleaseChannelChange}
            reconcileVersion={reconcileVersion}
            onDismissReconcile={() => setReconcileVersion(undefined)}
            confirmReconcileToStable={confirmReconcileToStable}
            onVerifyPageError={(err: unknown) => setStatus(messageFromError(err))}
            onReportIssue={onReportIssue}
          />
        ) : null}
      </div>
    </div>
  );
}

function stringPayload(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numericPayload(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed));
  }
  return 0;
}

function shortcutKindLabel(kind: DictationShortcutKind) {
  return kind === "toggle" ? t("Toggle dictation") : t("Push to talk");
}

function shortcutForKind(settings: DictationSettingsDto, kind: DictationShortcutKind) {
  return kind === "toggle" ? settings.toggleShortcut : settings.pushToTalkShortcut;
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

// The running build is a release candidate (X.Y.Z-rc.N). Only these get the
// leave-rc reconcile offer; a clean stable build has nothing to reconcile.
function isPrereleaseBuild() {
  return APP_VERSION.includes("-rc");
}
