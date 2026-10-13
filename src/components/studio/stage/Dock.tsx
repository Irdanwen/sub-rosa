// The dock: where the instruction is written and sent on a stage. A frosted
// card under the scene, holding the prompt, the quick suggestions, the tools,
// and the one round button that spends, with its price beside it (CONTEXT.md,
// "Dock"). Both shells draw it: on the phone it rides above the keyboard, on
// the desktop it sits centred under the scene.

import { IconArrowUp } from "central-icons/IconArrowUp";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
} from "react";
import { t } from "../../../lib/i18n";
import { useKeyboardInset } from "../../../lib/keyboard-inset";
import { formatCredits } from "../../../lib/studio/catalog";
import { Spinner } from "../../ui/Spinner";

/** Why send cannot be pressed yet, and what to press about it where there is
 * something. */
export interface DockBlocker {
  text: string;
  actions?: { label: string; onAction: () => void }[];
}

/** The frosted card. On the phone it sticks to the bottom of the panel, above
 * the keyboard. */
export function Dock({ children, className }: { children: ReactNode; className?: string }) {
  const keyboardInset = useKeyboardInset();
  return (
    <div
      className={["stage-dock", className].filter(Boolean).join(" ")}
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
  maxLength,
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
  fieldRef,
}: {
  /** The instruction. Leave it out for a tool that takes no words (an
   * upscale): the card then holds only what `children` puts in it. */
  value?: string;
  onChange?: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  maxLength?: number;
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
  /** Anything between the field and the bar: notices, a picked source. */
  children?: ReactNode;
  /** The field, for a caller that inserts at the caret (an audio tag). */
  fieldRef?: RefObject<HTMLTextAreaElement>;
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const field = fieldRef ?? ownRef;
  // The field grows with the instruction, up to a few lines.
  useEffect(() => {
    const element = field.current;
    // Measured whenever the text changes, including when it is cleared.
    if (!element || value === undefined) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [field, value]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend && !busy) onSend();
  };

  return (
    <div className="stage-dock-composer">
      {value !== undefined ? (
        <textarea
          ref={field}
          className="stage-dock-field"
          value={value}
          rows={1}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-label={ariaLabel}
          onChange={(event) => onChange?.(event.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : null}
      {suggestions && suggestions.length > 0 && !value?.trim() ? (
        <fieldset className="stage-dock-suggestions" aria-label={t("Suggestions")}>
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.id}
              type="button"
              className="stage-dock-suggestion"
              title={suggestion.title}
              onClick={() => onSuggestion?.(suggestion.id)}
            >
              {suggestion.label}
            </button>
          ))}
        </fieldset>
      ) : null}
      {children}
      <div className="stage-dock-bar">
        <div className="stage-dock-lead">{tools}</div>
        <div className="stage-dock-send">
          {cost !== undefined && !busy ? (
            <span className="stage-dock-cost">{formatCredits(cost)}</span>
          ) : null}
          <button
            type="button"
            className="stage-send"
            aria-label={sendLabel}
            title={sendLabel}
            aria-busy={busy ? "true" : undefined}
            disabled={!canSend || busy}
            onClick={onSend}
          >
            {busy ? <Spinner /> : <IconArrowUp size={18} aria-hidden />}
          </button>
        </div>
      </div>
      {blocker ? <p className="stage-dock-hint">{blocker.text}</p> : null}
      {blocker?.actions?.length ? (
        <div className="stage-dock-actions">
          {blocker.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="stage-dock-action"
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
