/**
 * Storage keys the shell and the Studio share. They live apart from the
 * view so the shell can read them without loading the Studio's code.
 */
export const STUDIO_TAB_STORAGE_KEY = "os-june:studio-tab";
/**
 * A note the shell asked the Film tab to open, left here rather than passed.
 *
 * The Studio is mounted lazily by the shell, so a prop would have to be
 * threaded through a view that may not exist yet. One key, read once and
 * cleared, is the smaller thing.
 */
export const STUDIO_FILM_NOTE_KEY = "os-june:studio-film-note";
