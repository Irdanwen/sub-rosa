import { IconBranchSimple } from "central-icons/IconBranchSimple";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconStar } from "central-icons/IconStar";
import { useMemo, useRef, useState } from "react";
import { hapticSelection } from "../../lib/haptics";
import { useKeyboardInset } from "../../lib/keyboard-inset";
import { EASE_OUT_CSS, FLICK_VELOCITY } from "../../lib/motion";

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
  /** When set, each model row gains a branch action that forks the chat onto
   * that model (leaving the original untouched) instead of switching in place.
   * Omitted where forking makes no sense (e.g. Studio), so no button shows. */
  onFork?: (id: string) => void;
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
  onFork,
}: ModelSheetProps) {
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(readFavorites);
  const keyboardInset = useKeyboardInset();

  // Drag-to-dismiss from the grabber/title zone (the list keeps its scroll).
  const [dragY, setDragY] = useState(0);
  const dragStart = useRef<number | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dismissing = useRef(false);
  // Track the finger's velocity so release inherits the throw: a flick
  // dismisses under the distance threshold, and the exit starts at the
  // finger's speed instead of a canned tween.
  const motionState = useRef({ lastY: 0, lastT: 0, vy: 0 });

  /** Animate the sheet off-screen from wherever the finger left it, then close. */
  const dismiss = (fromY: number, vy: number) => {
    if (dismissing.current) return;
    dismissing.current = true;
    const el = sheetRef.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!el || reduceMotion || typeof el.animate !== "function") {
      onClose();
      return;
    }
    const remaining = Math.max(1, el.offsetHeight - fromY);
    // Momentum handoff: the exit takes as long as the throw would need,
    // clamped so a slow release still leaves briskly.
    const duration = Math.min(320, Math.max(140, remaining / Math.max(vy, 0.6)));
    el.style.transition = "none";
    el.animate(
      [
        { transform: `translateY(${fromY}px)` },
        { transform: `translateY(${el.offsetHeight + 12}px)` },
      ],
      { duration, easing: EASE_OUT_CSS, fill: "forwards" },
    );
    backdropRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration,
      easing: "ease",
      fill: "forwards",
    });
    window.setTimeout(onClose, duration);
  };

  const onHandleTouchStart = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    dragStart.current = touch.clientY;
    motionState.current = { lastY: touch.clientY, lastT: event.timeStamp, vy: 0 };
  };
  const onHandleTouchMove = (event: React.TouchEvent) => {
    if (dragStart.current === null) return;
    const touch = event.touches[0];
    const deltaT = event.timeStamp - motionState.current.lastT;
    if (deltaT > 0) {
      motionState.current.vy = (touch.clientY - motionState.current.lastY) / deltaT;
    }
    motionState.current.lastY = touch.clientY;
    motionState.current.lastT = event.timeStamp;
    setDragY(Math.max(0, touch.clientY - dragStart.current));
  };
  const onHandleTouchEnd = () => {
    const { vy } = motionState.current;
    if (dragY > 80 || vy > FLICK_VELOCITY) dismiss(dragY, vy);
    else setDragY(0);
    dragStart.current = null;
  };

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
    <div className="mobile-sheet-backdrop" ref={backdropRef} onClick={() => dismiss(dragY, 0.8)}>
      <div
        className="mobile-sheet"
        ref={sheetRef}
        role="dialog"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        style={{
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: dragStart.current !== null ? "none" : undefined,
          paddingBottom: keyboardInset || undefined,
        }}
      >
        <div
          className="mobile-sheet-handle"
          onTouchStart={onHandleTouchStart}
          onTouchMove={onHandleTouchMove}
          onTouchEnd={onHandleTouchEnd}
          onTouchCancel={onHandleTouchEnd}
        >
          <span className="mobile-sheet-grabber" aria-hidden />
          <h2 className="mobile-sheet-title">{title}</h2>
        </div>
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
              {onFork ? (
                <button
                  type="button"
                  className="mobile-icon-button mobile-fork-button"
                  aria-label={`Fork chat to ${entry.name || entry.id}`}
                  onClick={() => onFork(entry.id)}
                >
                  <IconBranchSimple size={16} />
                </button>
              ) : null}
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
