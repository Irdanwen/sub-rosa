import { t } from "../../lib/i18n";
import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { useKeyboardInset } from "../../lib/keyboard-inset";
import { useModalFocus } from "../../lib/modal-focus";
import { ImportLinkBar } from "../notes-list/ImportLinkBar";
import { sheetHost } from "./sheet-host";

/**
 * Bringing something in: a file from the phone, or a link to fetch.
 *
 * The link field used to sit on the notes list permanently, a row most people
 * never use, cut off at the right edge on a phone. Both ways in now live
 * behind the import button, and what is downloading stays on the list.
 */
export function ImportSheet({
  onChooseFile,
  onCompleted,
  onClose,
}: {
  onChooseFile: () => void;
  onCompleted: (noteId: string) => void;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(sheetRef, {
    onClose,
    initialFocusSelector: "[data-initial-focus]",
    lockScroll: true,
  });
  const keyboardInset = useKeyboardInset();
  return createPortal(
    <div className="mobile-sheet-backdrop" style={{ bottom: keyboardInset || undefined }}>
      <button
        type="button"
        className="mobile-sheet-dismiss"
        aria-label={t("Close")}
        onClick={onClose}
      />
      <div
        className="mobile-sheet mobile-import-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("Import")}
        ref={sheetRef}
        tabIndex={-1}
      >
        <span className="mobile-sheet-grabber" aria-hidden />
        <p className="mobile-sheet-title" data-initial-focus tabIndex={-1}>
          {t("Import")}
        </p>
        <button type="button" className="mobile-sheet-new" onClick={onChooseFile}>
          <IconArrowInbox size={16} aria-hidden />
          <span>{t("Choose an audio or video file")}</span>
        </button>
        <p className="mobile-import-sheet-or">{t("or paste a link")}</p>
        <ImportLinkBar onCompleted={onCompleted} />
      </div>
    </div>,
    sheetHost(),
  );
}
