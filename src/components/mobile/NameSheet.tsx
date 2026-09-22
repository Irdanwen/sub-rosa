import { t } from "../../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useKeyboardInset } from "../../lib/keyboard-inset";
import { useModalFocus } from "../../lib/modal-focus";
import { sheetHost } from "./sheet-host";

/**
 * One text field and one button, for naming something: a new folder, a
 * renamed folder, a renamed chat. Here the keyboard is the point, so the field
 * takes focus as it appears.
 */
export function NameField({
  label,
  initialValue = "",
  confirmLabel,
  onSubmit,
}: {
  label: string;
  initialValue?: string;
  confirmLabel: string;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const trimmed = value.trim();
  return (
    <form
      className="mobile-name-field"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed) onSubmit(trimmed);
      }}
    >
      <input
        ref={inputRef}
        value={value}
        aria-label={label}
        placeholder={label}
        enterKeyHint="done"
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="mobile-chip-button" disabled={!trimmed}>
        {confirmLabel}
      </button>
    </form>
  );
}

export function NameSheet({
  title,
  label,
  initialValue,
  confirmLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  // The field focuses itself; the hook still owns Tab, Escape and focus return.
  useModalFocus(sheetRef, { onClose, initialFocusSelector: "input", lockScroll: true });
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
        className="mobile-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={sheetRef}
        tabIndex={-1}
      >
        <span className="mobile-sheet-grabber" aria-hidden />
        <p className="mobile-sheet-title">{title}</p>
        <NameField
          label={label}
          initialValue={initialValue}
          confirmLabel={confirmLabel}
          onSubmit={onSubmit}
        />
      </div>
    </div>,
    sheetHost(),
  );
}
