import { type ReactNode, useEffect, useRef } from "react";

/** A native `<dialog>` opened modal, so focus, Escape and the backdrop are
 * the browser's own, as the settings dialog does it. */
export function ModalDialog({
  open,
  labelledBy,
  onClose,
  children,
  wide = false,
}: {
  open: boolean;
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
    if (!open && element.open) {
      if (typeof element.close === "function") element.close();
      else element.removeAttribute("open");
    }
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={`wc-dialog${wide ? " wc-dialog-wide" : ""}`}
      aria-labelledby={labelledBy}
      onClose={onClose}
      onCancel={onClose}
    >
      {open && children}
    </dialog>
  );
}
