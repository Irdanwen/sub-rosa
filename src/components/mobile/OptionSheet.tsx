import { t } from "../../lib/i18n";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { useRef } from "react";
import { hapticSelection } from "../../lib/haptics";
import { useModalFocus } from "../../lib/modal-focus";

export type SheetOption = { value: string; label: string };

/**
 * The phone's drop-down: a short list of fixed values in a sheet, the current
 * one ticked.
 *
 * Studio laid every such setting out as a row of pills - four durations, eight
 * aspect ratios, two resolutions - so a video form was three rows of chips
 * before the prompt. A setting read as "Duration · 5 s" takes one line and
 * says what is chosen; the choices come up only when they are wanted.
 */
export function OptionSheet({
  title,
  options,
  selected,
  onSelect,
  onClose,
}: {
  title: string;
  options: SheetOption[];
  selected: string;
  onSelect: (value: string) => void;
  onClose: () => void;
}) {
  // Focus lands on the current value, the one a person most often keeps
  // (spec/modal-focus.md).
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(sheetRef, { onClose, initialFocusSelector: '[aria-pressed="true"]' });

  return (
    <div className="mobile-sheet-backdrop">
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
        <ul className="mobile-sheet-list">
          {options.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                className="mobile-sheet-item"
                aria-pressed={option.value === selected}
                onClick={() => {
                  hapticSelection();
                  onSelect(option.value);
                }}
              >
                <span className="mobile-sheet-item-title">{option.label}</span>
                {option.value === selected ? <IconCheckmark1Small size={16} aria-hidden /> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
