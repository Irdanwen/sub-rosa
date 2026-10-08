import { handOffImagePrompt } from "../../lib/studio/prompt-handoff";
import { AssistantChatScreen } from "../../components/mobile/screens/assistants/AssistantChatScreen";
import { AssistantCreator } from "../../components/mobile/screens/assistants/AssistantCreator";
import { AssistantEditor } from "../../components/mobile/screens/assistants/AssistantEditor";
import { AssistantHistory } from "../../components/mobile/screens/assistants/AssistantHistory";
import { AssistantReferencesScreen } from "../../components/mobile/screens/assistants/AssistantReferencesScreen";
import { AssistantsHome } from "../../components/mobile/screens/assistants/AssistantsHome";
import { useAccountLibrarySync } from "../useAccountLibrarySync";
import { t } from "../../lib/i18n";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { BrandGradientMark } from "../../components/brand/Marks";
import { CarpeDiemGate } from "../../components/carpe-diem/CarpeDiemGate";
import { RailSwitchBanner } from "../../components/carpe-diem/RailSwitchBanner";
import { ReflexNotice } from "../../components/carpe-diem/ReflexNotice";
import { AddCreditsHost } from "../../components/carpe-diem/AddCreditsDialog";
import { notifyCreditsChanged } from "../../lib/credits-events";
import { SIDECAR_STATUS_EVENT } from "../../components/settings/CarpeDiemSettings";
import { TabBar } from "../../components/mobile/TabBar";
import { OPEN_NOTE_FROM_CHAT_EVENT } from "../../lib/chat-blocks-nav";
import { ASK_ABOUT_SELECTION_EVENT } from "../../lib/ask-selection";
import { OPEN_CANVAS_EVENT, type OpenCanvasDetail } from "../../lib/canvas";
import { CanvasPane } from "../../components/canvas/CanvasPane";
import { LibraryView } from "../../components/library/LibraryView";
import { TodayScreen } from "../../components/mobile/screens/TodayScreen";
import { MeetingAmbiguityPrompt } from "../../components/calendar/MeetingContext";
import { linkRecordingToMeeting } from "../../lib/calendar-link";
import type { AgentLiteAttachment, CalendarEventDto } from "../../lib/tauri";
import { importMediaFile } from "../../lib/import-media";
import { previewIngestLink, startLinkIngest } from "../../lib/tauri";
import type { Destination } from "../../lib/destinations";
import type { IntentRequest } from "../../lib/intents";
import { importSharedItem } from "../../lib/share-inbox";
import { composerAttachment } from "./sharedAttachment";
import { useAmbientActivity } from "./useAmbientActivity";
import { usePythonBridge } from "../../lib/python/usePythonBridge";
import { observeStandaloneImageJobs } from "../../lib/studio/image-job-recovery";
import { OPEN_COMPOSE_EVENT } from "../../lib/studio/compose/jobs";
import { OPEN_RETOUCH_EVENT } from "../../lib/studio/retouch/jobs";
import { ComposeScreen } from "../../components/mobile/screens/studio/ComposeScreen";
import { RetouchScreen } from "../../components/mobile/screens/studio/RetouchScreen";
import { AgentScreen, AgentSessionScreen } from "../../components/mobile/screens/AgentScreen";
import { PersonalDataScreen } from "../../components/mobile/screens/PersonalDataScreen";
import { StackHeader } from "../../components/mobile/StackHeader";
import { DictationScreen } from "../../components/mobile/screens/DictationScreen";
import { FolderScreen } from "../../components/mobile/screens/FoldersScreen";
import { ProjectSettingsScreen } from "../../components/mobile/screens/ProjectSettingsScreen";
import { NoteDetailScreen } from "../../components/mobile/screens/NoteDetailScreen";
import { NotesScreen } from "../../components/mobile/screens/NotesScreen";
import { ConnectionScreen } from "../../components/mobile/screens/ConnectionScreen";
import { MemoryScreen } from "../../components/mobile/screens/MemoryScreen";
import { ConnectorsScreen } from "../../components/mobile/screens/ConnectorsScreen";
import { SkillsScreen } from "../../components/mobile/screens/SkillsScreen";
import { PersonalizationScreen } from "../../components/mobile/screens/PersonalizationScreen";
import {
  AboutScreen,
  AccountScreen,
  ArchiveScreen,
  ModelsScreen,
  PrivacyScreen,
  ReportsScreen,
} from "../../components/mobile/screens/SectionScreen";
import { UsageScreen } from "../../components/mobile/screens/UsageScreen";
import { SettingsScreen } from "../../components/mobile/screens/SettingsScreen";
import { StudioScreen } from "../../components/mobile/screens/StudioScreen";
import { errorCode, messageFromError } from "../../lib/errors";
import { hapticImpact, hapticNotify } from "../../lib/haptics";
import { useKeyboardInset } from "../../lib/keyboard-inset";
import { upsertLiveTranscriptEvent } from "../../lib/live-transcript-preview";
import { recordingToStatus } from "../../lib/recording-status";
import { moveNoteToFolder } from "../../lib/note-folders";
import {
  LIVE_TRANSCRIPT_EVENT,
  type CarpeDiemSidecarStatusDto,
  type LiveTranscriptEventDto,
  type RecordingSourceReadinessDto,
  NOTES_CHANGED_EVENT,
  assignNoteToFolder,
  bootstrapApp,
  recoverRecording,
  carpeDiemSidecarStatus,
  checkRecordingSourceReadiness,
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  finishRecording,
  getNote,
  getRecordingStatus,
  pauseRecording,
  removeNoteFromFolder,
  renameFolder,
  resumeRecording,
  retryProcessing,
  startRecording,
  updateNote,
} from "../../lib/tauri";
import { PROCESSING_DEMO_NOTE_ID, shouldPollProcessingStatus } from "../processing-polling";
import { createInitialState, notesReducer } from "../state/app-state";
import { useMobileNav } from "./nav";
import { useDestinationQueue } from "./useDestinationQueue";
import { useMobileBootstrap } from "./useMobileBootstrap";
import { Spinner } from "../../components/ui/Spinner";

/** Just under the shell's own patience with the sidecar, so the wait is named
 * before it is abandoned. Keep below SIDECAR_STATUS_TIMEOUT_MS in App.tsx. */
const SHELL_LOADING_SLOW_MS = 6_000;
import { useScrollRestoration } from "./useScrollRestoration";
import { scanDocument, supportsDocumentScan } from "../../lib/scan";

/**
 * Error banner with a real exit path: replacing the message re-runs the
 * entrance (keyed), and clearing it plays a short leave transition before
 * unmount instead of hard-popping away mid-glance.
 */
