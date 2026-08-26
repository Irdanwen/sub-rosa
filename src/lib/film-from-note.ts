/**
 * Getting from a note to the film it becomes.
 *
 * The note editor and the Film tab are different parts of the app, and
 * threading a callback from one to the other would mean the note editor
 * knowing the Studio exists. It dispatches one window event instead and the
 * shell answers it - the same decoupling the chat blocks use to open a note.
 */

export const FILM_FROM_NOTE_EVENT = "june:film-from-note";

export type FilmFromNoteDetail = { noteId: string };

export function requestFilmFromNote(noteId: string) {
  window.dispatchEvent(
    new CustomEvent<FilmFromNoteDetail>(FILM_FROM_NOTE_EVENT, { detail: { noteId } }),
  );
}
