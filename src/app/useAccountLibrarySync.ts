import { useEffect, useRef, type Dispatch } from "react";
import { useAccountSyncUpdated } from "../lib/account-sync-events";
import { getNote, listFolders, listNotes } from "../lib/tauri";
import type { NotesAction } from "./state/app-state";

/** Re-read committed native arrivals without selecting a different note or
 * replacing the recording state. The editor already defers incoming markdown
 * while its caret is active, exactly as it does for an agent's local edits. */
export function useAccountLibrarySync(dispatch: Dispatch<NotesAction>, selectedNoteId?: string) {
  const mounted = useRef(false);
  const selected = useRef(selectedNoteId);
  selected.current = selectedNoteId;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useAccountSyncUpdated(async () => {
    const open = selected.current;
    const [notes, folders, note] = await Promise.allSettled([
      listNotes(),
      listFolders(),
      open ? getNote(open) : Promise.resolve(null),
    ]);
    if (!mounted.current) return;
    if (notes.status === "fulfilled")
      dispatch({ type: "notesRefreshed", notes: notes.value.items });
    if (folders.status === "fulfilled") dispatch({ type: "foldersLoaded", folders: folders.value });
    if (note.status === "fulfilled" && note.value && selected.current === open) {
      dispatch({ type: "noteLoaded", note: note.value });
    }
  });
}