function MobileErrorBanner({ error, onDismiss }: { error: string | null; onDismiss: () => void }) {
  const [shown, setShown] = useState<string | null>(error);
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (error) {
      setShown(error);
      setExiting(false);
      return;
    }
    // Error cleared: play the leave, then drop the banner. (With nothing
    // shown these set states that are already null/false — harmless.)
    setExiting(true);
    const timer = window.setTimeout(() => {
      setShown(null);
      setExiting(false);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [error]);
  if (!shown) return null;
  return (
    <button
      type="button"
      className="mobile-error-banner"
      key={shown}
      data-exiting={exiting || undefined}
      onClick={onDismiss}
      aria-label={t("Dismiss error")}
    >
      {shown}
    </button>
  );
}

/**
 * The iPhone/Android shell: bottom tab bar plus per-tab push stacks, reusing
 * the desktop state reducer, IPC layer, and feature components (NoteEditor,
 * CarpeDiemSettings) without the desktop chrome (sidebar, tab strip, HUDs).
 * Desktop keeps `App`; `src/main.tsx` picks the shell per platform.
 */
export function MobileApp() {
  useEffect(() => observeStandaloneImageJobs(), []);
  const [state, dispatch] = useReducer(notesReducer, undefined, createInitialState);
  const [error, setError] = useState<string | null>(null);
  const { chatBusy, studioBusy } = useAmbientActivity();
  // The chat's run_python tool answers through here (ADR-0086).
  usePythonBridge();

  // Errors slide in at the top and clear themselves; lingering red banners
  // read as a broken app and can sit over the header forever.
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [error]);
  const [liveTranscriptEvents, setLiveTranscriptEvents] = useState<LiveTranscriptEventDto[]>([]);
  const [sourceReadiness, setSourceReadiness] = useState<RecordingSourceReadinessDto | undefined>();
  const nav = useMobileNav();
  // A picture opened for retouch anywhere in the Studio lands on its session,
  // pushed over the Studio tab.
  const { tab: navTab, switchTab, push } = nav;
  useEffect(() => {
    const onOpen = (event: Event) => {
      const artifactId = (event as CustomEvent<string>).detail;
      if (typeof artifactId !== "string" || !artifactId) return;
      if (navTab !== "studio") switchTab("studio");
      push({ view: "studio-retouch", artifactId });
    };
    window.addEventListener(OPEN_RETOUCH_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_RETOUCH_EVENT, onOpen);
  }, [navTab, switchTab, push]);
  // And one opened for a composition lands on the composer.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const artifactId = (event as CustomEvent<string>).detail;
      if (typeof artifactId !== "string" || !artifactId) return;
      if (navTab !== "studio") switchTab("studio");
      push({ view: "studio-compose", artifactId });
    };
    window.addEventListener(OPEN_COMPOSE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_COMPOSE_EVENT, onOpen);
  }, [navTab, switchTab, push]);
  useAccountLibrarySync(dispatch, nav.top?.view === "note" ? nav.top.noteId : undefined);
  // The Chat tab roots on a conversation, not the history list. The active
  // session id lives here rather than in the screen because navigation
  // remounts screens; the epoch key forces a clean remount when the
  // conversation is swapped (new chat, or a chat picked from history).
  const [agentSessionId, setAgentSessionId] = useState<string | undefined>(undefined);
  const [agentChatEpoch, setAgentChatEpoch] = useState(0);
  const openChatSession = useCallback((sessionId?: string) => {
    setAgentSessionId(sessionId);
    setAgentChatEpoch((epoch) => epoch + 1);
  }, []);
  /** Text waiting for the next fresh chat screen (`chat?q=`, a Shortcuts
   * action), and whether it may be sent without a tap. */
  const [pendingChat, setPendingChat] = useState<{ text: string; send: boolean } | null>(null);
  /** Pictures and documents shared in (ADR-0095), waiting for the chat's
   * composer. A batch accumulates here and lands in one fresh chat. */
  const [pendingAttachments, setPendingAttachments] = useState<AgentLiteAttachment[]>([]);
  const takeAttachments = useCallback(() => setPendingAttachments([]), []);
  /** A link to open the Import sheet on: a video page this phone cannot
   * read, which the sheet offers to send to a computer (ADR-0054). */
  const [importLink, setImportLink] = useState<string | null>(null);
  const keyboardInset = useKeyboardInset();

  // Screen-entrance direction: push slides in from the right, pop settles
  // back from the left, tab switches cross-fade. Derived with the render-time
  // setState pattern (StrictMode-safe, unlike a ref mutated during render).
  const [navMark, setNavMark] = useState<{
    tab: typeof nav.tab;
    depth: number;
    motion?: "push" | "pop" | "tab";
  }>({ tab: nav.tab, depth: nav.depth });
  if (navMark.tab !== nav.tab || navMark.depth !== nav.depth) {
    setNavMark({
      tab: nav.tab,
      depth: nav.depth,
      motion: navMark.tab !== nav.tab ? "tab" : nav.depth > navMark.depth ? "push" : "pop",
    });
  }
  const navMotion =
    navMark.tab === nav.tab && navMark.depth === nav.depth ? navMark.motion : undefined;

  // Interactive edge-swipe back: a drag that starts on the left edge tracks
  // the finger (the screen translates live, styled directly on the element so
  // no re-render runs per frame), then commits past 35% width or a right
  // flick, mirroring the platform's back gesture.
  const screenRef = useRef<HTMLDivElement | null>(null);
  // The screen wrapper is keyed by tab and depth, so it remounts on every move
  // through the stack and takes the scroll position with it. This puts it back.
  // Off on a conversation (the agent tab, an assistant's chat): it places its
  // own scroll, pinning to the last message, and two owners of `scrollTop` is
  // a fight you can see.
  useScrollRestoration(
    `${nav.tab}:${nav.depth}`,
    screenRef,
    nav.tab !== "agent" && nav.top?.view !== "assistant-chat",
  );
  const edgeSwipe = useRef<{
    x: number;
    y: number;
    active: boolean;
    width: number;
    lastX: number;
    lastT: number;
    vx: number;
  } | null>(null);
  const canPop = nav.depth > 0;
  const onShellTouchStart = useCallback(
    (event: React.TouchEvent) => {
      const touch = event.touches[0];
      // A surface that draws with the finger (a retouch zone, a split handle)
      // keeps the edge for itself.
      const drawing =
        event.target instanceof Element && event.target.closest("[data-no-edge-swipe]");
      if (!canPop || touch.clientX > 24 || drawing) {
        edgeSwipe.current = null;
        return;
      }
      edgeSwipe.current = {
        x: touch.clientX,
        y: touch.clientY,
        active: false,
        width: window.innerWidth,
        lastX: touch.clientX,
        lastT: event.timeStamp,
        vx: 0,
      };
    },
    [canPop],
  );
  const onShellTouchMove = useCallback((event: React.TouchEvent) => {
    const drag = edgeSwipe.current;
    if (!drag) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - drag.x;
    const deltaY = Math.abs(touch.clientY - drag.y);
    if (!drag.active) {
      // Steep gestures are scrolls: hand the touch back untouched.
      if (deltaY > 12 && deltaY > deltaX) {
        edgeSwipe.current = null;
        return;
      }
      if (deltaX < 10) return;
      drag.active = true;
      // Depth cues while the screen is held: an edge shadow on the dragged
      // screen and a dimmed strip underneath (see [data-swiping] in CSS).
      screenRef.current?.setAttribute("data-swiping", "true");
    }
    const deltaT = event.timeStamp - drag.lastT;
    if (deltaT > 0) drag.vx = (touch.clientX - drag.lastX) / deltaT;
    drag.lastX = touch.clientX;
    drag.lastT = event.timeStamp;
    const el = screenRef.current;
    if (el) {
      el.style.transition = "none";
      el.style.transform = `translateX(${Math.max(0, deltaX)}px)`;
    }
  }, []);
  const onShellTouchEnd = useCallback(() => {
    const drag = edgeSwipe.current;
    edgeSwipe.current = null;
    const el = screenRef.current;
    if (!drag?.active || !el) return;
    const deltaX = drag.lastX - drag.x;
    // Commit on distance, or on a modest flick that has actually travelled —
    // the old 0.5 px/ms gate demanded a violent throw.
    const commit = deltaX > drag.width * 0.35 || (drag.vx > 0.2 && deltaX > 24);
    if (commit) {
      // Momentum handoff: the screen leaves at the finger's speed instead of
      // decelerating identically after a throw and a slow release; the pop
      // fires when the slide lands, not on a fixed timer.
      const remaining = Math.max(1, drag.width - Math.max(0, deltaX));
      const duration = Math.min(280, Math.max(120, remaining / Math.max(drag.vx, 0.9)));
      el.style.transition = `transform ${Math.round(duration)}ms var(--ease-out)`;
      el.style.transform = `translateX(${drag.width}px)`;
      window.setTimeout(() => nav.pop(), Math.round(duration) - 20);
    } else {
      el.style.transition = "transform 200ms var(--ease-out)";
      el.style.transform = "translateX(0)";
      window.setTimeout(() => {
        if (screenRef.current === el) {
          el.style.transition = "";
          el.style.transform = "";
          el.removeAttribute("data-swiping");
        }
      }, 220);
    }
  }, [nav]);

  // --- Carpe Diem gate (mirrors App.tsx): nothing works without a key. ---
  const [carpeDiem, setCarpeDiem] = useState<CarpeDiemSidecarStatusDto | null>(null);
  useEffect(() => {
    let active = true;
    void carpeDiemSidecarStatus()
      .then((status) => {
        if (active) setCarpeDiem(status);
      })
      .catch(() => {
        if (active) setCarpeDiem({ status: "unconfigured", hasApiKey: false });
      });
    const unlisten = listen<CarpeDiemSidecarStatusDto>(SIDECAR_STATUS_EVENT, (event) =>
      setCarpeDiem(event.payload),
    );
    return () => {
      active = false;
      void unlisten.then((fn) => fn());
    };
  }, []);
  const carpeDiemLoading = carpeDiem === null;
  const carpeDiemRequired =
    !carpeDiemLoading && (!carpeDiem.hasApiKey || carpeDiem.status === "failed");

  // --- Bootstrap once the gate clears. ---
  const bootstrap = useMobileBootstrap(carpeDiemLoading || carpeDiemRequired, dispatch);
  useEffect(() => {
    if (carpeDiemLoading || carpeDiemRequired) return;
    checkRecordingSourceReadiness("microphoneOnly")
      .then(setSourceReadiness)
      .catch(() => undefined);
  }, [carpeDiemLoading, carpeDiemRequired]);

  // At most one recovery per note in practice; the first wins if the backend
  // ever surfaces two, exactly as the desktop resolves it.
  const selectedRecovery = useMemo(
    () =>
      state.selectedNote
        ? state.activeRecoveries.find((entry) => entry.noteId === state.selectedNote?.id)
        : undefined,
    [state.activeRecoveries, state.selectedNote],
  );

  const recordingStatusRef = useRef(state.recordingStatus);
  recordingStatusRef.current = state.recordingStatus;
  const recordingNoteId = state.recordingStatus?.noteId;
  const recordingNoteIdRef = useRef(recordingNoteId);
  recordingNoteIdRef.current = recordingNoteId;

  // --- Recording status polling (waveform + elapsed), as on desktop. ---
  useEffect(() => {
    if (!state.recordingStatus || !["recording", "paused"].includes(state.recordingStatus.state)) {
      return;
    }
    const sessionId = state.recordingStatus.sessionId;
    let cancelled = false;
    let inFlight = false;
    const interval = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      getRecordingStatus(sessionId)
        .then((status) => {
          if (!cancelled) dispatch({ type: "recordingStatusChanged", status });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (errorCode(err) === "recording_not_found") {
            dispatch({ type: "recordingSessionLost", sessionId });
            return;
          }
          setError(messageFromError(err));
        })
        .finally(() => {
          inFlight = false;
        });
    }, 100);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [state.recordingStatus?.sessionId, state.recordingStatus?.state]);

  // --- Live transcript stream for the active recording. ---
  useEffect(() => {
    if (!state.recordingStatus) setLiveTranscriptEvents([]);
  }, [state.recordingStatus?.sessionId]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let aborted = false;
    void listen<LiveTranscriptEventDto>(LIVE_TRANSCRIPT_EVENT, (event) => {
      const payload = event.payload;
      const activeRecording = recordingStatusRef.current;
      if (!activeRecording || payload.sessionId !== activeRecording.sessionId) return;
      if (recordingNoteIdRef.current && payload.noteId !== recordingNoteIdRef.current) return;
      const text = payload.text.trim();
      if (!text) return;
      setLiveTranscriptEvents((current) =>
        upsertLiveTranscriptEvent(current, { ...payload, text }),
      );
    }).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, []);

  // --- Poll the open note while its pipeline runs (transcribing/generating). ---
  const selectedNote = state.selectedNote;
  useEffect(() => {
    if (!selectedNote || !shouldPollProcessingStatus(selectedNote.processingStatus)) return;
    if (import.meta.env.DEV && selectedNote.id === PROCESSING_DEMO_NOTE_ID) return;
    const noteId = selectedNote.id;
    let cancelled = false;
    const interval = window.setInterval(() => {
      getNote(noteId)
        .then((note) => {
          if (!cancelled) dispatch({ type: "noteUpdated", note });
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(messageFromError(err));
        });
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedNote?.id, selectedNote?.processingStatus]);

  // --- Handlers ---
  const openNote = useCallback(
    (noteId: string) => {
      nav.push({ view: "note", noteId });
      getNote(noteId)
        .then((note) => dispatch({ type: "noteLoaded", note }))
        .catch((err: unknown) => setError(messageFromError(err)));
    },
    [nav],
  );

  // Two meetings overlapped a recording: ask, once, rather than guess.
  const [calendarAmbiguity, setCalendarAmbiguity] = useState<{
    noteId: string;
    events: CalendarEventDto[];
  } | null>(null);

  // Destinations (subrosa://…): a deep link, a Shortcuts action, or the tap
  // on a notification that carried one. They wait until the shell is ready
  // (see useDestinationQueue), and each lands on the tab it belongs to.

  /** Record from outside the app (a link, a Shortcuts action). Lands on
   * Notes, where the note will be; shows the recording already running rather
   * than starting a second one. */
  const recordFromOutside = () => {
    nav.switchTab("notes");
    const running = recordingNoteIdRef.current;
    if (running) {
      openNote(running);
      return;
    }
    void handleCreateNote({ record: true });
  };
  const openDictation = (autoStart: boolean) => {
    nav.switchTab("notes");
    nav.push({ view: "dictation", autoStart });
  };
  /** A fresh chat, with text waiting in it. Sent without a tap only when the
   * request came from the app's own Shortcuts action (`send`). */
  const askInChat = (text: string | undefined, send: boolean) => {
    nav.switchTab("agent");
    openChatSession(undefined);
    if (text) setPendingChat({ text, send });
  };

  // Whether a fresh chat is on screen now, for a share that lands while an
  // earlier one is still being read: the second joins the first.
  const freshChatShown = useRef(false);
  freshChatShown.current = nav.tab === "agent" && agentSessionId === undefined;
  const attachInChat = (attachment: AgentLiteAttachment) => {
    if (!freshChatShown.current) {
      nav.switchTab("agent");
      openChatSession(undefined);
    }
    setPendingAttachments((current) => [...current, attachment]);
  };

  const handleDestination = (destination: Destination) => {
    switch (destination.kind) {
      case "note":
        nav.switchTab("notes");
        openNote(destination.noteId);
        break;
      case "chat":
        nav.switchTab("agent");
        openChatSession(destination.sessionId);
        // A link's question is written into the composer, never sent: any
        // page can open an address.
        if (destination.query) setPendingChat({ text: destination.query, send: false });
        break;
      case "assistant":
        // The conversation lands on top of the tab's own stack, so back
        // returns to the library rather than out of the tab.
        if (nav.tab !== "assistants") nav.switchTab("assistants");
        // Already on screen: re-pushing it would make Back land on itself.
        if (
          !(
            nav.tab === "assistants" &&
            nav.top?.view === "assistant-chat" &&
            nav.top.taskId === destination.taskId
          )
        )
          nav.push({ view: "assistant-chat", taskId: destination.taskId });
        break;
      case "assistants":
        nav.switchTab("assistants");
        break;
      case "dictation":
        openDictation(Boolean(destination.start));
        break;
      case "studio":
        if (nav.tab !== "studio") nav.switchTab("studio");
        if (destination.retouch)
          nav.push({
            view: "studio-retouch",
            artifactId: destination.retouch.versionId,
            rootId: destination.retouch.rootId,
          });
        break;
      case "record":
        recordFromOutside();
        break;
      // A daily brief or an assignment's result: Today, over the chat tab.
      case "today":
        if (nav.tab !== "agent") nav.switchTab("agent");
        if (nav.top?.view !== "today") nav.push({ view: "today" });
        break;
      // Shared in from another app. The notes tab is where the download shows
      // itself, so land there rather than starting something invisible.
      case "import":
        nav.switchTab("notes");
        // A video page would only be refused: open the sheet on it instead,
        // where the link can be sent to a computer that reads it.
        void previewIngestLink(destination.url)
          .then((preview) => {
            if (preview.kind === "platformPage" && !preview.fetchable) {
              setImportLink(destination.url);
              return;
            }
            return startLinkIngest(destination.url);
          })
          .catch((err) => setError(messageFromError(err)));
        break;
      // A sign-in that finished in Safari. Rust has already spent the return
      // code; this only shows the person where they landed.
      case "account":
        nav.switchTab("settings");
        nav.push({ view: "settings-section", section: "account" });
        break;
      // Back from Carpe Diem's pay page: look at the balance again now.
      case "credits":
        notifyCreditsChanged();
        break;
      // Shared through the share sheet: the extension left a manifest in
      // the app group inbox; Rust reads it and makes the note or starts the
      // fetch, and the notes tab is where either shows itself.
      case "share":
        nav.switchTab("notes");
        void importSharedItem(destination.itemId)
          .then(async (made) => {
            if (made.kind === "platform" && made.url) setImportLink(made.url);
            else if (made.attachment) attachInChat(await composerAttachment(made.attachment));
            else if (made.noteId) openNote(made.noteId);
          })
          .catch((err) => setError(messageFromError(err)));
        break;
    }
  };
  const handleIntent = (request: IntentRequest) => {
    if (request.action === "record") recordFromOutside();
    else if (request.action === "dictate") openDictation(true);
    else askInChat(request.query, Boolean(request.send && request.query));
  };
  useDestinationQueue({
    ready: !carpeDiemLoading && !carpeDiemRequired && !bootstrap.loading && !bootstrap.error,
    onDestination: handleDestination,
    onIntent: handleIntent,
  });

  // Notes cited in a chat reply (the subrosa:notes block): the card
  // dispatches one window event, and the shell answers with its own opener —
  // the note detail pushes over whatever tab is active, chat included.
  useEffect(() => {
    function handleOpenNoteFromChat(event: Event) {
      const noteId = (event as CustomEvent<{ noteId?: string }>).detail?.noteId;
      if (noteId) openNote(noteId);
    }
    window.addEventListener(OPEN_NOTE_FROM_CHAT_EVENT, handleOpenNoteFromChat);
    return () => window.removeEventListener(OPEN_NOTE_FROM_CHAT_EVENT, handleOpenNoteFromChat);
  }, [openNote]);

  // A canvas (ADR-0087) is a screen of its own on the phone, pushed over the
  // tab it was opened from; "Ask Sub Rosa" brings the chat back to the front,
  // where its composer takes the quote.
  useEffect(() => {
    let seq = 0;
    function handleOpenCanvas(event: Event) {
      const detail = (event as CustomEvent<OpenCanvasDetail>).detail;
      if (!detail?.noteId) return;
      seq += 1;
      nav.push({ view: "canvas", noteId: detail.noteId, proposal: detail.proposal, seq });
    }
    window.addEventListener(OPEN_CANVAS_EVENT, handleOpenCanvas);
    return () => window.removeEventListener(OPEN_CANVAS_EVENT, handleOpenCanvas);
  }, [nav.push]);
  useEffect(() => {
    function handleAsk() {
      if (nav.top?.view === "canvas") nav.pop();
      if (nav.tab !== "agent") nav.switchTab("agent");
    }
    window.addEventListener(ASK_ABOUT_SELECTION_EVENT, handleAsk);
    return () => window.removeEventListener(ASK_ABOUT_SELECTION_EVENT, handleAsk);
  }, [nav]);

  const handleCreateNote = useCallback(
    async (options?: { folderId?: string; record?: boolean }) => {
      try {
        const note = await createNote(options?.folderId);
        dispatch({ type: "noteLoaded", note });
        nav.push({ view: "note", noteId: note.id });
        if (options?.record) {
          const recording = await startRecording(note.id, "microphoneOnly");
          dispatch({ type: "recordingStatusChanged", status: recordingToStatus(recording) });
          void linkMeeting(note.id);
        }
      } catch (err) {
        setError(messageFromError(err));
      }
    },
    [nav],
  );

  const linkMeetingRefresh = useCallback(async (noteId: string) => {
    await getNote(noteId)
      .then((note) => dispatch({ type: "noteLoaded", note }))
      .catch(() => {});
  }, []);

  /** The day says what a recording is. Silent on every failure: no calendar
   * access, no event, or no EventKit at all must never cost a recording. */
  const linkMeeting = useCallback(async (noteId: string) => {
    const match = await linkRecordingToMeeting(noteId);
    if (match.kind === "one") {
      // The note just gained a title and attendees; re-read it so the open
      // screen shows them.
      await getNote(noteId)
        .then((note) => dispatch({ type: "noteLoaded", note }))
        .catch(() => {});
    } else if (match.kind === "ambiguous") {
      setCalendarAmbiguity({ noteId, events: match.events });
    }
  }, []);

  const handleStartRecording = useCallback(
    async (noteId: string) => {
      try {
        const recording = await startRecording(noteId, "microphoneOnly");
        dispatch({ type: "recordingStatusChanged", status: recordingToStatus(recording) });
        hapticImpact("medium");
        void linkMeeting(noteId);
      } catch (err) {
        setError(messageFromError(err));
      }
    },
    [linkMeeting],
  );

  const handlePauseRecording = useCallback(async (sessionId: string) => {
    try {
      const status = await pauseRecording(sessionId);
      dispatch({ type: "recordingStatusChanged", status });
    } catch (err) {
      setError(messageFromError(err));
    }
  }, []);

  const handleResumeRecording = useCallback(async (sessionId: string) => {
    try {
      const status = await resumeRecording(sessionId);
      dispatch({ type: "recordingStatusChanged", status });
    } catch (err) {
      setError(messageFromError(err));
    }
  }, []);

  const finishInFlight = useRef(new Set<string>());
  const handleFinishRecording = useCallback(async (sessionId: string) => {
    if (finishInFlight.current.has(sessionId)) return;
    finishInFlight.current.add(sessionId);
    try {
      const result = await finishRecording(sessionId);
      dispatch({ type: "recordingStatusCleared" });
      dispatch({ type: "noteProcessingUpdated", note: result.note });
      hapticImpact("medium");
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      finishInFlight.current.delete(sessionId);
    }
  }, []);

  const handleUpdateNote = useCallback(
    async (input: { title?: string; editedContent?: string }) => {
      const noteId = state.selectedNote?.id;
      if (!noteId) return;
      try {
        const note = await updateNote({ noteId, ...input });
        dispatch({ type: "noteUpdated", note });
      } catch (err) {
        setError(messageFromError(err));
      }
    },
    [state.selectedNote?.id],
  );

  const handleDeleteNote = useCallback(
    async (noteId: string) => {
      try {
        await deleteNote(noteId);
        const payload = await bootstrapApp();
        dispatch({ type: "bootstrapLoaded", payload });
        if (nav.top?.view === "note" && nav.top.noteId === noteId) nav.pop();
      } catch (err) {
        setError(messageFromError(err));
      }
    },
    [nav],
  );

  // An interrupted recording -- the app was killed, the phone rebooted, the
  // battery went -- leaves audio on disk and a row that says so. Until now the
  // phone knew about it and offered nothing: the buttons were wired to
  // `() => undefined`, so the only surface that could recover it did nothing
  // when tapped. Everything else already existed: `recover_recording` is in
  // both command lists, and `bootstrap_app` returns the pending recoveries the
  // reducer is already storing.
  const handleRecovery = useCallback((sessionId: string, action: "validate" | "discard") => {
    void (async () => {
      try {
        const note = await recoverRecording(sessionId, action);
        dispatch({ type: "noteProcessingUpdated", note });
        dispatch({ type: "recoveryRemoved", sessionId });
      } catch (err) {
        setError(messageFromError(err));
      }
    })();
  }, []);

  const handleRetry = useCallback(async () => {
    const note = state.selectedNote;
    if (!note) return;
    try {
      const updated = await retryProcessing(note.id);
      dispatch({ type: "noteProcessingUpdated", note: updated });
    } catch (err) {
      dispatch({
        type: "noteProcessingUpdated",
        note: { ...note, processingStatus: "failed", lastError: messageFromError(err) },
      });
    }
  }, [state.selectedNote]);

  // The Archive "state" is an auto-managed folder, so it rides the existing
  // folder infrastructure (chips, filtering, sync with desktop's data model).
  const archiveFolder = state.folders.find((folder) => folder.name.toLowerCase() === "archive");
  const archiveFolderId = archiveFolder?.id;

  /** File a note in one folder, or in none, keeping it archived if it was.
   * This only added before: a second folder joined the first, and the chip
   * went on naming the older one. */
  const handleSetNoteFolder = useCallback(
    async (noteId: string, folderId: string | undefined) => {
      const note =
        state.notes.find((entry) => entry.id === noteId) ??
        (state.selectedNote?.id === noteId ? state.selectedNote : undefined);
      if (!note) return;
      try {
        await moveNoteToFolder(note, folderId, {
          keep: archiveFolderId ? [archiveFolderId] : [],
          onUpdated: (updated) => dispatch({ type: "noteUpdated", note: updated }),
        });
      } catch (err) {
        setError(messageFromError(err));
      }
    },
    [state.notes, state.selectedNote, archiveFolderId],
  );

  const handleMoveNotes = useCallback(
    async (noteIds: string[], folderId: string | undefined) => {
      for (const noteId of noteIds) await handleSetNoteFolder(noteId, folderId);
      hapticNotify("success");
    },
    [handleSetNoteFolder],
  );

  const handleRenameFolder = useCallback(async (folderId: string, name: string) => {
    try {
      const folder = await renameFolder(folderId, name);
      dispatch({ type: "folderRenamed", folder });
    } catch (err) {
      setError(messageFromError(err));
    }
  }, []);

  const handleRemoveNoteFromFolder = useCallback(async (noteId: string, folderId: string) => {
    try {
      const note = await removeNoteFromFolder(noteId, folderId);
      dispatch({ type: "noteUpdated", note });
    } catch (err) {
      setError(messageFromError(err));
    }
  }, []);

  const handleArchiveNote = useCallback(
    async (noteId: string) => {
      try {
        let folderId = archiveFolderId;
        if (!folderId) {
          const created = await createFolder("Archive");
          dispatch({ type: "folderCreated", folder: created });
          folderId = created.id;
        }
        const note = await assignNoteToFolder(noteId, folderId);
        dispatch({ type: "noteUpdated", note });
        hapticNotify("success");
      } catch (err) {
        setError(messageFromError(err));
      }
    },
    [archiveFolderId],
  );

  // The webview file input hands us bytes: iOS grants IT access to the picked
  // file, and the Rust process cannot open that security-scoped path. The file
  // is streamed across in slices rather than read whole, so importing an
  // hour-long recording does not take the tab down with it.
  const handleImportAudio = useCallback(
    async (file: File) => {
      try {
        const note = await importMediaFile(file);
        dispatch({ type: "noteLoaded", note });
        nav.push({ view: "note", noteId: note.id });
        hapticNotify("success");
      } catch (err) {
        setError(messageFromError(err));
      }
    },
    [nav],
  );

  // Pull-to-refresh on the notes list: re-run the bootstrap payload (notes +
  // folders + recoveries in one round trip).
  const handleRefreshNotes = useCallback(async () => {
    const payload = await bootstrapApp();
    dispatch({ type: "bootstrapLoaded", payload });
  }, []);

  // The chat assistant can now write notes. Without this, a note it just
  // created stays invisible until the user pulls to refresh, which reads as
  // the tool having failed.
  useEffect(() => {
    const unlisten = listen(NOTES_CHANGED_EVENT, () => {
      void handleRefreshNotes().catch(() => undefined);
    });
    return () => {
      void unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, [handleRefreshNotes]);

  const handleCreateFolder = useCallback(async (name: string) => {
    try {
      const folder = await createFolder(name);
      dispatch({ type: "folderCreated", folder });
      return folder;
    } catch (err) {
      setError(messageFromError(err));
      return undefined;
    }
  }, []);

  const handleDeleteFolder = useCallback(
    async (folderId: string, deleteNotes: boolean) => {
      try {
        await deleteFolder(folderId, deleteNotes);
        dispatch({ type: "folderDeleted", folderId });
        // Deleted notes are gone on the backend; the list is re-read rather
        // than patched note by note.
        if (deleteNotes) await handleRefreshNotes();
        hapticNotify("success");
      } catch (err) {
        setError(messageFromError(err));
      }
    },
    [handleRefreshNotes],
  );

  const microphoneBlocked = useMemo(() => {
    const mic = sourceReadiness?.sources.find((source) => source.source === "microphone");
    return mic ? mic.permissionState === "denied" || mic.permissionState === "restricted" : false;
  }, [sourceReadiness]);

  // --- Gates ---
  if (carpeDiemLoading) {
    return <ShellLoading />;
  }
  if (carpeDiemRequired) {
    return (
      <div className="mobile-shell">
        <div className="mobile-gate-scroll">
          <CarpeDiemGate reason={carpeDiem?.status === "failed" ? "failed" : "no-key"} />
        </div>
      </div>
    );
  }

  if (bootstrap.loading) {
    return (
      <div className="mobile-shell view-recovery view-recovery-full">
        <Spinner aria-label={t("Loading notes")} />
      </div>
    );
  }
  if (bootstrap.error) {
    return (
      <div className="mobile-shell view-recovery view-recovery-full">
        <div className="view-recovery-content">
          <div role="alert">
            <h1>{t("Your notes could not be opened")}</h1>
            <p>{bootstrap.error}</p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={bootstrap.retry}>
            {t("Try again")}
          </button>
        </div>
      </div>
    );
  }

  // --- Screen selection ---
  const top = nav.top;
  let screen: React.ReactNode;
  if (top?.view === "note") {
    const note = state.selectedNote?.id === top.noteId ? state.selectedNote : undefined;
    screen = (
      <NoteDetailScreen
        note={note}
        folders={state.folders}
        recordingStatus={top.noteId === recordingNoteId ? state.recordingStatus : undefined}
        recordingDisabled={Boolean(state.recordingStatus && top.noteId !== recordingNoteId)}
        liveTranscript={top.noteId === recordingNoteId ? liveTranscriptEvents : []}
        sourceReadiness={sourceReadiness}
        microphoneBlocked={microphoneBlocked}
        onBack={nav.pop}
        onTitleChange={(title) => void handleUpdateNote({ title })}
        onContentChange={(noteId, editedContent) => {
          if (noteId !== top.noteId) return;
          void handleUpdateNote({ editedContent });
        }}
        onStartRecording={() => void handleStartRecording(top.noteId)}
        onPauseRecording={(sessionId) => void handlePauseRecording(sessionId)}
        onResumeRecording={(sessionId) => void handleResumeRecording(sessionId)}
        onFinishRecording={(sessionId) => void handleFinishRecording(sessionId)}
        onRetry={handleRetry}
        onDelete={() => void handleDeleteNote(top.noteId)}
        recovery={selectedRecovery}
        onRecoverRecording={(sessionId) => handleRecovery(sessionId, "validate")}
        onDiscardRecording={(sessionId) => handleRecovery(sessionId, "discard")}
        onAssignFolder={(folderId) => void handleSetNoteFolder(top.noteId, folderId)}
        onRemoveFolder={(folderId) => void handleRemoveNoteFromFolder(top.noteId, folderId)}
        onCreateAndAssignFolder={(name) => {
          void (async () => {
            const folder = await handleCreateFolder(name);
            if (folder) await handleSetNoteFolder(top.noteId, folder.id);
          })();
        }}
        onMoveToFolder={(folderId) => void handleSetNoteFolder(top.noteId, folderId)}
        archiveFolderId={archiveFolderId}
        onTabChange={(activeTab) =>
          void updateNote({ noteId: top.noteId, activeTab }).then((note) =>
            dispatch({ type: "noteUpdated", note }),
          )
        }
      />
    );
  } else if (top?.view === "agent-session") {
    screen = (
      <AgentSessionScreen
        sessionId={top.sessionId}
        projectFolderId={top.projectFolderId}
        onBack={nav.pop}
        onOpenSession={(sessionId) => {
          // Forking swaps the tab's root conversation onto the fork and pops
          // this pushed thread, so the user lands on the new model's chat.
          openChatSession(sessionId);
          nav.pop();
        }}
      />
    );
  } else if (top?.view === "agent-history") {
    screen = (
      <AgentScreen
        onBack={nav.pop}
        onOpenSession={(sessionId) => {
          // Picking a chat (or "new chat") swaps the tab's root conversation
          // and settles back onto it.
          openChatSession(sessionId);
          nav.pop();
        }}
        onOpenLibrary={() => nav.push({ view: "library" })}
        onOpenToday={() => nav.push({ view: "today" })}
        archiveFolderId={archiveFolderId}
        ensureArchiveFolder={async () => {
          if (archiveFolderId) return archiveFolderId;
          const created = await handleCreateFolder("Archive");
          return created?.id;
        }}
      />
    );
  } else if (top?.view === "assistant-chat") {
    screen = (
      <AssistantChatScreen
        assistantId={top.assistantId}
        taskId={top.taskId}
        onBack={nav.pop}
        onEdit={(assistantId) => nav.push({ view: "assistant-editor", assistantId })}
        onConversationChange={(taskId, assistantId) =>
          nav.replaceTop({
            view: "assistant-chat",
            assistantId: assistantId ?? top.assistantId,
            taskId: taskId ?? undefined,
          })
        }
      />
    );
  } else if (top?.view === "assistant-editor") {
    screen = (
      <AssistantEditor
        assistantId={top.assistantId}
        onBack={nav.pop}
        onSaved={(assistant) =>
          nav.replaceTop({ view: "assistant-editor", assistantId: assistant.id })
        }
        onTry={(assistantId) => nav.push({ view: "assistant-chat", assistantId })}
        onOpenReferences={(assistantId, assistantName) =>
          nav.push({ view: "assistant-references", assistantId, assistantName })
        }
        onDeleted={() => nav.switchTab("assistants")}
      />
    );
  } else if (top?.view === "assistant-create") {
    screen = (
      <AssistantCreator
        initialIdea={top.idea}
        onBack={nav.pop}
        onDrafted={() => nav.replaceTop({ view: "assistant-editor" })}
        onWriteMyself={() => nav.replaceTop({ view: "assistant-editor" })}
      />
    );
  } else if (top?.view === "assistant-references") {
    screen = (
      <AssistantReferencesScreen
        assistantId={top.assistantId}
        assistantName={top.assistantName}
        onBack={nav.pop}
      />
    );
  } else if (top?.view === "assistant-history") {
    screen = (
      <AssistantHistory
        onBack={nav.pop}
        onOpenConversation={(taskId) => nav.push({ view: "assistant-chat", taskId })}
      />
    );
  } else if (top?.view === "canvas") {
    screen = (
      <div className="mobile-screen-root">
        <CanvasPane
          key={top.noteId}
          noteId={top.noteId}
          proposal={top.proposal}
          proposalSeq={top.seq}
          layout="screen"
          onClose={nav.pop}
        />
      </div>
    );
  } else if (top?.view === "today") {
    screen = (
      <TodayScreen
        onBack={nav.pop}
        onOpenChat={(taskId) => {
          openChatSession(taskId);
          nav.switchTab("agent");
        }}
      />
    );
  } else if (top?.view === "library") {
    screen = (
      <div className="mobile-screen-root">
        <StackHeader title={t("Library")} large onBack={nav.pop} />
        <div className="mobile-list-scroll">
          <LibraryView />
        </div>
      </div>
    );
  } else if (top?.view === "studio-retouch") {
    screen = <RetouchScreen artifactId={top.artifactId} rootId={top.rootId} onBack={nav.pop} />;
  } else if (top?.view === "studio-compose") {
    screen = <ComposeScreen artifactId={top.artifactId} onBack={nav.pop} />;
  } else if (top?.view === "dictation") {
    screen = <DictationScreen onBack={nav.pop} autoStart={top.autoStart} />;
  } else if (top?.view === "settings-section") {
    screen =
      top.section === "account" ? (
        <AccountScreen onBack={nav.pop} />
      ) : top.section === "memory" ? (
        <MemoryScreen onBack={nav.pop} />
      ) : top.section === "connectors" ? (
        <ConnectorsScreen onBack={nav.pop} />
      ) : top.section === "skills" ? (
        <SkillsScreen onBack={nav.pop} />
      ) : top.section === "personalization" ? (
        <PersonalizationScreen onBack={nav.pop} />
      ) : top.section === "usage" ? (
        <UsageScreen onBack={nav.pop} />
      ) : top.section === "privacy" ? (
        <PrivacyScreen onBack={nav.pop} />
      ) : top.section === "archive" ? (
        <ArchiveScreen onBack={nav.pop} />
      ) : top.section === "models" ? (
        <ModelsScreen onBack={nav.pop} />
      ) : top.section === "reports" ? (
        <ReportsScreen onBack={nav.pop} />
      ) : top.section === "health" || top.section === "finances" ? (
        <PersonalDataScreen kind={top.section} onBack={nav.pop} />
      ) : top.section === "about" ? (
        <AboutScreen onBack={nav.pop} />
      ) : (
        <ConnectionScreen onBack={nav.pop} />
      );
  } else if (top?.view === "folder") {
    const folder = state.folders.find((item) => item.id === top.folderId);
    screen = (
      <FolderScreen
        folder={folder}
        notes={state.notes.filter((note) => note.folderIds.includes(top.folderId))}
        activeRecordingNoteId={recordingNoteId}
        isArchiveFolder={top.folderId === archiveFolderId}
        onBack={nav.pop}
        onSelectNote={openNote}
        onCreateNote={() => void handleCreateNote({ folderId: top.folderId })}
        onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
        onRemoveFromFolder={(noteId) => void handleRemoveNoteFromFolder(noteId, top.folderId)}
        candidates={state.notes.filter(
          (note) =>
            !note.folderIds.includes(top.folderId) &&
            !(archiveFolderId && note.folderIds.includes(archiveFolderId)),
        )}
        onAddNotes={(noteIds) => void handleMoveNotes(noteIds, top.folderId)}
        onRename={(name) => void handleRenameFolder(top.folderId, name)}
        onDeleteFolder={(deleteNotes) => {
          nav.pop();
          void handleDeleteFolder(top.folderId, deleteNotes);
        }}
        onNewChat={() => nav.push({ view: "agent-session", projectFolderId: top.folderId })}
        onOpenSettings={() => nav.push({ view: "project-settings", folderId: top.folderId })}
        onOpenChat={(sessionId) => nav.push({ view: "agent-session", sessionId })}
      />
    );
  } else if (top?.view === "project-settings") {
    screen = (
      <ProjectSettingsScreen
        folder={state.folders.find((item) => item.id === top.folderId)}
        onBack={nav.pop}
      />
    );
  } else {
    switch (nav.tab) {
      case "notes":
        screen = (
          <NotesScreen
            notes={state.notes}
            folders={state.folders}
            activeRecordingNoteId={recordingNoteId}
            archiveFolderId={archiveFolderId}
            onSelectNote={openNote}
            onRecord={() => void handleCreateNote({ record: true })}
            onCreateNote={() => void handleCreateNote()}
            onImportAudio={(file) => void handleImportAudio(file)}
            onScanDocument={
              supportsDocumentScan()
                ? () =>
                    void scanDocument()
                      .then((scan) => scan && openNote(scan.noteId))
                      .catch((err: unknown) => setError(messageFromError(err)))
                : undefined
            }
            onOpenFolder={(folderId) => nav.push({ view: "folder", folderId })}
            onOpenDictation={() => nav.push({ view: "dictation" })}
            onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
            onArchiveNote={(noteId) => void handleArchiveNote(noteId)}
            onMoveNotes={(noteIds, folderId) => void handleMoveNotes(noteIds, folderId)}
            importLink={importLink}
            onImportLinkTaken={() => setImportLink(null)}
            onOpenAccount={() => {
              nav.switchTab("settings");
              nav.push({ view: "settings-section", section: "account" });
            }}
            onCreateFolder={handleCreateFolder}
            onRefresh={handleRefreshNotes}
          />
        );
        break;
      case "assistants":
        screen = (
          <AssistantsHome
            onOpenChat={(assistantId) => nav.push({ view: "assistant-chat", assistantId })}
            onOpenConversation={(taskId) => nav.push({ view: "assistant-chat", taskId })}
            onCreate={(idea) => nav.push({ view: "assistant-create", idea })}
            onEdit={(assistantId) => nav.push({ view: "assistant-editor", assistantId })}
            onOpenHistory={() => nav.push({ view: "assistant-history" })}
          />
        );
        break;
      case "agent":
        // The tab lands straight in a conversation (fresh, or the one already
        // underway); the history list is one tap away in the chat header.
        screen = (
          <AgentSessionScreen
            key={`chat-${agentChatEpoch}`}
            sessionId={agentSessionId}
            onSessionCreated={setAgentSessionId}
            onOpenSession={openChatSession}
            onOpenHistory={() => nav.push({ view: "agent-history" })}
            onNewChat={() => openChatSession(undefined)}
            onGenerateImage={(prompt) => {
              handOffImagePrompt(prompt);
              nav.switchTab("studio");
            }}
            initialDraft={pendingChat?.text}
            autoSend={pendingChat?.send}
            onInitialDraftUsed={() => setPendingChat(null)}
            initialAttachments={pendingAttachments.length ? pendingAttachments : undefined}
            onInitialAttachmentsUsed={takeAttachments}
          />
        );
        break;
      case "studio":
        screen = <StudioScreen />;
        break;
      case "settings":
        screen = (
          <SettingsScreen onOpen={(section) => nav.push({ view: "settings-section", section })} />
        );
        break;
    }
  }

  // The keyboard covers the tab bar anyway; hiding it while typing keeps
  // keyboard-inset math simple (the inset is measured from the window bottom,
  // which is only the screen's bottom edge when the tab bar is gone).
  const showTabBar =
    (!top || top.view === "folder" || top.view === "settings-section") && keyboardInset === 0;

  return (
    <div className="mobile-shell">
      <MobileErrorBanner error={error} onDismiss={() => setError(null)} />
      <RailSwitchBanner compact />
      <ReflexNotice compact />
      <AddCreditsHost />
      {calendarAmbiguity ? (
        <MeetingAmbiguityPrompt
          noteId={calendarAmbiguity.noteId}
          events={calendarAmbiguity.events}
          onResolved={(event) => {
            setCalendarAmbiguity(null);
            if (event) void linkMeetingRefresh(calendarAmbiguity.noteId);
          }}
        />
      ) : null}
      <div
        className="mobile-screen"
        data-nav={navMotion}
        key={`${nav.tab}:${nav.depth}`}
        ref={screenRef}
        onTouchStart={onShellTouchStart}
        onTouchMove={onShellTouchMove}
        onTouchEnd={onShellTouchEnd}
        onTouchCancel={onShellTouchEnd}
      >
        {screen}
      </div>
      {showTabBar ? (
        <TabBar
          active={nav.tab}
          onSelect={nav.switchTab}
          busy={{ agent: chatBusy, studio: studioBusy }}
        />
      ) : null}
    </div>
  );
}

/**
 * The long wait, which is the sidecar starting rather than the bundle loading.
 *
 * It used to be a bare ring: correct, and indistinguishable from any other
 * app's spinner. It now carries the mark, and past the point where the shell
 * gives up on the sidecar it says so instead of spinning forever -- the timeout
 * is eight seconds (SIDECAR_STATUS_TIMEOUT_MS in App.tsx), which is long enough
 * that an unnamed spinner reads as a hang well before it fires.
 *
 * No progress bar and no estimate: nothing here knows how long a cold start
 * takes on this device, and a bar that fills at an invented rate is a lie the
 * user catches the second time.
 */
function ShellLoading() {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SHELL_LOADING_SLOW_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="mobile-shell mobile-shell-loading" aria-busy="true">
      <span className="mobile-shell-loading-mark" aria-hidden>
        <BrandGradientMark />
      </span>
      <p className="mobile-shell-loading-line" aria-live="polite">
        {slow ? t("Still starting the local engine.") : t("Starting up")}
      </p>
    </div>
  );
}
