import { IconArrowBoxRight } from "central-icons/IconArrowBoxRight";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useState } from "react";
import type {
  FolderDto,
  LiveTranscriptEventDto,
  NoteDto,
  RecordingSourceReadinessDto,
  RecordingStatusDto,
} from "../../../lib/tauri";
import { shareText } from "../../../lib/tauri";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Spinner } from "../../ui/Spinner";
import { NoteEditor } from "../../note-editor/NoteEditor";
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
  onAssignFolder: (folderId: string) => void;
  onRemoveFolder: (folderId: string) => void;
  onCreateAndAssignFolder: (name: string) => void;
  onTabChange: (tab: "notes" | "transcription") => void;
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
  onAssignFolder,
  onRemoveFolder,
  onCreateAndAssignFolder,
  onTabChange,
}: NoteDetailScreenProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="mobile-screen-root mobile-note-detail">
      <StackHeader
        title=""
        onBack={onBack}
        backLabel="Notes"
        trailing={
          <>
            <button
              type="button"
              className="mobile-icon-button"
              aria-label="Export note"
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
              aria-label="Delete note"
              onClick={() => setConfirmDelete(true)}
            >
              <IconTrashCan size={18} />
            </button>
          </>
        }
      />
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
            onRecoverRecording={() => undefined}
            onDiscardRecording={() => undefined}
            onAssignFolder={onAssignFolder}
            onRemoveFolder={onRemoveFolder}
            onCreateAndAssignFolder={onCreateAndAssignFolder}
            onTabChange={onTabChange}
          />
        ) : (
          <section className="editor-empty" role="status" aria-label="Opening note">
            <Spinner />
          </section>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this note?"
        description="The note, its audio, and its transcript are removed from this device."
        confirmLabel="Delete"
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
