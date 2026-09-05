import { t } from "../../../lib/i18n";
import { IconSparkle3 } from "central-icons/IconSparkle3";
import { IMPORTABLE_MEDIA_ACCEPT } from "../../../lib/import-media";
import { ImportLinkBar } from "../../notes-list/ImportLinkBar";
import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconFolder2 } from "central-icons/IconFolder2";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FolderDto, NoteListItemDto } from "../../../lib/tauri";
import { searchEverything } from "../../../lib/tauri";
import { AskNotesPanel, looksLikeAQuestion } from "../../ask/AskNotesPanel";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { ActionSheet } from "../ActionSheet";
import { EmptyState } from "../../ui/EmptyState";
import { PullToRefresh } from "../PullToRefresh";
import { StackHeader } from "../StackHeader";
import { SwipeableRow } from "../SwipeableRow";
import { NoteRow } from "./NoteRow";

type NotesScreenProps = {
  notes: NoteListItemDto[];
  folders: FolderDto[];
  activeRecordingNoteId?: string;
  /** Notes assigned to this folder are hidden from the main list. */
  archiveFolderId?: string;
  onSelectNote: (noteId: string) => void;
  onRecord: () => void;
  onCreateNote: () => void;
  onImportAudio: (file: File) => void;
  onOpenFolder: (folderId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onArchiveNote: (noteId: string) => void;
  onRefresh: () => Promise<unknown>;
};

export function NotesScreen({
  notes,
  folders,
  activeRecordingNoteId,
  archiveFolderId,
  onSelectNote,
  onRecord,
  onCreateNote,
  onImportAudio,
  onOpenFolder,
  onDeleteNote,
  onArchiveNote,
  onRefresh,
}: NotesScreenProps) {
  const [query, setQuery] = useState("");
  const [askQuestion, setAskQuestion] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<NoteListItemDto | null>(null);
  // The note a long press opened the actions for. The swipe still works; this
  // is the route that does not have to be discovered.
  const [rowMenu, setRowMenu] = useState<NoteListItemDto | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const sortedNotes = useMemo(
    () =>
      [...notes]
        .filter((note) => !archiveFolderId || !note.folderIds.includes(archiveFolderId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [notes, archiveFolderId],
  );
  // Ids of the notes whose body or transcript contains the query, from the
  // full-text index (migration 020). The title-and-preview filter below is
  // instant and stays first; these arrive a beat later and add the notes
  // whose match sits deeper than the preview.
  const [deepHitIds, setDeepHitIds] = useState<string[]>([]);
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setDeepHitIds([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchEverything(trimmed, 30)
        .then((hits) => {
          if (cancelled) return;
          setDeepHitIds(
            hits
              .filter((hit) => hit.kind === "note" || hit.kind === "transcript")
              .map((hit) => hit.targetId),
          );
        })
        .catch(() => {
          if (!cancelled) setDeepHitIds([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const visibleNotes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sortedNotes;
    const shallow = sortedNotes.filter(
      (note) =>
        note.title.toLowerCase().includes(needle) ||
        (note.preview ?? "").toLowerCase().includes(needle),
    );
    if (deepHitIds.length === 0) return shallow;
    const shown = new Set(shallow.map((note) => note.id));
    const byId = new Map(sortedNotes.map((note) => [note.id, note]));
    const deep = deepHitIds
      .filter((id) => !shown.has(id))
      .map((id) => byId.get(id))
      .filter((note): note is NoteListItemDto => Boolean(note));
    return [...shallow, ...deep];
  }, [sortedNotes, query, deepHitIds]);

  return (
    <div className="mobile-screen-root">
      <StackHeader
        title={t("Notes")}
        large
        trailing={
          <>
            <input
              ref={importInputRef}
              type="file"
              // Video too: a video file is an audio track the app reads.
              // The extension list is shared so it cannot drift from the one
              // the Rust boundary accepts.
              accept={`audio/*,video/*,${IMPORTABLE_MEDIA_ACCEPT}`}
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) onImportAudio(file);
              }}
            />
            <button
              type="button"
              className="mobile-icon-button"
              aria-label={t("Import audio or video")}
              onClick={() => importInputRef.current?.click()}
            >
              <IconArrowInbox size={20} />
            </button>
            <button
              type="button"
              className="mobile-icon-button"
              aria-label={t("New note")}
              onClick={onCreateNote}
            >
              <IconPlusMedium size={20} />
            </button>
          </>
        }
      />
      <div className="mobile-search">
        <IconMagnifyingGlass size={16} aria-hidden />
        <input
          type="search"
          placeholder={t("Search notes")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>
      {looksLikeAQuestion(query) && askQuestion !== query.trim() ? (
        <button
          type="button"
          className="mobile-ask-button"
          onClick={() => setAskQuestion(query.trim())}
        >
          <IconSparkle3 size={14} aria-hidden />
          <span>{t("Ask your notes")}</span>
        </button>
      ) : null}
      {askQuestion ? (
        <div className="mobile-ask">
          <AskNotesPanel
            question={askQuestion}
            onOpenNote={(noteId) => {
              setAskQuestion(null);
              onSelectNote(noteId);
            }}
            onClose={() => setAskQuestion(null)}
          />
        </div>
      ) : null}
      {folders.length > 0 ? (
        <div className="mobile-folder-strip" role="list" aria-label={t("Folders")}>
          {folders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              className="mobile-folder-chip"
              onClick={() => onOpenFolder(folder.id)}
            >
              <IconFolder2 size={14} aria-hidden />
              <span>{folder.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      {/* ADR-0028 gives the phone rails A and B in full: a picked file and a
          published URL. Only the extractor rail is desktop-bound. */}
      <div className="mobile-link-import">
        <ImportLinkBar onCompleted={() => void onRefresh()} />
      </div>
      <PullToRefresh className="mobile-list-scroll" onRefresh={onRefresh}>
        {visibleNotes.length === 0 ? (
          <EmptyState
            icon={query ? <IconMagnifyingGlass size={28} /> : <IconMicrophone size={28} />}
            title={query ? t("No matches") : t("No notes yet")}
            description={
              query
                ? t("Try a different search.")
                : t("Tap the record button to capture your first meeting.")
            }
          />
        ) : (
          <ul className="mobile-note-list">
            {visibleNotes.map((note) => (
              <li key={note.id}>
                <SwipeableRow
                  actions={[
                    {
                      label: t("Archive"),
                      tone: "neutral",
                      onAction: () => onArchiveNote(note.id),
                    },
                    {
                      label: t("Delete"),
                      tone: "destructive",
                      onAction: () => setConfirmDelete(note),
                    },
                  ]}
                >
                  <NoteRow
                    note={note}
                    recording={note.id === activeRecordingNoteId}
                    onSelect={() => onSelectNote(note.id)}
                    onLongPress={() => setRowMenu(note)}
                  />
                </SwipeableRow>
              </li>
            ))}
          </ul>
        )}
      </PullToRefresh>
      <button type="button" className="mobile-record-fab" onClick={onRecord}>
        <IconMicrophone size={22} aria-hidden />
        <span>{t("Record")}</span>
      </button>
      {rowMenu ? (
        <ActionSheet
          title={rowMenu.title.trim() || t("New note")}
          subtitle={t("What would you like to do with this note?")}
          actions={[
            // Only what this screen can actually do. Moving to a project lives
            // on the note itself, and an entry here that opened something else
            // would be a promise the sheet cannot keep.
            { label: t("Open"), onAction: () => onSelectNote(rowMenu.id) },
            { label: t("Archive"), onAction: () => onArchiveNote(rowMenu.id) },
            {
              label: t("Delete"),
              destructive: true,
              onAction: () => setConfirmDelete(rowMenu),
            },
          ]}
          onClose={() => setRowMenu(null)}
        />
      ) : null}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("Delete this note?")}
        description={t("The note, its audio, and its transcript are removed from this device.")}
        confirmLabel={t("Delete")}
        destructive
        onConfirm={() => {
          if (confirmDelete) onDeleteNote(confirmDelete.id);
          setConfirmDelete(null);
        }}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}
