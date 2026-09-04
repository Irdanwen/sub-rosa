import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { type ReactNode, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../../lib/modal-focus";

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** Optional element rendered into the header beside the title (e.g. an icon). */
  leading?: ReactNode;
  /** Slot for the form / body content. */
  children: ReactNode;
  /** Slot for buttons; rendered right-aligned by default. */
  footer?: ReactNode;
  /** Disable closing on backdrop click (still closes on Esc). */
  disableBackdropClose?: boolean;
  /** Disables default focus management when the consumer wants to take over. */
  initialFocusSelector?: string;
  /** Optional width override. Defaults to the comfortable 460px form width. */
  width?: number | string;
  /** Optional class hook for unusual dialogs. */
  className?: string;
};

/**
 * Base dialog primitive. Renders into a portal with a blurred backdrop,
 * a centered card, the shared focus and keyboard rules, the substrate we share
 * across folder create / rename / move and any future dialog.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  leading,
  children,
  footer,
  disableBackdropClose = false,
  initialFocusSelector,
  width,
  className,
}: DialogProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Focus in, Tab trapped, Esc closes, focus back, page behind frozen:
  // the shared rules for every modal surface (spec/modal-focus.md).
  useModalFocus(cardRef, { open, onClose, initialFocusSelector, lockScroll: true });

  if (!open) return null;

  return createPortal(
    <div
      className="dialog-backdrop"
      data-open="true"
      onMouseDown={(event) => {
        if (disableBackdropClose) return;
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={`dialog-card${className ? ` ${className}` : ""}`}
        style={width ? { width } : undefined}
      >
        <header className="dialog-header">
          {leading ? <span className="dialog-leading">{leading}</span> : null}
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          <button type="button" className="dialog-close" aria-label="Close" onClick={onClose}>
            <IconCrossMedium size={14} />
          </button>
        </header>
        {description ? (
          <p id={descriptionId} className="dialog-description">
            {description}
          </p>
        ) : null}
        {children}
        {footer ? <footer className="dialog-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

export function DialogField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="dialog-field">
      <label className="dialog-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="dialog-field-hint">{hint}</p> : null}
    </div>
  );
}
