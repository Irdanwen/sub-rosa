// Pick one of the user's notes to fill a document slot — the note-flavored
// sibling of GalleryPicker's pull model: the slot opens the list and takes
// what it needs.

import { t } from "../../lib/i18n";
import { useEffect, useMemo, useState } from "react";
import { listNotes, type NoteListItemDto } from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";
import { Spinner } from "../ui/Spinner";

export function NotePicker({
  onPick,
  onClose,
}: {
  onPick: (note: NoteListItemDto) => void;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState<NoteListItemDto[] | undefined>(undefined);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    listNotes()
      .then((response) => {
        if (!cancelled) setNotes(response.items);
      })
      .catch(() => {
        if (!cancelled) setNotes([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => {
    if (!notes) return undefined;
    const needle = query.trim().toLowerCase();
    if (!needle) return notes;
    return notes.filter(
      (note) =>
        note.title.toLowerCase().includes(needle) || note.preview.toLowerCase().includes(needle),
    );
  }, [notes, query]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("From your notes")}
      description={t("Pick the note this document should read from.")}
      width={520}
    >
      <div className="dialog-body">
        <input
          className="studio-input"
          value={query}
          placeholder={t("Search notes")}
          aria-label={t("Search notes")}
          onChange={(event) => setQuery(event.target.value)}
        />
        {visible === undefined ? (
          <div className="studio-picker-empty">
            <Spinner aria-label={t("Loading notes")} />
          </div>
        ) : visible.length === 0 ? (
          <p className="studio-picker-empty">
            {query.trim()
              ? t("No notes match.")
              : // Distinguishing the two matters here: somebody sent to this
                // dialog to pick a script has quite possibly not written one.
                t("You have no notes yet. Write one first - a note is where a film starts.")}
          </p>
        ) : (
          <ul className="studio-note-picker-list">
            {visible.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  className="studio-note-picker-item"
                  onClick={() => {
                    onPick(note);
                    onClose();
                  }}
                >
                  <span className="studio-note-picker-title">
                    {note.title || t("Untitled note")}
                  </span>
                  {note.preview ? (
                    <span className="studio-note-picker-preview">{note.preview}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
