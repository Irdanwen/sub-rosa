import { turnIdForTime } from "../../lib/chapters";
import { IconClapboard } from "central-icons/IconClapboard";
import { requestFilmFromNote } from "../../lib/film-from-note";
import { listFilms } from "../../lib/tauri";
import { NoteSummaryPanel } from "./NoteSummaryPanel";
import { IconClipboard } from "central-icons/IconClipboard";
import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { IconArrowDownWall } from "central-icons/IconArrowDownWall";
import { IconMarkdown } from "central-icons/IconMarkdown";
import { IconBookSimple } from "central-icons/IconBookSimple";
import { IconSparkle3 } from "central-icons/IconSparkle3";
import { IconProjects } from "central-icons/IconProjects";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMicrophoneOff } from "central-icons/IconMicrophoneOff";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconMicrophone as IconMicrophoneLine } from "central-icons/IconMicrophone";
import { IconVolumeFull } from "central-icons/IconVolumeFull";
import { IconCheckmark1 } from "central-icons-filled/IconCheckmark1";
import { IconChevronBottom } from "central-icons-filled/IconChevronBottom";
import { IconMicrophone } from "central-icons-filled/IconMicrophone";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { EASE_OUT } from "../../lib/motion";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Switch } from "../ui/Switch";
import type {
  FolderDto,
  LiveTranscriptEventDto,
  NoteDto,
  RecordingSourceMode,
  RecordingSourceReadinessDto,
  RecordingStatusDto,
  RecoverableRecordingDto,
  TranscriptDto,
} from "../../lib/tauri";
import { DotSpinner } from "../DotSpinner";
import { InlineNotice } from "../ui/InlineNotice";
import { SegmentedControl } from "../ui/SegmentedControl";
import { RecorderBar } from "../recorder/RecorderBar";
import { NoteRecoveryPrompt } from "../recorder/NoteRecoveryPrompt";
import { isMacLikePlatform } from "../../lib/platform";
import { systemAudioAvailability } from "../../lib/source-readiness";
import {
  isInvalidJuneResponseMessage,
  NoteFailureBanner,
  userFacingFailureMessage,
} from "./NoteFailureBanner";
import { NotePreview } from "./NotePreview";
import { MeetingBadge } from "../calendar/MeetingContext";
import { ListenButton } from "./ListenButton";

type NoteEditorProps = {
  note: NoteDto;
  folders: FolderDto[];
  recordingStatus?: RecordingStatusDto;
  recordingDisabled?: boolean;
  liveTranscript?: LiveTranscriptEventDto[];
  sourceMode: RecordingSourceMode;
  sourceReadiness?: RecordingSourceReadinessDto;
  recovery?: RecoverableRecordingDto;
  onTitleChange: (title: string) => void;
  onExportPdf?: () => void;
  /** Save the note as a Markdown file (desktop; the phone shares instead). */
  onExportMarkdown?: () => void;
  /** "Ask this note": a question answered from this note alone, cited. */
  onAskNote?: () => void;
  onContentChange: (noteId: string, content: string) => void;
  onSourceModeChange: (mode: RecordingSourceMode) => void;
  onEnableSystemAudio: () => void;
  onEnableMicrophone: () => void;
  microphoneBlocked: boolean;
  onStartRecording: () => void;
  onPauseRecording: (sessionId: string) => void;
  onResumeRecording: (sessionId: string) => void;
  onFinishRecording: (sessionId: string) => void;
  onRetry: () => void | Promise<void>;
  onTopUp: () => void;
  topUpLabel?: string;
  onRecoverRecording: (sessionId: string) => void;
  onDiscardRecording: (sessionId: string) => void;
  onAssignFolder: (folderId: string) => void;
  onRemoveFolder: (folderId: string) => void;
  onCreateAndAssignFolder: (name: string) => void;
  onNavigateToFolder?: (folderId: string) => void;
  onTabChange: (tab: NoteTab) => void;
};

export type NoteTab = "notes" | "transcription" | "summary";

const BASE_TABS = [
  { value: "notes", label: "Notes" },
  { value: "transcription", label: "Transcription" },
] as const;

/** The long-form reading (ADR-0027). Offered only once there is a transcript
 * to read: a tab that can never do anything is noise on every short note. */
const SUMMARY_TAB = { value: "summary", label: "Summary" } as const;

function sourceLabel(source?: string) {
  return source === "system" ? "System" : "Microphone";
}

/** Normalise a turn's source to one of the two filterable buckets — an
 * absent source is treated as microphone, matching sourceLabel. */
function sourceKey(source?: string): "microphone" | "system" {
  return source === "system" ? "system" : "microphone";
}

type SourceFilter = "all" | "microphone" | "system";

type RenderedTranscriptTurn = TranscriptDto & {
  preview?: boolean;
  stability?: LiveTranscriptEventDto["stability"];
};

type ProcessingStageStatus = Extract<
  NoteDto["processingStatus"],
  "validating" | "transcribing" | "generating"
