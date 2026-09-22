import { t } from "../../../lib/i18n";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconSparkle3 } from "central-icons/IconSparkle3";
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
import { ShareNoteDialog } from "../../share/ShareNoteDialog";
import { useCanShare } from "../../share/useCanShare";
import { AskNoteOverlay } from "../../ask/AskNoteOverlay";
import { ActionSheet } from "../ActionSheet";
import { FolderPickerSheet } from "../FolderPickerSheet";
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
  /** File the note in one folder, or in none. */
  onMoveToFolder: (folderId: string | undefined) => void;
  /** The phone's Archive: a state, never offered as a place to file. */
  archiveFolderId?: string;
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
  onMoveToFolder,
  archiveFolderId,
  onTabChange,
}: NoteDetailScreenProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  // "Ask this note": a question answered from this note alone (ADR-0044).
  const [asking, setAsking] = useState(false);
  // Making a link to this note (ADR-0053). Absent without an account: a share
  // needs somewhere to put the ciphertext.
  const [sharing, setSharing] = useState(false);
  const canShare = useCanShare();
  // Export and delete live behind one button. A bin in the header, next to
  // the question button and a thumb's width from the back button, was one
  // mistaken tap from a confirmation nobody wanted to see.
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const unlisted = archiveFolderId ? [archiveFolderId] : [];

  const exportNote = () => {
    if (!note) return;
    const title = note.title.trim() || t("New note");
    const body = note.editedContent ?? note.generatedContent ?? "";
    void shareText(`# ${title}\n\n${body}`).catch(() => undefined);
  };

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
              aria-label={t("More actions")}
              aria-haspopup="dialog"
              disabled={!note}
              onClick={() => setMenuOpen(true)}
            >
              <IconDotGrid1x3Horizontal size={18} />
            </button>
          </>
        }
      />
      {menuOpen && note ? (
        <ActionSheet
          title={note.title.trim() || t("New note")}
          subtitle={t("What would you like to do with this note?")}
          actions={[
            { label: t("Export note"), onAction: exportNote },
            {
              label: t("Move to a folder"),
              // Opens once this sheet has closed and handed focus back.
              onAction: () => window.setTimeout(() => setPickingFolder(true), 0),
            },
            { label: t("Delete note"), destructive: true, onAction: () => setConfirmDelete(true) },
          ]}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
      {pickingFolder && note ? (
        <FolderPickerSheet
          title={t("Move to a folder")}
          folders={folders.filter((folder) => !unlisted.includes(folder.id))}
          currentFolderId={note.folderIds.find((id) => !unlisted.includes(id)) ?? null}
          onPick={(folderId) => {
            setPickingFolder(false);
            onMoveToFolder(folderId);
          }}
          onCreate={(name) => {
            setPickingFolder(false);
            onCreateAndAssignFolder(name);
          }}
          onClose={() => setPickingFolder(false)}
        />
      ) : null}
      {asking && note ? (
        <AskNoteOverlay
          noteId={note.id}
          title={note.title}
          onOpenNote={() => setAsking(false)}
          onClose={() => setAsking(false)}
        />
      ) : null}
      {note ? (
        <ShareNoteDialog noteId={note.id} open={sharing} onClose={() => setSharing(false)} />
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
            onOpenFolderPicker={() => setPickingFolder(true)}
            unlistedFolderIds={unlisted}
            onTabChange={onTabChange}
            onShare={canShare ? () => setSharing(true) : undefined}
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
