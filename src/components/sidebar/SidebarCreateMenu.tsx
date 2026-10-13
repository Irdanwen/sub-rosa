import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconImport } from "central-icons/IconImport";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconSparkle3 } from "central-icons/IconSparkle3";
import { useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { isMacLikePlatform } from "../../lib/platform";
import { Popover } from "../ui/Popover";

/**
 * What else can be started from the top of the sidebar: a note, an import,
 * an image, a video. The chat stays the one-press default (⌘N); the rest is
 * one press further, under the chevron beside it.
 */
export function SidebarCreateMenu({
  onCreateNote,
  onImportMedia,
  onOpenStudio,
}: {
  onCreateNote?: () => void;
  onImportMedia?: () => void;
  onOpenStudio: (tab: "image" | "video") => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const items = [
    ...(onCreateNote
      ? [
          {
            id: "note",
            label: t("New note"),
            hint: isMacLikePlatform() ? "⇧⌘N" : "Ctrl+Shift+N",
            icon: <IconNoteText size={15} />,
            run: onCreateNote,
          },
        ]
      : []),
    ...(onImportMedia
      ? [
          {
            id: "import",
            label: t("Import audio or video"),
            hint: undefined,
            icon: <IconImport size={15} />,
            run: onImportMedia,
          },
        ]
      : []),
    {
      id: "image",
      label: t("New image"),
      hint: undefined,
      icon: <IconSparkle3 size={15} />,
      run: () => onOpenStudio("image"),
    },
    {
      id: "video",
      label: t("New video"),
      hint: undefined,
      icon: <IconSparkle3 size={15} />,
      run: () => onOpenStudio("video"),
    },
  ];
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="sidebar-new-more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("Create something else")}
        title={t("Create something else")}
        onClick={() => setOpen((current) => !current)}
      >
        <IconChevronDownSmall size={14} aria-hidden />
      </button>
      <Popover
        anchorRef={anchor}
        open={open}
        onClose={() => setOpen(false)}
        label={t("Create")}
        role="menu"
        width={300}
      >
        <ul className="sidebar-create-menu">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                role="menuitem"
                className="sidebar-create-item"
                onClick={() => {
                  setOpen(false);
                  item.run();
                }}
              >
                <span className="sidebar-nav-icon">{item.icon}</span>
                <span className="sidebar-nav-label">{item.label}</span>
                {item.hint ? <kbd className="sidebar-nav-shortcut">{item.hint}</kbd> : null}
              </button>
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}
