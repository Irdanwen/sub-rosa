// What every model picker does with its list, whichever shell draws it: the
// phone's sheet and the desktop's popover search, filter and order the same
// way, and share the favourites a person has starred.

export type ModelPickerTag = { label: string; tone?: "note" };

export type ModelPickerEntry = {
  id: string;
  name?: string;
  subtitle?: string;
  /** Extra spellings this entry should be findable by, beyond what the row
   * displays. A row can stand for several backend models (a video family is one
   * row for up to four), and those models' own ids and names are then the very
   * thing a user searches for while nothing on screen contains them. */
  keywords?: string[];
  /** Short facts shown under the subtitle as small pills, for a row that
   * stands for several contracts at once (a video family's directions). A
   * `note` tone marks the one that changes what the user has to supply. */
  tags?: ModelPickerTag[];
  /** The filter groups this entry belongs to (see `filters`). */
  groups?: string[];
};

export type ModelPickerFilter = { id: string; label: string };

// The key predates the desktop picker; keeping it keeps a person's stars.
const FAVORITES_STORAGE_KEY = "subrosa:mobile:model-favorites";

export function readModelFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

export function writeModelFavorites(favorites: Set<string>) {
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...favorites]));
  } catch {
    // Favorites are a convenience; losing them is harmless.
  }
}

/**
 * The entries to show, in order: narrowed to a filter group, matched against
 * the search, then the recommended entry first (while nothing is searched),
 * favourites next, the rest by name.
 */
export function visibleModelEntries(
  entries: readonly ModelPickerEntry[],
  {
    query,
    filter,
    favorites,
    pinnedId,
  }: { query: string; filter: string; favorites: Set<string>; pinnedId?: string },
): ModelPickerEntry[] {
  const needle = query.trim().toLowerCase();
  const grouped =
    filter === "all" ? entries : entries.filter((entry) => entry.groups?.includes(filter));
  // Each term is matched whole rather than concatenated into one haystack, so
  // a needle can never straddle two of them and match nothing real.
  const matches = needle
    ? grouped.filter((entry) =>
        [
          entry.id,
          entry.name ?? "",
          entry.subtitle ?? "",
          ...(entry.tags ?? []).map((tag) => tag.label),
          ...(entry.keywords ?? []),
        ].some((term) => term.toLowerCase().includes(needle)),
      )
    : grouped;
  return [...matches].sort((a, b) => {
    if (!needle && pinnedId && (a.id === pinnedId) !== (b.id === pinnedId)) {
      return a.id === pinnedId ? -1 : 1;
    }
    const favA = favorites.has(a.id) ? 0 : 1;
    const favB = favorites.has(b.id) ? 0 : 1;
    if (favA !== favB) return favA - favB;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
}
