import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { CarpeDiemGate } from "../../components/carpe-diem/CarpeDiemGate";
import { SIDECAR_STATUS_EVENT } from "../../components/settings/CarpeDiemSettings";
import { TabBar } from "../../components/mobile/TabBar";
import { AgentScreen, AgentSessionScreen } from "../../components/mobile/screens/AgentScreen";
import { DictationScreen } from "../../components/mobile/screens/DictationScreen";
import { FolderScreen } from "../../components/mobile/screens/FoldersScreen";
import { NoteDetailScreen } from "../../components/mobile/screens/NoteDetailScreen";
import { NotesScreen } from "../../components/mobile/screens/NotesScreen";
import { SettingsScreen } from "../../components/mobile/screens/SettingsScreen";
import { StudioScreen } from "../../components/mobile/screens/StudioScreen";
import { errorCode, messageFromError } from "../../lib/errors";
import { hapticImpact, hapticNotify } from "../../lib/haptics";
import { upsertLiveTranscriptEvent } from "../../lib/live-transcript-preview";
import { recordingToStatus } from "../../lib/recording-status";
import {
  LIVE_TRANSCRIPT_EVENT,
  type CarpeDiemSidecarStatusDto,
  type LiveTranscriptEventDto,
  type RecordingSourceReadinessDto,
  assignNoteToFolder,
  bootstrapApp,
  carpeDiemSidecarStatus,
  checkRecordingSourceReadiness,
  createFolder,
  createNote,
  deleteNote,
  finishRecording,
  getNote,
  getRecordingStatus,
  importAudioNote,
  pauseRecording,
  removeNoteFromFolder,
  resumeRecording,
  retryProcessing,
  startRecording,
  updateNote,
} from "../../lib/tauri";
import { PROCESSING_DEMO_NOTE_ID, shouldPollProcessingStatus } from "../processing-polling";
import { createInitialState, notesReducer } from "../state/app-state";
import { useMobileNav } from "./nav";

/**
 * The iPhone/Android shell: bottom tab bar plus per-tab push stacks, reusing
 * the desktop state reducer, IPC layer, and feature components (NoteEditor,
 * CarpeDiemSettings) without the desktop chrome (sidebar, tab strip, HUDs).
 * Desktop keeps `App`; `src/main.tsx` picks the shell per platform.
 */
