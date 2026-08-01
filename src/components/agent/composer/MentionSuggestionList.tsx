import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { IconFileText } from "central-icons/IconFileText";
import { IconFolder1 } from "central-icons/IconFolder1";
import { IconNoteText } from "central-icons/IconNoteText";

import type { ComposerMentionItem } from "../../../lib/agent-mentions";

export type MentionSuggestionListProps = {
  items: ComposerMentionItem[];
  command: (item: ComposerMentionItem) => void;
};

export type MentionSuggestionListHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

const ITEM_ICONS = {
  file: IconFileText,
  folder: IconFolder1,
  note: IconNoteText,
} as const;

/** The palette that opens on "@": the documents the agent can already reach —
 * files and folders in the session's working folder, and Sub Rosa notes.
 * Deliberately the same shell, rows, and keyboard model as the "/" palette, so
 * the two feel like one mechanism with two vocabularies. */
export const MentionSuggestionList = forwardRef<
  MentionSuggestionListHandle,
  MentionSuggestionListProps
>(({ items, command }, ref) => {
  const [selected, setSelected] = useState(0);
  const [activeSource, setActiveSource] = useState<"keyboard" | "pointer" | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());

  // A narrowing query can shrink the list under the highlight.
  useEffect(() => {
    setSelected((index) => (index < items.length ? index : 0));
  }, [items.length]);

  useEffect(() => {
    if (activeSource !== "keyboard") return;
    rowRefs.current.get(selected)?.scrollIntoView({ block: "nearest" });
  }, [selected, activeSource]);

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: (event) => {
        if (items.length === 0) return false;
        if (event.key === "ArrowDown") {
          setActiveSource("keyboard");
          setSelected((index) => (index + 1) % items.length);
          return true;
        }
        if (event.key === "ArrowUp") {
          setActiveSource("keyboard");
          setSelected((index) => (index - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = items[selected];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }),
    [items, selected, command],
  );

  if (items.length === 0) {
    return <div className="agent-category-menu agent-category-menu-empty">No matches</div>;
  }

  const files = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.noteId);
  const notes = items.map((item, index) => ({ item, index })).filter(({ item }) => item.noteId);

  return (
    <div className="agent-category-menu-shell" onMouseLeave={() => setActiveSource(null)}>
      <div className="agent-category-menu-scroll-wrap">
        <div
          ref={menuRef}
          className="agent-category-menu"
          role="listbox"
          aria-label="Mention a document"
        >
          {files.length ? (
            <div className="agent-category-menu-section" role="presentation">
              <div className="agent-category-menu-section-label">Files</div>
              {files.map(({ item, index }) => renderRow(item, index))}
            </div>
          ) : null}
          {notes.length ? (
            <div className="agent-category-menu-section" role="presentation">
              <div className="agent-category-menu-section-label">Notes</div>
              {notes.map(({ item, index }) => renderRow(item, index))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );

  function renderRow(item: ComposerMentionItem, index: number) {
    const Icon = ITEM_ICONS[item.kind];
    return (
      <button
        key={`${item.kind}:${item.noteId ?? item.path}`}
        ref={(node) => {
          if (node) rowRefs.current.set(index, node);
          else rowRefs.current.delete(index);
        }}
        type="button"
        role="option"
        aria-selected={index === selected}
        data-active={activeSource && index === selected ? true : undefined}
        data-kind={item.kind}
        // mousedown (not click) so the press commits before the editor's blur
        // tears the popover down.
        onMouseDown={(event) => {
          event.preventDefault();
          command(item);
        }}
        onMouseEnter={() => {
          setSelected(index);
          setActiveSource("pointer");
        }}
      >
        <span className="agent-category-menu-icon">
          <Icon size={16} aria-hidden />
        </span>
        <span className="agent-category-menu-copy">
          <span className="agent-category-menu-label">{item.label}</span>
          {item.detail ? <span className="agent-mention-menu-detail">{item.detail}</span> : null}
        </span>
      </button>
    );
  }
});
MentionSuggestionList.displayName = "MentionSuggestionList";
