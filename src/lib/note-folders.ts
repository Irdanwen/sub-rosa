import { assignNoteToFolder, removeNoteFromFolder } from "./tauri";

type Filed = { id: string; folderIds: string[] };
type Updated = Awaited<ReturnType<typeof assignNoteToFolder>>;

/**
 * Put a note in one folder, or in none.
 *
 * The data model lets a note sit in several folders (`note_folders` has a
 * composite key); the product says one. The desktop enforced that and the
 * phone did not: picking a second folder added it, and the chip went on
 * naming the first. Both shells now move through here.
 *
 * `keep` names folders a move leaves alone. The phone's Archive is a folder,
 * and archiving is a state on top of a note's project, not a replacement for
 * it, so moving an archived note between projects keeps it archived.
 *
 * `onUpdated` sees each note the backend hands back, in order, so a shell can
 * dispatch as it goes; the last one is also returned.
 */
export async function moveNoteToFolder(
  note: Filed,
  folderId: string | undefined,
  { keep = [], onUpdated }: { keep?: string[]; onUpdated?: (note: Updated) => void } = {},
): Promise<Updated | undefined> {
  let last: Updated | undefined;
  for (const existing of note.folderIds) {
    if (existing === folderId || keep.includes(existing)) continue;
    last = await removeNoteFromFolder(note.id, existing);
    onUpdated?.(last);
  }
  if (folderId && !note.folderIds.includes(folderId)) {
    last = await assignNoteToFolder(note.id, folderId);
    onUpdated?.(last);
  }
  return last;
}

/** The folder a note is filed in, leaving out the ones that are states. */
export function noteFolderId(note: Filed, unlisted: string[] = []): string | undefined {
  return note.folderIds.find((id) => !unlisted.includes(id));
}
