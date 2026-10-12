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

/** Fired when the shell asks an open Studio to show a tab. */
export const OPEN_STUDIO_TAB_EVENT = "subrosa:studio:open-tab";

/**
 * Ask the Studio to open on a tab ("image", "video"), from anywhere in the
 * shell. The saved tab is set first, so a Studio that is not mounted yet
 * opens there; one that is mounted hears the event.
 */
export function requestStudioTab(tab: "image" | "video" | "audio") {
  try {
    window.localStorage.setItem(STUDIO_TAB_STORAGE_KEY, tab);
  } catch {
    // The event still reaches a mounted Studio.
  }
  window.dispatchEvent(new CustomEvent(OPEN_STUDIO_TAB_EVENT, { detail: tab }));
}
