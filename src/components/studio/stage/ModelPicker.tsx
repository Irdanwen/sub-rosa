// The model chip and the list it opens, for the desktop dock: search, the
// recommended model first, starred ones next, filter pills where the catalog
// is one long list. The phone draws the same list as a sheet (ModelSheet);
// both read `lib/model-picker.ts`, so they search and order alike.

import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconStar } from "central-icons/IconStar";
import { IconStar as IconStarFilled } from "central-icons-filled/IconStar";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { t } from "../../../lib/i18n";
import {
  type ModelPickerEntry,
  type ModelPickerFilter,
  readModelFavorites,
  visibleModelEntries,
  writeModelFavorites,
} from "../../../lib/model-picker";
import { Popover } from "../../ui/Popover";
import { DockChip } from "./DockChip";

export function ModelPickerChip({
  label,
  entries,
  selectedId,
  onSelect,
  pinnedId,
  filters,
  initialFilter,
  placeholder,
  extra,
}: {
  /** What is being picked ("Image model"), for the chip and the list. */
  label: string;
  entries: ModelPickerEntry[];
  selectedId: string;
  onSelect: (id: string) => void;
  pinnedId?: string;
  filters?: ModelPickerFilter[];
  initialFilter?: string;
  /** The chip's text when nothing is selected. */
  placeholder?: string;
  /** Above the list: a setting of the selected model. */
  extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const selected = entries.find((entry) => entry.id === selectedId);
  return (
    <>
      <DockChip
        ref={anchor}
        label={label}
        value={selected?.name || selected?.id || placeholder || t("Choose")}
        expanded={open}
        onOpen={() => setOpen((current) => !current)}
      />
      <Popover
        anchorRef={anchor}
        open={open}
        onClose={() => setOpen(false)}
        label={label}
        tone="stage"
        width={380}
        initialFocusSelector="input[type='search']"
      >
        {open ? (
          <ModelList
            entries={entries}
            selectedId={selectedId}
            pinnedId={pinnedId}
            filters={filters}
            initialFilter={initialFilter}
            extra={extra}
            onSelect={(id) => {
              onSelect(id);
              setOpen(false);
            }}
          />
        ) : null}
      </Popover>
    </>
  );
}

function ModelList({
  entries,
  selectedId,
  pinnedId,
  filters,
  initialFilter,
  extra,
  onSelect,
}: {
  entries: ModelPickerEntry[];
  selectedId: string;
  pinnedId?: string;
  filters?: ModelPickerFilter[];
  initialFilter?: string;
  extra?: ReactNode;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(() =>
    initialFilter && filters?.some((entry) => entry.id === initialFilter) ? initialFilter : "all",
  );
  const [favorites, setFavorites] = useState<Set<string>>(readModelFavorites);
  const visible = useMemo(
    () => visibleModelEntries(entries, { query, filter, favorites, pinnedId }),
    [entries, query, filter, favorites, pinnedId],
  );
  const toggleFavorite = (id: string) =>
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeModelFavorites(next);
      return next;
    });
  return (
    <div className="stage-model-list">
      <label className="stage-model-search">
        <IconMagnifyingGlass size={16} aria-hidden />
        <input
          type="search"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={query}
          placeholder={t("Search models")}
          aria-label={t("Search models")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && visible[0]) {
              event.preventDefault();
              onSelect(visible[0].id);
            }
          }}
        />
      </label>
      {filters && filters.length > 0 ? (
        <fieldset className="stage-model-filters" aria-label={t("Filter models")}>
          {[{ id: "all", label: t("All") }, ...filters].map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={filter === entry.id}
              className="stage-model-filter"
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </fieldset>
      ) : null}
      {extra}
      <ul className="stage-model-rows">
        {visible.length === 0 ? (
          <li className="stage-model-empty">{t("No model matches this search.")}</li>
        ) : null}
        {visible.map((entry) => (
          <li key={entry.id} className="stage-model-row">
            <button
              type="button"
              className="stage-model-item"
              aria-current={entry.id === selectedId ? "true" : undefined}
              onClick={() => onSelect(entry.id)}
            >
              <span className="stage-menu-check" aria-hidden>
                {entry.id === selectedId ? <IconCheckmark1Small size={16} /> : null}
              </span>
              <span className="stage-model-text">
                <span className="stage-model-name">{entry.name || entry.id}</span>
                {entry.subtitle ? (
                  <span className="stage-model-subtitle">{entry.subtitle}</span>
                ) : null}
                {entry.tags && entry.tags.length > 0 ? (
                  <span className="stage-model-tags">
                    {entry.tags.map((tag) => (
                      <span key={tag.label} className="stage-model-tag" data-tone={tag.tone}>
                        {tag.label}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            </button>
            <button
              type="button"
              className="stage-icon stage-model-star"
              aria-pressed={favorites.has(entry.id)}
              aria-label={favorites.has(entry.id) ? t("Remove favorite") : t("Add favorite")}
              onClick={() => toggleFavorite(entry.id)}
            >
              {favorites.has(entry.id) ? <IconStarFilled size={15} /> : <IconStar size={15} />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
