// The note's exports, behind one button: a PDF to send, a Markdown file to
// keep. They were two icons of their own in a header that already carried
// five; what is done once in a note's life does not need a permanent place
// next to what is done every time (reading, asking, sharing).

import { IconArrowDownWall } from "central-icons/IconArrowDownWall";
import { IconMarkdown } from "central-icons/IconMarkdown";
import { useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { Popover } from "../ui/Popover";

export function NoteExportMenu({
  onExportPdf,
  onExportMarkdown,
}: {
  onExportPdf?: () => void;
  onExportMarkdown?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const items = [
    ...(onExportPdf
      ? [{ id: "pdf", label: t("Export as PDF"), icon: <IconArrowDownWall />, run: onExportPdf }]
      : []),
    ...(onExportMarkdown
      ? [
          {
            id: "markdown",
            label: t("Export as Markdown"),
            icon: <IconMarkdown />,
            run: onExportMarkdown,
          },
        ]
      : []),
  ];
  if (items.length === 0) return null;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="note-header-actions ghost-icon-button note-export"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("Export")}
        title={t("Export")}
        onClick={() => setOpen((current) => !current)}
      >
        <IconArrowDownWall aria-hidden="true" />
      </button>
      <Popover
        anchorRef={anchor}
        open={open}
        onClose={() => setOpen(false)}
        label={t("Export")}
        role="menu"
        width={220}
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
                <span className="sidebar-nav-icon" aria-hidden>
                  {item.icon}
                </span>
                <span className="sidebar-nav-label">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}
