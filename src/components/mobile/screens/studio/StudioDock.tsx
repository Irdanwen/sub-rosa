// The dock: where the instruction is written and sent on a stage. A frosted
// card that stays within thumb's reach while the panel scrolls, holding the
// prompt, the quick suggestions, the tools, and the one round button that
// spends, with its price beside it (CONTEXT.md, "Dock").

import { IconArrowUp } from "central-icons/IconArrowUp";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { t } from "../../../../lib/i18n";
import { useKeyboardInset } from "../../../../lib/keyboard-inset";
import { formatCredits } from "../../../../lib/studio/catalog";
import { Spinner } from "../../../ui/Spinner";

/** Why send cannot be pressed yet, and what to tap about it where there is
 * something. */
export interface DockBlocker {
  text: string;
  actions?: { label: string; onAction: () => void }[];
}

/** The frosted card. Sticky to the bottom of the panel, above the keyboard. */
export function Dock({ children, className }: { children: ReactNode; className?: string }) {
  const keyboardInset = useKeyboardInset();
  return (
    <div
      className={["mobile-studio-dock", className].filter(Boolean).join(" ")}
      style={{ "--keyboard-inset": `${keyboardInset}px` } as CSSProperties}
    >
      {children}
    </div>
  );
}

export function DockComposer({
  value,
  onChange,
  placeholder,
  ariaLabel,
  suggestions,
  onSuggestion,
  tools,
  cost,
  canSend,
  busy,
  onSend,
  sendLabel,
  blocker,
  children,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
  /** Short openings offered while the field is empty. */
  suggestions?: { id: string; label: string; title?: string }[];
  onSuggestion?: (id: string) => void;
  /** Controls at the bar's left: a model chip, a toggle, a mic. */
  tools?: ReactNode;
  /** The credits this will spend, when known. */
  cost?: number;
  canSend: boolean;
  busy?: boolean;
  onSend: () => void;
  /** The send button's accessible name ("Generate"). */
  sendLabel: string;
  blocker?: DockBlocker;
  /** Anything between the field and the bar: notices, a consent switch. */
  children?: ReactNode;
}) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // The field grows with the instruction, up to a few lines.
  useEffect(() => {
    const field = fieldRef.current;
    // Measured whenever the text changes, including when it is cleared.
    if (!field || value === undefined) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [value]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend && !busy) onSend();
  };

  return (
    <div className="mobile-studio-dock-composer">
      <textarea
        ref={fieldRef}
        className="mobile-studio-dock-field"
        value={value}
        rows={1}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {suggestions && suggestions.length > 0 && !value.trim() ? (
        <fieldset className="mobile-studio-dock-suggestions" aria-label={t("Suggestions")}>
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.id}
              type="button"
              className="mobile-studio-dock-suggestion"
              title={suggestion.title}
              onClick={() => onSuggestion?.(suggestion.id)}
            >
              {suggestion.label}
            </button>
          ))}
        </fieldset>
      ) : null}
      {children}
      <div className="mobile-studio-dock-bar">
        <div className="mobile-studio-dock-lead">{tools}</div>
        <div className="mobile-studio-dock-send">
          {cost !== undefined && !busy ? (
            <span className="mobile-studio-dock-cost">{formatCredits(cost)}</span>
          ) : null}
          <button
            type="button"
            className="stage-send mobile-studio-send"
            aria-label={sendLabel}
            aria-busy={busy ? "true" : undefined}
            disabled={!canSend || busy}
            onClick={onSend}
          >
            {busy ? <Spinner /> : <IconArrowUp size={18} aria-hidden />}
          </button>
        </div>
      </div>
      {blocker ? <p className="mobile-studio-dock-hint">{blocker.text}</p> : null}
      {blocker?.actions?.length ? (
        <div className="mobile-studio-dock-actions">
          {blocker.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="mobile-chip-button"
              onClick={action.onAction}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
