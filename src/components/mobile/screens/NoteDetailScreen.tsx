import { t } from "../../../lib/i18n";
import { IconArrowBoxRight } from "central-icons/IconArrowBoxRight";
import { IconSparkle3 } from "central-icons/IconSparkle3";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useState } from "react";
import type {
  FolderDto,
  LiveTranscriptEventDto,
  NoteDto,
  NoteTab,
  RecoverableRecordingDto,
  RecordingSourceReadinessDto,
  RecordingStatusDto,
} from "../../../lib/tauri";
import { shareText } from "../../../lib/tauri";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Spinner } from "../../ui/Spinner";
import { NoteEditor } from "../../note-editor/NoteEditor";
import { AskNoteOverlay } from "../../ask/AskNoteOverlay";
import { StackHeader } from "../StackHeader";

type NoteDetailScreenProps = {
  note?: NoteDto;
  folders: FolderDto[];
  recordingStatus?: RecordingStatusDto;
  recordingDisabled: boolean;
  liveTranscript: LiveTranscriptEventDto[];
  sourceReadiness?: RecordingSourceReadinessDto;
  microphoneBlocked: boolean;
  onBack: () => void;
  onTitleChange: (title: string) => void;
  onContentChange: (noteId: string, content: string) => void;
  onStartRecording: () => void;
  onPauseRecording: (sessionId: string) => void;
  onResumeRecording: (sessionId: string) => void;
  onFinishRecording: (sessionId: string) => void;
  onRetry: () => void | Promise<void>;
  onDelete: () => void;
  /** The interrupted recording this note is waiting on, if there is one. */
  recovery?: RecoverableRecordingDto;
  onRecoverRecording: (sessionId: string) => void;
  onDiscardRecording: (sessionId: string) => void;
  onAssignFolder: (folderId: string) => void;
  onRemoveFolder: (folderId: string) => void;
  onCreateAndAssignFolder: (name: string) => void;
  onTabChange: (tab: NoteTab) => void;
};

/**
 * Full-screen note view: the shared NoteEditor (recorder bar, live transcript,
 * Tiptap editor, folder picker) under a mobile stack header. Mobile records
 * microphone-only; the system-audio affordances inside NoteEditor stay hidden
 * because the source mode never leaves `microphoneOnly`.
 */
export function NoteDetailScreen({
  note,
  folders,
  recordingStatus,
  recordingDisabled,
  liveTranscript,
  sourceReadiness,
  microphoneBlocked,
  onBack,
  onTitleChange,
  onContentChange,
  onStartRecording,
  onPauseRecording,
  onResumeRecording,
  onFinishRecording,
  onRetry,
  onDelete,
  recovery,
  onRecoverRecording,
  onDiscardRecording,
  onAssignFolder,
  onRemoveFolder,
  onCreateAndAssignFolder,
  onTabChange,
}: NoteDetailScreenProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  // "Ask this note": a question answered from this note alone (ADR-0044).
  const [asking, setAsking] = useState(false);

  return (
    <div className="mobile-screen-root mobile-note-detail">
      <StackHeader
        title=""
        onBack={onBack}
        backLabel={t("Notes")}
        trailing={
          <>
            <button
              type="button"
              className="mobile-icon-button"
              aria-label={t("Ask this note")}
              disabled={!note}
              onClick={() => setAsking(true)}
            >
              <IconSparkle3 size={18} />
            </button>
            <button
              type="button"
              className="mobile-icon-button"
              aria-label={t("Export note")}
              disabled={!note}
              onClick={() => {
                if (!note) return;
                const title = note.title.trim() || "New note";
                const body = note.editedContent ?? note.generatedContent ?? "";
                void shareText(`# ${title}\n\n${body}`).catch(() => undefined);
              }}
            >
              <IconArrowBoxRight size={18} />
            </button>
            <button
              type="button"
              className="mobile-icon-button"
              aria-label={t("Delete note")}
              onClick={() => setConfirmDelete(true)}
            >
              <IconTrashCan size={18} />
            </button>
          </>
        }
      />
      {asking && note ? (
        <AskNoteOverlay
          noteId={note.id}
          title={note.title}
          onOpenNote={() => setAsking(false)}
          onClose={() => setAsking(false)}
        />
      ) : null}
      <div className="mobile-note-detail-scroll">
        {note ? (
          <NoteEditor
            note={note}
            folders={folders}
            recordingStatus={recordingStatus}
            recordingDisabled={recordingDisabled}
            liveTranscript={liveTranscript}
            sourceMode="microphoneOnly"
            sourceReadiness={sourceReadiness}
            microphoneBlocked={microphoneBlocked}
            onTitleChange={onTitleChange}
            onContentChange={onContentChange}
            onSourceModeChange={() => undefined}
            onEnableSystemAudio={() => undefined}
            onEnableMicrophone={() => undefined}
            onStartRecording={onStartRecording}
            onPauseRecording={onPauseRecording}
            onResumeRecording={onResumeRecording}
            onFinishRecording={onFinishRecording}
            onRetry={onRetry}
            onTopUp={() => undefined}
            recovery={recovery}
            onRecoverRecording={onRecoverRecording}
            onDiscardRecording={onDiscardRecording}
            onAssignFolder={onAssignFolder}
            onRemoveFolder={onRemoveFolder}
            onCreateAndAssignFolder={onCreateAndAssignFolder}
            onTabChange={onTabChange}
          />
        ) : (
          <section className="editor-empty" role="status" aria-label={t("Opening note")}>
            <Spinner />
          </section>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={t("Delete this note?")}
        description={t("The note, its audio, and its transcript are removed from this device.")}
        confirmLabel={t("Delete")}
        destructive
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
