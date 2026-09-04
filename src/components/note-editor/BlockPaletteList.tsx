import { t } from "../../lib/i18n";
import type { CentralIconBaseProps } from "central-icons/CentralIconBase";
import type { ComponentType } from "react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export type BlockPaletteItem = {
  id: string;
  /** Sentence case: it is a label, not a heading. */
  label: string;
  /** What the block looks like when written by hand, so the palette teaches
   * the shortcut rather than replacing it. */
  hint: string;
  Icon: ComponentType<CentralIconBaseProps>;
};

export type BlockPaletteListProps = {
  items: BlockPaletteItem[];
  command: (item: BlockPaletteItem) => void;
};

export type BlockPaletteListHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

/**
 * The list behind the note editor's `/` palette.
 *
 * Every entry it offers can also be typed (`## `, `- `, `[] `, `> `), and the
 * hint on the right says so. That is the point: a palette that only ever gets
 * used as a palette has replaced the shortcut, and a note is faster to write
 * when the hands stay on the keys.
 */
export const BlockPaletteList = forwardRef<BlockPaletteListHandle, BlockPaletteListProps>(
  ({ items, command }, ref) => {
    const [selected, setSelected] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    // A changed query rebuilds the list; the old highlight may be past its end.
    useEffect(() => {
      setSelected((current) => (current < items.length ? current : 0));
    }, [items.length]);

    useImperativeHandle(ref, () => ({
      onKeyDown: (event: KeyboardEvent) => {
        if (!items.length) return false;
        if (event.key === "ArrowDown") {
          setSelected((current) => (current + 1) % items.length);
          return true;
        }
        if (event.key === "ArrowUp") {
          setSelected((current) => (current - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          command(items[selected]);
          return true;
        }
        return false;
      },
    }));

    if (!items.length) {
      return <div className="note-block-menu-empty">{t("No matching block")}</div>;
    }

    return (
      <div className="note-block-menu" ref={listRef} role="listbox" aria-label={t("Insert block")}>
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={index === selected}
            data-active={index === selected || undefined}
            onMouseEnter={() => setSelected(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => command(item)}
          >
            <item.Icon size={16} />
            <span className="note-block-menu-label">{item.label}</span>
            <span className="note-block-menu-hint">{item.hint}</span>
          </button>
        ))}
      </div>
    );
  },
);

BlockPaletteList.displayName = "BlockPaletteList";