export function MobileApp() {
  const [state, dispatch] = useReducer(notesReducer, undefined, createInitialState);
  const [error, setError] = useState<string | null>(null);
  const [liveTranscriptEvents, setLiveTranscriptEvents] = useState<LiveTranscriptEventDto[]>([]);
  const [sourceReadiness, setSourceReadiness] = useState<RecordingSourceReadinessDto | undefined>();
  const nav = useMobileNav();

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
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (carpeDiemLoading || carpeDiemRequired || bootstrapped.current) return;
    bootstrapped.current = true;
    bootstrapApp()
      .then((payload) => dispatch({ type: "bootstrapLoaded", payload }))
      .catch((err: unknown) => setError(messageFromError(err)));
    checkRecordingSourceReadiness("microphoneOnly")
      .then(setSourceReadiness)
      .catch(() => undefined);
  }, [carpeDiemLoading, carpeDiemRequired]);

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

  const handleCreateNote = useCallback(
    async (options?: { folderId?: string; record?: boolean }) => {
      try {
        const note = await createNote(options?.folderId);
        dispatch({ type: "noteLoaded", note });
        nav.push({ view: "note", noteId: note.id });
        if (options?.record) {
          const recording = await startRecording(note.id, "microphoneOnly");
          dispatch({ type: "recordingStatusChanged", status: recordingToStatus(recording) });
        }
      } catch (err) {
        setError(messageFromError(err));
      }
    },
    [nav],
  );

  const handleStartRecording = useCallback(async (noteId: string) => {
    try {
      const recording = await startRecording(noteId, "microphoneOnly");
      dispatch({ type: "recordingStatusChanged", status: recordingToStatus(recording) });
      hapticImpact("medium");
    } catch (err) {
      setError(messageFromError(err));
    }
  }, []);

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

  const handleSetNoteFolder = useCallback(async (noteId: string, folderId: string) => {
    try {
      const note = await assignNoteToFolder(noteId, folderId);
      dispatch({ type: "noteUpdated", note });
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

  // The Archive "state" is an auto-managed folder, so it rides the existing
  // folder infrastructure (chips, filtering, sync with desktop's data model).
  const archiveFolder = state.folders.find((folder) => folder.name.toLowerCase() === "archive");
  const handleArchiveNote = useCallback(
    async (noteId: string) => {
      try {
        let folderId = archiveFolder?.id;
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
    [archiveFolder?.id],
  );

  // The webview file input hands us bytes (iOS grants IT access to the
  // picked file; the Rust process cannot open that security-scoped path).
  const handleImportAudio = useCallback(
    async (file: File) => {
      try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const chunk = 0x8000;
        for (let index = 0; index < bytes.length; index += chunk) {
          binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
        }
        const note = await importAudioNote({ base64: btoa(binary), fileName: file.name });
        dispatch({ type: "noteLoaded", note });
        nav.push({ view: "note", noteId: note.id });
        hapticNotify("success");
      } catch (err) {
        setError(messageFromError(err));
      }
    },
    [nav],
  );

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

  const microphoneBlocked = useMemo(() => {
    const mic = sourceReadiness?.sources.find((source) => source.source === "microphone");
    return mic ? mic.permissionState === "denied" || mic.permissionState === "restricted" : false;
  }, [sourceReadiness]);

  // --- Gates ---
  if (carpeDiemLoading) {
    return <div className="mobile-shell mobile-shell-loading" aria-busy="true" />;
  }
  if (carpeDiemRequired) {
    return (
      <div className="mobile-shell">
        <div className="mobile-gate-scroll">
          <CarpeDiemGate />
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
        onAssignFolder={(folderId) => void handleSetNoteFolder(top.noteId, folderId)}
        onRemoveFolder={(folderId) => void handleRemoveNoteFromFolder(top.noteId, folderId)}
        onCreateAndAssignFolder={(name) => {
          void (async () => {
            const folder = await handleCreateFolder(name);
            if (folder) await handleSetNoteFolder(top.noteId, folder.id);
          })();
        }}
        onTabChange={(activeTab) =>
          void updateNote({ noteId: top.noteId, activeTab }).then((note) =>
            dispatch({ type: "noteUpdated", note }),
          )
        }
      />
    );
  } else if (top?.view === "agent-session") {
    screen = <AgentSessionScreen sessionId={top.sessionId} onBack={nav.pop} />;
  } else if (top?.view === "folder") {
    const folder = state.folders.find((item) => item.id === top.folderId);
    screen = (
      <FolderScreen
        folder={folder}
        notes={state.notes.filter((note) => note.folderIds.includes(top.folderId))}
        activeRecordingNoteId={recordingNoteId}
        isArchiveFolder={top.folderId === archiveFolder?.id}
        onBack={nav.pop}
        onSelectNote={openNote}
        onCreateNote={() => void handleCreateNote({ folderId: top.folderId })}
        onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
        onRemoveFromFolder={(noteId) => void handleRemoveNoteFromFolder(noteId, top.folderId)}
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
            archiveFolderId={archiveFolder?.id}
            onSelectNote={openNote}
            onRecord={() => void handleCreateNote({ record: true })}
            onCreateNote={() => void handleCreateNote()}
            onImportAudio={(file) => void handleImportAudio(file)}
            onOpenFolder={(folderId) => nav.push({ view: "folder", folderId })}
            onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
            onArchiveNote={(noteId) => void handleArchiveNote(noteId)}
          />
        );
        break;
      case "dictation":
        screen = <DictationScreen />;
        break;
      case "agent":
        screen = (
          <AgentScreen
            onOpenSession={(sessionId) => nav.push({ view: "agent-session", sessionId })}
            archiveFolderId={archiveFolder?.id}
            ensureArchiveFolder={async () => {
              if (archiveFolder?.id) return archiveFolder.id;
              const created = await handleCreateFolder("Archive");
              return created?.id;
            }}
          />
        );
        break;
      case "studio":
        screen = <StudioScreen />;
        break;
      case "settings":
        screen = <SettingsScreen />;
        break;
    }
  }

  const showTabBar = !top || top.view === "folder";

  return (
    <div className="mobile-shell">
      {error ? (
        <button
          type="button"
          className="mobile-error-banner"
          onClick={() => setError(null)}
          aria-label="Dismiss error"
        >
          {error}
        </button>
      ) : null}
      <div className="mobile-screen">{screen}</div>
      {showTabBar ? <TabBar active={nav.tab} onSelect={nav.switchTab} /> : null}
    </div>
  );
}
