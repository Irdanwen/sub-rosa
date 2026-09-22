import { t } from "../../lib/i18n";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hapticSelection } from "../../lib/haptics";
import { useModalFocus } from "../../lib/modal-focus";
import type { NoteListItemDto } from "../../lib/tauri";
import { sheetHost } from "./sheet-host";

/**
 * Several existing notes, picked into a folder in one go: a folder was a
 * place new notes could be created in, and nothing already written could be
 * brought into it from the phone.
 */
export function NotePickerSheet({
  title,
  notes,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  notes: NoteListItemDto[];
  /** Called with the count; "Add ({count})". */
  confirmLabel: (count: number) => string;
  onConfirm: (noteIds: string[]) => void;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(sheetRef, {
    onClose,
    initialFocusSelector: "[data-initial-focus]",
    lockScroll: true,
  });
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const sorted = useMemo(
    () => [...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [notes],
  );

  const toggle = (id: string) => {
    hapticSelection();
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return createPortal(
    <div className="mobile-sheet-backdrop">
      <button
        type="button"
        className="mobile-sheet-dismiss"
        aria-label={t("Close")}
        onClick={onClose}
      />
      <div
        className="mobile-sheet mobile-folder-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={sheetRef}
        tabIndex={-1}
      >
        <span className="mobile-sheet-grabber" aria-hidden />
        <p className="mobile-sheet-title" data-initial-focus tabIndex={-1}>
          {title}
        </p>
        {sorted.length === 0 ? (
          <p className="mobile-sheet-empty">{t("Every note is already in this folder.")}</p>
        ) : (
          <ul className="mobile-sheet-list">
            {sorted.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  className="mobile-sheet-item"
                  aria-pressed={picked.has(note.id)}
                  onClick={() => toggle(note.id)}
                >
                  <span
                    className="mobile-select-mark"
                    data-selected={picked.has(note.id) || undefined}
                    aria-hidden
                  >
                    {picked.has(note.id) ? <IconCheckmark1Small size={14} /> : null}
                  </span>
                  <span className="mobile-sheet-item-text">
                    <span className="mobile-sheet-item-title">
                      {note.title.trim() || t("New note")}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="mobile-studio-generate mobile-sheet-confirm"
          disabled={picked.size === 0}
          onClick={() => onConfirm([...picked])}
        >
          {confirmLabel(picked.size)}
        </button>
      </div>
    </div>,
    sheetHost(),
  );
}
