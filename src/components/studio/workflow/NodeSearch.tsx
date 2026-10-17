// The step search: opened by double-clicking the canvas, by "/", or by
// dropping a connection on empty canvas (then only the steps that fit the
// connection are offered, and the chosen one is wired in).

import { type CSSProperties, useMemo, useRef, useState } from "react";
import { t } from "../../../lib/i18n";
import { useModalFocus } from "../../../lib/modal-focus";
import {
  categoryLabel,
  type LinkFilter,
  hitKey,
  type NodeSearchHit,
  searchNodeTypes,
} from "../../../lib/studio/workflow/node-search";
import { offeredBlocks } from "../../../lib/studio/workflow/library-blocks";

export function NodeSearch({
  at,
  filter,
  onPick,
  onClose,
}: {
  /** Where it opens, in pixels from the canvas's top left corner. */
  at: { x: number; y: number };
  filter?: LinkFilter;
  onPick: (hit: NodeSearchHit) => void;
  onClose: () => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  useModalFocus(surface, { onClose, initialFocusSelector: "input" });
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const hits = useMemo(() => searchNodeTypes(query, filter, offeredBlocks()), [query, filter]);
  const current = Math.min(active, Math.max(hits.length - 1, 0));
  const style = { "--search-x": `${at.x}px`, "--search-y": `${at.y}px` } as CSSProperties;
  return (
    <div
      ref={surface}
      className="studio-node-search nodrag nowheel"
      role="dialog"
      aria-label={t("Add a step")}
      tabIndex={-1}
      style={style}
    >
      <input
        className="studio-input"
        value={query}
        placeholder={filter ? t("Steps that fit this connection") : t("Search steps")}
        aria-label={t("Search steps")}
        aria-controls="studio-node-search-list"
        aria-activedescendant={hits[current] ? `node-search-${hitKey(hits[current])}` : undefined}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, hits.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter" && hits[current]) {
            event.preventDefault();
            onPick(hits[current]);
          }
        }}
      />
      {hits.length === 0 ? (
        <p className="studio-node-search-none">{t("No step matches.")}</p>
      ) : (
        <div id="studio-node-search-list" role="listbox" aria-label={t("Steps")}>
          {hits.map((hit, index) => (
            <div key={hitKey(hit)} role="presentation">
              {/* Grouped while browsing; best first, ungrouped, once typing. */}
              {!query.trim() && (index === 0 || hits[index - 1].category !== hit.category) ? (
                <span className="studio-node-search-group">{categoryLabel(hit.category)}</span>
              ) : null}
              <button
                id={`node-search-${hitKey(hit)}`}
                type="button"
                role="option"
                aria-selected={index === current}
                onPointerEnter={() => setActive(index)}
                onClick={() => onPick(hit)}
              >
                {hit.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
