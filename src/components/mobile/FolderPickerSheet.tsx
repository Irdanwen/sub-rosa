import { t } from "../../lib/i18n";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconPlusSmall } from "central-icons/IconPlusSmall";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hapticSelection } from "../../lib/haptics";
import { useKeyboardInset } from "../../lib/keyboard-inset";
import { useModalFocus } from "../../lib/modal-focus";
import type { FolderDto } from "../../lib/tauri";
import { NameField } from "./NameSheet";
import { sheetHost } from "./sheet-host";

/**
 * Where a note goes: one folder, or none, or a new one named on the spot.
 *
 * The phone could file a note only from a 280px popover pinned after the date,
 * which ran off the screen, and nothing on the list could move a note at all.
 * This is the one picker every route opens: the note's own menu, its folder
 * chip, a long press in the list, and a selection of several notes.
 */
export function FolderPickerSheet({
  title,
  folders,
  currentFolderId,
  onPick,
  onCreate,
  onClose,
}: {
  title: string;
  /** Only the folders a note can be moved to (not the Archive, a state). */
  folders: FolderDto[];
  /** The folder ticked: a folder id, `null` for "no folder", or `undefined`
   * when the notes being moved come from different places and nothing is. */
  currentFolderId?: string | null;
  /** `undefined` takes the note out of every folder. */
  onPick: (folderId: string | undefined) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  // Focus on the title: a list of folders should not raise the keyboard.
  useModalFocus(sheetRef, {
    onClose,
    initialFocusSelector: "[data-initial-focus]",
    lockScroll: true,
  });
  const keyboardInset = useKeyboardInset();
  const [creating, setCreating] = useState(false);

  const pick = (folderId: string | undefined) => {
    hapticSelection();
    onPick(folderId);
  };

  return createPortal(
    <div className="mobile-sheet-backdrop" style={{ bottom: keyboardInset || undefined }}>
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
        <ul className="mobile-sheet-list">
          <li>
            <button
              type="button"
              className="mobile-sheet-item"
              aria-pressed={currentFolderId === null}
              onClick={() => pick(undefined)}
            >
              <span className="mobile-sheet-check" aria-hidden>
                {currentFolderId === null ? <IconCheckmark1Small size={16} /> : null}
              </span>
              <span className="mobile-sheet-item-text">
                <span className="mobile-sheet-item-title">{t("No folder")}</span>
              </span>
            </button>
          </li>
          {folders.map((folder) => (
            <li key={folder.id}>
              <button
                type="button"
                className="mobile-sheet-item"
                aria-pressed={folder.id === currentFolderId}
                onClick={() => pick(folder.id)}
              >
                <span className="mobile-sheet-check" aria-hidden>
                  {folder.id === currentFolderId ? <IconCheckmark1Small size={16} /> : null}
                </span>
                <span className="mobile-sheet-item-text">
                  <span className="mobile-sheet-item-title">{folder.name}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {creating ? (
          <NameField label={t("Folder name")} confirmLabel={t("Create")} onSubmit={onCreate} />
        ) : (
          <button
            type="button"
            className="mobile-sheet-new"
            onClick={() => {
              hapticSelection();
              setCreating(true);
            }}
          >
            <IconPlusSmall size={16} aria-hidden />
            <span>{t("New folder")}</span>
          </button>
        )}
      </div>
    </div>,
    sheetHost(),
  );
}
