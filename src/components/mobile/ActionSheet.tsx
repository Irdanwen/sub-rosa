import { useEffect, useRef } from "react";
import { hapticSelection } from "../../lib/haptics";

/**
 * A list of things you can do to one row.
 *
 * The phone had exactly one way to archive or delete a note: swipe it. A swipe
 * is a fine shortcut and a poor only-route -- it has to be discovered, it is
 * awkward one-handed on a long list, and there is nowhere for an action that
 * does not fit two buttons behind a row. Apple ships both, and so does this
 * now: the swipe stays, and a long press opens the same actions with their
 * names on them.
 *
 * The sheet chrome (glass, grabber, entry) is the one the model picker already
 * uses; only the contents differ, so the two read as the same object.
 */

export type SheetAction = {
  label: string;
  /** Destructive actions are red and sit last, as the platform expects. */
  destructive?: boolean;
  onAction: () => void;
};

export function ActionSheet({
  title,
  subtitle,
  actions,
  onClose,
}: {
  title: string;
  subtitle?: string;
  actions: SheetAction[];
  onClose: () => void;
}) {
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="mobile-sheet-backdrop">
      {/* Tapping the dimmed area dismisses, which is the gesture people try
          first. A real button rather than a handler on the backdrop div: it is
          a control, so it should be reachable and announced like one. */}
      <button type="button" className="mobile-sheet-dismiss" aria-label="Close" onClick={onClose} />
      <div
        className="mobile-sheet mobile-action-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <span className="mobile-sheet-grabber" aria-hidden />
        <p className="mobile-sheet-title">{title}</p>
        {subtitle ? <p className="mobile-action-sheet-subtitle">{subtitle}</p> : null}
        <ul className="mobile-sheet-list">
          {actions.map((action, index) => (
            <li key={action.label}>
              <button
                ref={index === 0 ? firstRef : undefined}
                type="button"
                className="mobile-sheet-item mobile-action-sheet-item"
                data-destructive={action.destructive || undefined}
                onClick={() => {
                  hapticSelection();
                  action.onAction();
                  onClose();
                }}
              >
                <span className="mobile-sheet-item-title">{action.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="mobile-action-sheet-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
