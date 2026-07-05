import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconStar } from "central-icons/IconStar";
import { useMemo, useState } from "react";
import { hapticSelection } from "../../lib/haptics";

export type ModelSheetEntry = {
  id: string;
  name?: string;
  subtitle?: string;
};

const FAVORITES_STORAGE_KEY = "subrosa:mobile:model-favorites";

function readFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function writeFavorites(favorites: Set<string>) {
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...favorites]));
  } catch {
    // Favorites are a convenience; losing them is harmless.
  }
}

type ModelSheetProps = {
  title: string;
  entries: ModelSheetEntry[];
  selectedId: string;
  /** Optional entry pinned above the list (e.g. "Default"). */
  defaultOption?: { label: string; subtitle?: string };
  error?: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
};

/**
 * Shared model picker sheet: search box, star-to-favorite (favorites pin to
 * the top, remembered across the app), one tap to select. Replaces bare
 * `<select>`s wherever the catalog is long.
 */
export function ModelSheet({
  title,
  entries,
  selectedId,
  defaultOption,
  error,
  onSelect,
  onClose,
}: ModelSheetProps) {
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(readFavorites);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? entries.filter(
          (entry) =>
            entry.id.toLowerCase().includes(needle) ||
            (entry.name ?? "").toLowerCase().includes(needle),
        )
      : entries;
    return [...matches].sort((a, b) => {
      const favA = favorites.has(a.id) ? 0 : 1;
      const favB = favorites.has(b.id) ? 0 : 1;
      if (favA !== favB) return favA - favB;
      return (a.name || a.id).localeCompare(b.name || b.id);
    });
  }, [entries, query, favorites]);

  const toggleFavorite = (id: string) => {
    hapticSelection();
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeFavorites(next);
      return next;
    });
  };

  return (
    <div className="mobile-sheet-backdrop" onClick={onClose}>
      <div
        className="mobile-sheet"
        role="dialog"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mobile-sheet-title">{title}</h2>
        <div className="mobile-search mobile-sheet-search">
          <IconMagnifyingGlass size={16} aria-hidden />
          <input
            type="search"
            placeholder="Search models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </div>
        <ul className="mobile-sheet-list">
          {error ? <li className="mobile-sheet-error">{error}</li> : null}
          {defaultOption && !query ? (
            <li>
              <button type="button" className="mobile-sheet-item" onClick={() => onSelect("")}>
                <span>
                  <span className="mobile-sheet-item-title">{defaultOption.label}</span>
                  {defaultOption.subtitle ? (
                    <span className="mobile-sheet-item-subtitle">{defaultOption.subtitle}</span>
                  ) : null}
                </span>
                {!selectedId ? <IconCheckmark1Small size={16} aria-hidden /> : null}
              </button>
            </li>
          ) : null}
          {visible.map((entry) => (
            <li key={entry.id} className="mobile-sheet-row">
              <button
                type="button"
                className="mobile-sheet-item"
                onClick={() => onSelect(entry.id)}
              >
                <span>
                  <span className="mobile-sheet-item-title">{entry.name || entry.id}</span>
                  <span className="mobile-sheet-item-subtitle">{entry.subtitle ?? entry.id}</span>
                </span>
                {selectedId === entry.id ? <IconCheckmark1Small size={16} aria-hidden /> : null}
              </button>
              <button
                type="button"
                className="mobile-icon-button mobile-favorite-button"
                data-active={favorites.has(entry.id) ? "true" : undefined}
                aria-label={favorites.has(entry.id) ? "Remove favorite" : "Add favorite"}
                onClick={() => toggleFavorite(entry.id)}
              >
                <IconStar size={16} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