>;

const SOURCE_FILTERS = [
  { value: "all", label: "All" },
  { value: "microphone", label: "Microphone" },
  { value: "system", label: "System" },
] as const;

const RECORD_CONSENT_REVEAL_DELAY_MS = 420;
const RECORD_CONSENT_AUTO_HIDE_MS = 5000;

function formatTurnTime(startMs?: number, endMs?: number) {
  if (startMs === undefined || endMs === undefined || endMs <= startMs) {
    return null;
  }
  const format = (value: number) => {
    const seconds = Math.max(0, Math.round(value / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  };
  return `${format(startMs)}-${format(endMs)}`;
}

/** Same prefix as every other stored preference in this app. */
const READING_MODE_KEY = "os-june:note-reading";

export function NoteEditor({
  note,
  folders,
  recordingStatus,
  recordingDisabled = false,
  liveTranscript = [],
  sourceMode,
  sourceReadiness,
  recovery,
  onTitleChange,
  onExportPdf,
  onExportMarkdown,
  onAskNote,
  onContentChange,
  onSourceModeChange,
  onEnableSystemAudio,
  onEnableMicrophone,
  microphoneBlocked,
  onStartRecording,
  onPauseRecording,
  onResumeRecording,
  onFinishRecording,
  onRetry,
  onTopUp,
  topUpLabel,
  onRecoverRecording,
  onDiscardRecording,
  onAssignFolder,
  onRemoveFolder,
  onCreateAndAssignFolder,
  onNavigateToFolder,
  onTabChange,
}: NoteEditorProps) {
  const content = note.editedContent ?? note.generatedContent ?? "";
  // Whether this note has been read as shots, and how many. Undefined means
  // it has not - the affordance is absent rather than disabled, because
  // "this is not a film" is not an error the user can act on.
  const [filmShotCount, setFilmShotCount] = useState<number | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    listFilms()
      .then((films) => {
        if (cancelled) return;
        const found = Array.isArray(films)
          ? films.find((film) => film.noteId === note.id)
          : undefined;
        setFilmShotCount(found ? found.shotCount : undefined);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [note.id]);
  const hasTranscript = Boolean(note.transcript?.text?.trim());
  const tabs = useMemo(
    () => (hasTranscript ? [...BASE_TABS, SUMMARY_TAB] : [...BASE_TABS]),
    [hasTranscript],
  );
  const storedTab = (note.activeTab ?? "notes") as NoteTab;
  // A note whose transcript was deleted must not be stuck on a tab that is no
  // longer offered.
  const activeTab: NoteTab = tabs.some((tab) => tab.value === storedTab) ? storedTab : "notes";
  const activeTabRef = useRef<NoteTab>(activeTab);
  activeTabRef.current = activeTab;
  const sourceTranscripts = orderedVisibleSourceTranscripts(note);
  const liveTranscriptTurns = useMemo(
    () => liveTranscript.map(liveTranscriptEventToTurn),
    [liveTranscript],
  );
  const transcriptTurns = useMemo(
    () =>
      [...sourceTranscripts, ...liveTranscriptTurns]
        .map((turn, index) => ({ turn, index }))
        .sort(compareSourceTranscriptOrder)
        .map(({ turn }) => turn),
    [sourceTranscripts, liveTranscriptTurns],
  );
  // A chapter is a way into the transcript (ADR-0026 keeps this module out of
  // the media-player business). Switching tabs unmounts the summary, so the
  // turn to scroll to is remembered and honoured once the transcript renders.
  const [pendingJumpTurnId, setPendingJumpTurnId] = useState<string | null>(null);
  const jumpToTime = useCallback(
    (startMs: number) => {
      const turnId = turnIdForTime(transcriptTurns, startMs);
      if (!turnId) return;
      setPendingJumpTurnId(turnId);
      onTabChange("transcription");
    },
    [onTabChange, transcriptTurns],
  );

  useEffect(() => {
    if (!pendingJumpTurnId || activeTabRef.current !== "transcription") return;
    const element = document.querySelector<HTMLElement>(
      `[data-turn-id="${CSS.escape(pendingJumpTurnId)}"]`,
    );
    setPendingJumpTurnId(null);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    // A brief highlight, so the eye lands on the right turn rather than on
    // whatever happens to be in the middle of the viewport.
    element.setAttribute("data-jumped", "true");
    const timer = window.setTimeout(() => element.removeAttribute("data-jumped"), 1600);
    return () => window.clearTimeout(timer);
  }, [pendingJumpTurnId]);

  const recordingForNote = recordingStatus;
  const recordingActive = Boolean(recordingForNote);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [consentReminderVisible, setConsentReminderVisible] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  // A preference, not a property of the note: someone who reads their notes
  // this way reads all of them this way. Stored under the app's own prefix,
  // and a failure to read it is simply "off" rather than a broken editor.
  const [reading, setReading] = useState(() => {
    try {
      return window.localStorage.getItem(READING_MODE_KEY) === "on";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(READING_MODE_KEY, reading ? "on" : "off");
    } catch {
      // A browser with storage blocked still gets the mode, just not the memory.
    }
  }, [reading]);
  // The source filter is ephemeral view state — reset it when navigating
  // to a different note so it never leaks across transcripts.
  useEffect(() => {
    setSourceFilter("all");
  }, [note.id]);

  // The filter only earns its place when both sources are present — a
  // mic-only voice memo has nothing to switch between. Built on the
  // already-pruned visible list so silent/error-only lanes don't count.
  const hasBothSources = useMemo(() => {
    let mic = false;
    let system = false;
    for (const turn of transcriptTurns) {
      if (sourceKey(turn.source) === "system") system = true;
      else mic = true;
      if (mic && system) return true;
    }
    return false;
  }, [transcriptTurns]);
  const visibleTurns = useMemo(() => {
    if (!hasBothSources || sourceFilter === "all") return transcriptTurns;
    return transcriptTurns.filter((turn) => sourceKey(turn.source) === sourceFilter);
  }, [transcriptTurns, hasBothSources, sourceFilter]);
  const systemOn = sourceMode === "microphonePlusSystem";
  const systemAvailability = systemAudioAvailability(sourceReadiness);
  const systemUnsupported = systemAvailability === "unsupported";
  // Denied and granted-but-uncapturable both mean the switch must not be
  // offered; only the recovery copy differs.
  const systemLocked = systemAvailability === "denied" || systemAvailability === "unavailable";
  const showRecordingOptions = isMacLikePlatform();
  // Mic denial is sourced from App via the dictation helper, not from
  // sourceReadiness — the Rust cpal-based check can't see TCC denials.
  const micDenied = microphoneBlocked;

  // Auto-close the options panel whenever a recording starts so the
  // shell can transition into the recorder bar cleanly.
  useEffect(() => {
    if (recordingForNote) setOptionsOpen(false);
  }, [recordingForNote]);
  const consentEdgeRef = useRef({ noteId: note.id, recording: false });
  useEffect(() => {
    const prev = consentEdgeRef.current;
    const shouldReveal =
      prev.noteId !== note.id ? recordingActive : recordingActive && !prev.recording;

    consentEdgeRef.current = { noteId: note.id, recording: recordingActive };
    // Undo the ref mutation on cleanup so StrictMode's double-invoke replays
    // the same edge — otherwise the second invoke sees its own write and the
    // reminder never appears in development.
    const restoreEdge = () => {
      consentEdgeRef.current = prev;
    };

    if (!recordingActive) {
      setConsentReminderVisible(false);
      return restoreEdge;
    }

    if (!shouldReveal) return restoreEdge;

    setConsentReminderVisible(false);
    const timer = window.setTimeout(
      () => setConsentReminderVisible(true),
      RECORD_CONSENT_REVEAL_DELAY_MS,
    );
    return () => {
      window.clearTimeout(timer);
      restoreEdge();
    };
  }, [note.id, recordingActive]);

  useEffect(() => {
    if (!consentReminderVisible) return;
    const timer = window.setTimeout(
      () => setConsentReminderVisible(false),
      RECORD_CONSENT_AUTO_HIDE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [consentReminderVisible]);
  const processingStatus = processingStageStatus(note.processingStatus);
  const processingLock = processingStatus !== null;
  const recordButtonDisabled = recordingDisabled;
  const recordOptionsDisabled = processingLock || recordingDisabled;
  // When generation finishes for the note you're looking at, reveal the fresh
  // notes with a top-down wipe instead of letting the text snap in. Only fires
  // on the live processing -> ready edge for this same note — never when
  // opening an already-finished one. `justFinished` is derived during render
  // against the last commit, so the clip lands on the very first ready frame
  // (no chance of painting the notes un-clipped before the wipe starts);
  // `notesRevealing` then holds the class for the rest of the animation.
  const [notesRevealing, setNotesRevealing] = useState(false);
  const revealEdgeRef = useRef({ noteId: note.id, processing: processingLock });
  const justFinished =
    revealEdgeRef.current.noteId === note.id &&
    revealEdgeRef.current.processing &&
    !processingLock &&
    note.processingStatus === "ready";
  useEffect(() => {
    revealEdgeRef.current = { noteId: note.id, processing: processingLock };
    if (justFinished) setNotesRevealing(true);
  }, [note.id, processingLock, note.processingStatus, justFinished]);
  // Hold the class just past the staggered block cascade, then drop it. (The
  // blocks finish at different times, so a timer is cleaner than chasing the
  // last animationend.)
  useEffect(() => {
    if (!notesRevealing) return;
    const timer = window.setTimeout(() => setNotesRevealing(false), 1200);
    return () => window.clearTimeout(timer);
  }, [notesRevealing]);
  const revealingNotes = justFinished || notesRevealing;
  // Shell snaps straight back to idle after stop — the body shimmer
  // covers the "still processing" affordance, and the record button
  // stays disabled via processingLock so nothing can re-trigger.
  const shellState = recordingForNote?.state ?? "idle";
  const processingText = processingMessage(note.processingStatus);
  const transcriptText = transcriptToText(note, liveTranscriptTurns);
  const transcriptCoverageNotice = transcriptCoverageNoticeText(note);
  const showTranscriptProcessing = processingStatus !== null;
  const showLivePreviewWaiting =
    recordingForNote?.livePreviewEnabled === true && liveTranscriptTurns.length === 0;
  // Processing runs in the background and is queued per note, so a recording
  // that's still transcribing/generating no longer blocks starting another —
  // you can stack messages and they process in order. The record button only
  // blocks when the microphone isn't ready; handleStartRecording re-checks on
  // click and silently falls back to mic-only if system audio is denied.
  const queuedRecordings = note.queuedRecordings ?? 0;
  const queuedTooltipId = useId();
  const updatedAtLabel = formatFullDate(note.updatedAt);

  return (
    <article className="note-editor">
      <header className="editor-header">
        <div className="note-overline">
          <span className="note-overline-date">{updatedAtLabel}</span>
          <span className="note-overline-dot" aria-hidden="true" />
          <FolderChip
            folders={folders}
            folderIds={note.folderIds}
            onAssign={onAssignFolder}
            onRemove={onRemoveFolder}
            onCreateAndAssign={onCreateAndAssignFolder}
            onNavigateToFolder={onNavigateToFolder}
          />
        </div>
        <input
          className="note-title"
          aria-label="Note title"
          placeholder="New note"
          value={note.title}
          onChange={(event) => onTitleChange(event.currentTarget.value)}
        />
        {/* When the day said what this is: scheduled time and who was
            invited. Absent on every note without an event, which is the
            behaviour the app has always had. */}
        <MeetingBadge scheduledStart={note.scheduledStart} attendees={note.attendees} />
        {/* The spoken recap: the note, read out loud, for the walk home. */}
        <ListenButton
          noteId={note.id}
          content={note.editedContent ?? note.generatedContent ?? ""}
        />
        <SegmentedControl
          aria-label="Note views"
          value={activeTab}
          options={tabs}
          onValueChange={(value) => onTabChange(value as NoteTab)}
        />
        {/* A note that has been read as shots is a film. The way back to it
            belongs here, on the note, rather than only in the Studio - a
            script is an ordinary note and this is where the user is looking
            at it. */}
        {filmShotCount !== undefined ? (
          <button
            type="button"
            className="note-header-actions"
            onClick={() => requestFilmFromNote(note.id)}
            aria-label="Open this note's film"
            title={`This note is a film: ${filmShotCount} shot${filmShotCount === 1 ? "" : "s"}`}
          >
            <IconClapboard aria-hidden="true" />
          </button>
        ) : null}
        {/* Reading, as opposed to writing. Same document, same file: this
            changes nothing the markdown holds (ADR-0037), only how wide the
            column is and what it is set in. The caret is put away while it is
            on, because a mode called reading that you can type into is two
            modes wearing one name. */}
        <button
          type="button"
          className="note-header-actions"
          data-active={reading || undefined}
          onClick={() => setReading((current) => !current)}
          aria-pressed={reading}
          aria-label={reading ? "Stop reading" : "Read"}
          title={reading ? "Back to writing" : "Read"}
        >
          <IconBookSimple aria-hidden="true" />
        </button>
        {onExportPdf ? (
          <button
            type="button"
            className="note-header-actions note-export-pdf"
            onClick={onExportPdf}
            aria-label="Export as PDF"
            title="Export as PDF"
          >
            <IconArrowDownWall aria-hidden="true" />
          </button>
        ) : null}
        {onAskNote ? (
          <button
            type="button"
            className="note-header-actions note-ask"
            onClick={onAskNote}
            aria-label="Ask this note"
            title="Ask this note"
          >
            <IconSparkle3 aria-hidden="true" />
          </button>
        ) : null}
        {onExportMarkdown ? (
          <button
            type="button"
            className="note-header-actions note-export-markdown"
            onClick={onExportMarkdown}
            aria-label="Export as Markdown"
            title="Export as Markdown"
          >
            <IconMarkdown aria-hidden="true" />
          </button>
        ) : null}
      </header>

      <section className="editor-content">
        {recovery ? (
          <NoteRecoveryPrompt
            recovery={recovery}
            onRecover={onRecoverRecording}
            onDiscard={onDiscardRecording}
            disabled={processingLock}
          />
        ) : null}
        {note.processingStatus === "failed" ? (
          <NoteFailureBanner
            errorMessage={note.lastError}
            audioPreserved={!!(note.audio || note.audioSources?.length)}
            onRetry={onRetry}
            onTopUp={onTopUp}
            topUpLabel={topUpLabel}
          />
        ) : null}
        {activeTab === "summary" ? (
          <NoteSummaryPanel noteId={note.id} onJumpToTime={jumpToTime} />
        ) : activeTab === "transcription" ? (
          <div className="transcript-view">
            {transcriptText ? (
              <div className="transcript-toolbar">
                {hasBothSources ? (
                  <SegmentedControl
                    className="transcript-source-filter"
                    aria-label="Filter transcript by source"
                    value={sourceFilter}
                    options={SOURCE_FILTERS}
                    onValueChange={setSourceFilter}
                  />
                ) : null}
                <CopyTranscriptButton
                  text={visibleTurns.length ? turnsToText(visibleTurns) : transcriptText}
                />
              </div>
            ) : null}
            {showLivePreviewWaiting ? (
              <div className="transcript-processing" role="status" aria-live="polite">
                <DotSpinner className="transcript-processing-spinner" />
                <span className="transcript-processing-label">
                  Listening for transcript preview...
                </span>
              </div>
            ) : showTranscriptProcessing && processingStatus ? (
              <ProcessingProgressIndicator
                className="transcript-processing-progress"
                status={processingStatus}
              />
            ) : null}
            {transcriptCoverageNotice ? (
              <p className="transcript-coverage-notice">{transcriptCoverageNotice}</p>
            ) : null}
            {visibleTurns.length ? (
              <div className="source-transcripts">
                {visibleTurns.map((transcript) => (
                  <TranscriptTurn
                    key={transcript.id}
                    transcript={transcript}
                    preview={transcript.preview}
                  />
                ))}
              </div>
            ) : note.transcript?.text ? (
              <p>{note.transcript.text}</p>
            ) : showTranscriptProcessing ? null : (
              <div className="transcript-empty">
                <p>
                  {recordingActive
                    ? "Transcript preview will appear here while you record."
                    : (processingText ??
                      (note.processingStatus === "failed"
                        ? "No transcript was produced."
                        : (note.lastError ?? "No transcript is available yet.")))}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="note-body-stack" data-reading={reading || undefined}>
            <div className={revealingNotes ? "note-reveal-active" : undefined}>
              <NotePreview
                noteId={note.id}
                markdown={content}
                onChange={onContentChange}
                editable={!reading}
                emptyPlaceholder={
                  processingLock
                    ? ""
                    : "Hit record to capture a conversation, or just start typing your thoughts here"
                }
              />
            </div>
            {/* The badge is the whole wait state now — no skeleton, since the
                generated note's shape isn't ours to predict. It clears as the
                notes wipe in above it. */}
            {processingStatus ? (
              <ProcessingProgressIndicator
                status={processingStatus}
                queuedRecordings={queuedRecordings}
                queuedTooltipId={queuedTooltipId}
              />
            ) : null}
          </div>
        )}
      </section>

      <div className="editor-footer">
        {micDenied && !recordingForNote ? (
          <InlineNotice
            className="record-mic-blocked"
            role="alert"
            aria-label="Microphone access required"
            icon={<IconMicrophoneOff size={14} aria-hidden />}
            body="Microphone access is blocked. You can still write notes here."
            actions={
              <button type="button" className="btn btn-secondary" onClick={onEnableMicrophone}>
                Enable
              </button>
            }
          />
        ) : (
          <div className="record-dock">
            <AnimatePresence>
              {recordingForNote?.warnings?.length ? (
                <motion.div
                  key="source-warning"
                  className="record-consent-note"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                >
                  <InlineNotice
                    className="record-consent-note-surface"
                    aria-label="Recording source warning"
                    body={recordingForNote.warnings[0].message}
                  />
                </motion.div>
              ) : null}
              {recordingForNote && consentReminderVisible && !recordingForNote.warnings?.length ? (
                <motion.div
                  key="consent"
                  className="record-consent-note"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.22, ease: EASE_OUT }}
                >
                  <InlineNotice
                    className="record-consent-note-surface"
                    aria-label="Recording consent reminder"
                    body="Make sure everyone has agreed to be recorded."
                    actions={
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => setConsentReminderVisible(false)}
                      >
                        Dismiss
                      </button>
                    }
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
            <div
              className="record-shell"
              data-state={shellState}
              data-options-open={
                !recordingForNote && !recordOptionsDisabled && showRecordingOptions && optionsOpen
              }
            >
              {!recordingForNote && !recordOptionsDisabled && showRecordingOptions ? (
                <div
                  className="record-options-panel"
                  data-open={optionsOpen}
                  aria-hidden={!optionsOpen}
                >
                  <div className="record-options-panel-inner">
                    {systemUnsupported ? (
                      <p className="record-options-unsupported">
                        System audio requires macOS 14.2 or later.
                      </p>
                    ) : (
                      <div className="record-options-row" data-locked={systemLocked || undefined}>
                        <Switch
                          checked={systemOn}
                          disabled={systemLocked}
                          aria-labelledby="record-options-system"
                          onCheckedChange={(next) =>
                            onSourceModeChange(next ? "microphonePlusSystem" : "microphoneOnly")
                          }
                        />
                        <span id="record-options-system" className="record-options-label">
                          Capture system audio
                        </span>
                        {systemAvailability === "denied" ? (
                          <button
                            type="button"
                            className="btn btn-ghost record-options-enable"
                            onClick={onEnableSystemAudio}
                          >
                            Enable
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
              <div className="record-stage">
                <AnimatePresence initial={false}>
                  {recordingForNote ? (
                    <motion.div
                      key="recorder"
                      className="record-state record-state-recorder"
                      initial={{ opacity: 0 }}
                      animate={{
                        opacity: 1,
                        transition: {
                          duration: 0.22,
                          delay: 0.14,
                          ease: EASE_OUT,
                        },
                      }}
                      exit={{
                        opacity: 0,
                        transition: {
                          duration: 0.12,
                          ease: EASE_OUT,
                        },
                      }}
                    >
                      <RecorderBar
                        status={recordingForNote}
                        onPause={onPauseRecording}
                        onResume={onResumeRecording}
                        onDone={onFinishRecording}
                      />
                    </motion.div>
                  ) : (
                    <motion.div
                      key="idle"
                      className="record-state record-state-idle"
                      initial={{ opacity: 0 }}
                      animate={{
                        opacity: 1,
                        // Symmetric to the recorder enter — delay the reveal
                        // so the idle pill resolves as the shell finishes
                        // collapsing back, not while it's still wide.
                        transition: {
                          duration: 0.22,
                          delay: 0.12,
                          ease: EASE_OUT,
                        },
                      }}
                      exit={{
                        opacity: 0,
                        transition: {
                          duration: 0.12,
                          ease: EASE_OUT,
                        },
                      }}
                    >
                      <div className="record-idle">
                        <button
                          type="button"
                          className="record-button"
                          aria-label={recordingDisabled ? "Recording in progress" : "Record"}
                          title={recordingDisabled ? "Recording in progress" : "Record"}
                          disabled={recordButtonDisabled}
                          onClick={onStartRecording}
                        >
                          <IconMicrophone size={20} />
                        </button>
                        {showRecordingOptions && !recordOptionsDisabled ? (
                          <button
                            type="button"
                            className="record-options-trigger"
                            aria-label="Recording options"
                            aria-expanded={optionsOpen}
                            data-rotated={optionsOpen}
                            onClick={() => setOptionsOpen((value) => !value)}
                          >
                            <IconChevronBottom size={16} />
                          </button>
                        ) : null}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function FolderChip({
  folders,
  folderIds,
  onAssign,
  onRemove,
  onCreateAndAssign,
  onNavigateToFolder,
}: {
  folders: FolderDto[];
  folderIds: string[];
  onAssign: (folderId: string) => void;
  onRemove: (folderId: string) => void;
  onCreateAndAssign: (name: string) => void;
  onNavigateToFolder?: (folderId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    function onClick(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const currentFolderId = folderIds[0];
  const currentFolder = folders.find((folder) => folder.id === currentFolderId);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return folders;
    return folders.filter((folder) => folder.name.toLowerCase().includes(normalized));
  }, [folders, query]);

  const trimmed = query.trim();
  const exactMatch = folders.some((folder) => folder.name.toLowerCase() === trimmed.toLowerCase());
  const showCreate = trimmed.length > 0 && !exactMatch;

  return (
    <div className="folder-chip-wrap" ref={ref}>
      <button
        type="button"
        className="move-to-folder-trigger"
        data-assigned={currentFolder !== undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconProjects size={14} />
        {currentFolder?.name ?? "Project"}
      </button>
      {currentFolder && onNavigateToFolder ? (
        <button
          type="button"
          className="move-to-folder-open"
          aria-label={`Open ${currentFolder.name}`}
          title={`Open ${currentFolder.name}`}
          onClick={() => {
            setOpen(false);
            onNavigateToFolder(currentFolder.id);
          }}
        >
          <IconChevronRightSmall size={13} />
        </button>
      ) : null}
      {open ? (
        <div className="move-to-folder-popover" role="menu">
          <div className="move-to-folder-search">
            <IconMagnifyingGlass size={13} />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search or create project"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && showCreate) {
                  event.preventDefault();
                  onCreateAndAssign(trimmed);
                  setOpen(false);
                }
              }}
            />
          </div>
          {showCreate ? (
            <>
              <button
                type="button"
                className="move-to-folder-create"
                onClick={() => {
                  onCreateAndAssign(trimmed);
                  setOpen(false);
                }}
              >
                <IconPlusMedium size={14} />
                <span className="move-to-folder-item-name">Create “{trimmed}”</span>
                <span aria-hidden />
              </button>
              <div className="move-to-folder-divider" aria-hidden />
            </>
          ) : null}
          <div className="move-to-folder-list">
            {filtered.length > 0 ? (
              filtered.map((folder) => {
                const isAssigned = folder.id === currentFolderId;
                return (
                  <button
                    key={folder.id}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={isAssigned}
                    className="move-to-folder-item"
                    onClick={() => (isAssigned ? onRemove(folder.id) : onAssign(folder.id))}
                  >
                    <IconProjects size={14} />
                    <span className="move-to-folder-item-name">{folder.name}</span>
                    <span className="move-to-folder-item-check" aria-hidden>
                      {isAssigned ? <IconCheckmark1 size={12} /> : null}
                    </span>
                  </button>
                );
              })
            ) : trimmed.length === 0 ? (
              <p className="move-to-folder-empty">No projects yet.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ProcessingProgressIndicator({
  status,
  queuedRecordings = 0,
  queuedTooltipId,
  className,
}: {
  status: ProcessingStageStatus;
  queuedRecordings?: number;
  queuedTooltipId?: string;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const classes = ["note-processing-progress", className].filter(Boolean).join(" ");

  return (
    <div className={classes} data-status={status} role="status" aria-live="polite">
      <DotSpinner className="note-processing-progress-spinner" />
      {/* A departure-board roll: each stage label rises into the one-line
          window as the previous one lifts out, blurring through the hand-off so
          the change feels organic rather than a hard cut. popLayout keeps the
          entering label in flow (so the chip stays sized) while the leaving one
          is popped out to slide away. Reduced motion drops to a plain
          crossfade. */}
      <div className="note-processing-roll">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={status}
            className="note-processing-roll-item"
            initial={reduceMotion ? { opacity: 0 } : { y: "65%", opacity: 0, filter: "blur(5px)" }}
            animate={reduceMotion ? { opacity: 1 } : { y: "0%", opacity: 1, filter: "blur(0px)" }}
            exit={reduceMotion ? { opacity: 0 } : { y: "-65%", opacity: 0, filter: "blur(5px)" }}
            transition={{
              duration: reduceMotion ? 0.15 : 0.5,
              ease: EASE_OUT,
            }}
          >
            {processingStageMessage(status)}
          </motion.span>
        </AnimatePresence>
      </div>
      {queuedRecordings > 0 && queuedTooltipId ? (
        <span className="note-generating-count" tabIndex={0} aria-describedby={queuedTooltipId}>
          +{queuedRecordings}
          <span className="note-generating-tip" id={queuedTooltipId} role="tooltip">
            {queuedRecordings} more recording
            {queuedRecordings > 1 ? "s" : ""} queued
          </span>
        </span>
      ) : null}
    </div>
  );
}

function processingStageStatus(status: NoteDto["processingStatus"]): ProcessingStageStatus | null {
  switch (status) {
    case "validating":
    case "transcribing":
    case "generating":
      return status;
    default:
      return null;
  }
}

// The stage name as it reads in the rolling label and the spoken status. Kept
// ellipsis-free: the roll and track motion already carry the "in progress"
// sense, so the words can stay calm.
function processingStageMessage(status: ProcessingStageStatus): string {
  switch (status) {
    case "validating":
      return "Preparing audio";
    case "transcribing":
      return "Transcribing audio";
    case "generating":
      return "Generating notes";
  }
}

function processingMessage(status: NoteDto["processingStatus"]): string | null {
  switch (status) {
    case "validating":
      return "Preparing audio…";
    case "transcribing":
      return "Transcribing audio…";
    case "generating":
      return "Generating notes…";
    default:
      return null;
  }
}

function turnsToText(turns: RenderedTranscriptTurn[]): string {
  return turns
    .filter((turn) => turn.text.trim())
    .map((turn) => {
      const meta = formatTurnTime(turn.startMs, turn.endMs)
        ? `${sourceLabel(turn.source)} ${formatTurnTime(turn.startMs, turn.endMs)}`
        : sourceLabel(turn.source);
      return `${meta}\n${turn.text}`;
    })
    .join("\n\n");
}

function transcriptToText(note: NoteDto, liveTurns: RenderedTranscriptTurn[] = []): string {
  const sourceTurns = orderedVisibleSourceTranscripts(note);
  if (sourceTurns.length || liveTurns.length) {
    return turnsToText(
      [...sourceTurns, ...liveTurns]
        .map((turn, index) => ({ turn, index }))
        .sort(compareSourceTranscriptOrder)
        .map(({ turn }) => turn),
    );
  }
  return note.transcript?.text ?? "";
}

function transcriptCoverageNoticeText(note: NoteDto): string | null {
  const coverage = note.transcriptCoverage;
  if (!coverage?.warning) return null;
  const detectedSpeechMs = Math.max(0, coverage.detectedSpeechMs);
  const transcribedMs = Math.max(0, coverage.transcribedMs);
  const missingMs = Math.max(0, detectedSpeechMs - transcribedMs);
  const missingMinutes = Math.max(1, Math.floor(missingMs / 60_000));
  const detectedMinutes = Math.max(1, Math.floor(detectedSpeechMs / 60_000));
  return `Parts of this recording could not be transcribed. About ${missingMinutes} of ${detectedMinutes} minutes of detected speech are missing from this transcript.`;
}

function orderedVisibleSourceTranscripts(note: NoteDto): RenderedTranscriptTurn[] {
  return (note.sourceTranscripts ?? [])
    .filter((turn) => {
      if (turn.text.trim()) return true;
      return Boolean(turn.lastError);
    })
    .map((turn, index) => ({ turn, index }))
    .sort(compareSourceTranscriptOrder)
    .map(({ turn }) => turn);
}

function liveTranscriptEventToTurn(event: LiveTranscriptEventDto): RenderedTranscriptTurn {
  return {
    id: `live-${event.sessionId}-${event.source}-${event.segmentId}`,
    text: event.text,
    sourceMode: event.sourceMode,
    source: event.source,
    startMs: event.startMs,
    endMs: event.endMs,
    turnIndex: undefined,
    language: event.language,
    status: "running",
    preview: true,
    stability: event.stability,
  };
}

function compareSourceTranscriptOrder(
  left: { turn: RenderedTranscriptTurn; index: number },
  right: { turn: RenderedTranscriptTurn; index: number },
) {
  const turnIndexOrder = compareOptionalNumber(left.turn.turnIndex, right.turn.turnIndex);
  if (turnIndexOrder !== 0) return turnIndexOrder;

  const startOrder = compareOptionalNumber(left.turn.startMs, right.turn.startMs);
  if (startOrder !== 0) return startOrder;

  const endOrder = compareOptionalNumber(left.turn.endMs, right.turn.endMs);
  if (endOrder !== 0) return endOrder;

  return left.index - right.index;
}

function compareOptionalNumber(left?: number, right?: number) {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left - right;
}

/** A single conversation turn in the Transcription tab. Mirrors the dictation
 * history row language: a source glyph, a light meta line, and the transcript
 * text — copy reveals on hover, long turns clamp to a "Show more" toggle. */
function TranscriptTurn({
  transcript,
  preview = false,
}: {
  transcript: RenderedTranscriptTurn;
  preview?: boolean;
}) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  const isSystem = transcript.source === "system";
  const turnTime = formatTurnTime(transcript.startMs, transcript.endMs);
  const hasText = transcript.text.trim().length > 0;
  // Every turn is copyable — a turn where nothing was said still carries
  // its error ("No speech detected…"), which is worth being able to grab.
  // The error is run through userFacingFailureMessage so raw provider codes
  // never reach the clipboard (or the card below).
  const errorMessage = sourceTurnFailureMessage(transcript.lastError);
  const copyValue = hasText ? transcript.text : errorMessage;
  const canCopy = copyValue.trim().length > 0;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // Measure whether the collapsed text overflows its line clamp so the
  // "Show more" toggle only appears when there's hidden content.
  useEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const measure = () => setClamped(el.scrollHeight - el.clientHeight > 1);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [transcript.text, expanded]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
    } catch {
      // Clipboard can fail in restricted contexts; stay silent.
    }
  }

  return (
    <article
      className="transcript-turn"
      data-source={isSystem ? "system" : "microphone"}
      data-turn-id={transcript.id}
    >
      <span className="transcript-turn-icon" aria-hidden>
        {isSystem ? <IconVolumeFull size={14} /> : <IconMicrophoneLine size={14} />}
      </span>
      <div className="transcript-turn-body">
        <div className="transcript-turn-meta">
          <span className="transcript-turn-source">{sourceLabel(transcript.source)}</span>
          {turnTime ? <time>{turnTime}</time> : null}
          {preview ? <span className="transcript-turn-preview">Live preview</span> : null}
        </div>
        {hasText ? (
          <p ref={textRef} className="transcript-turn-text" data-expanded={expanded || undefined}>
            {transcript.text}
          </p>
        ) : null}
        {clamped || expanded ? (
          <button
            type="button"
            className="transcript-turn-more"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
        {errorMessage ? <p className="source-transcript-error">{errorMessage}</p> : null}
      </div>
      {canCopy ? (
        <button
          type="button"
          className="transcript-turn-copy"
          data-copied={copied || undefined}
          aria-label={copied ? "Copied" : "Copy turn"}
          title={copied ? "Copied" : "Copy"}
          onClick={() => void handleCopy()}
        >
          {copied ? <IconCheckmark1 size={14} /> : <IconClipboard size={14} />}
        </button>
      ) : null}
    </article>
  );
}

function sourceTurnFailureMessage(message?: string) {
  if (message && isInvalidJuneResponseMessage(message)) {
    return "Audio for this part could not be transcribed.";
  }
  return userFacingFailureMessage(message) ?? "";
}

function CopyTranscriptButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard API can fail in restricted contexts; stay silent
      // rather than nag — the user can retry.
    }
  }

  return (
    <button
      type="button"
      className="transcript-copy"
      onClick={() => void handleCopy()}
      data-copied={copied || undefined}
      aria-label={copied ? "Transcript copied" : "Copy transcript"}
      title={copied ? "Copied" : "Copy transcript"}
    >
      {copied ? <IconCheckmark1 size={14} /> : <IconClipboard size={14} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function formatFullDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Today";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}
