import "../../styles/chat-controls.css";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconBrain } from "central-icons/IconBrain";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../lib/i18n";
import {
  desktopReasoningEffortFor,
  REASONING_EFFORTS,
  type ReasoningEffort,
  reasoningEffortLabel as effortLabel,
  setDesktopReasoningEffort,
  supportsReasoningEffort,
} from "../../lib/reasoning-effort";
import type { VeniceModelDto } from "../../lib/tauri";

/**
 * The reasoning effort beside the desktop model picker (ADR-0080). Shown only
 * for a model whose catalog entry says it takes an effort. The choice is kept
 * per model on this device; `onChange` lets the workspace hand the new model
 * string to the open chat's runtime.
 */
export function ReasoningEffortControl({
  model,
  onChange,
}: {
  model?: VeniceModelDto;
  onChange: (modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [effort, setEffort] = useState(() =>
    model ? desktopReasoningEffortFor(model.id) : undefined,
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // The composer box clips what overflows it (its rounded surface), so the
  // menu is drawn on the body, anchored above the trigger.
  const [anchor, setAnchor] = useState<CSSProperties>();
  const modelId = model?.id;

  useEffect(() => {
    setEffort(modelId ? desktopReasoningEffortFor(modelId) : undefined);
  }, [modelId]);

  useEffect(() => {
    if (!open) return;
    function close(event: PointerEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  if (!model || !supportsReasoningEffort(model)) return null;
  const current = model;

  function choose(next: ReasoningEffort | undefined) {
    setOpen(false);
    if (next === effort) return;
    setDesktopReasoningEffort(current.id, next);
    setEffort(next);
    onChange(current.id);
  }

  const options: (ReasoningEffort | undefined)[] = [undefined, ...REASONING_EFFORTS];
  return (
    <div
      ref={rootRef}
      className="agent-composer-model agent-reasoning-effort"
      data-open={open || undefined}
    >
      <button
        type="button"
        className="agent-composer-model-trigger"
        aria-label={t("Reasoning effort: {effort}", { effort: effortLabel(effort).toLowerCase() })}
        title={t("How hard the model thinks before it answers")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({
            position: "fixed",
            right: Math.max(0, window.innerWidth - rect.right),
            bottom: window.innerHeight - rect.top + 4,
          });
          setOpen((value) => !value);
        }}
      >
        <IconBrain size={14} aria-hidden />
        <span>{effortLabel(effort)}</span>
        <IconChevronDownSmall size={12} aria-hidden />
      </button>
      {open
        ? createPortal(
            <div ref={menuRef} className="agent-reasoning-effort-menu" role="menu" style={anchor}>
              <p className="agent-reasoning-effort-title">{t("Reasoning effort")}</p>
              {options.map((option) => (
                <button
                  key={option ?? "default"}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option === effort}
                  onClick={() => choose(option)}
                >
                  <span>{effortLabel(option)}</span>
                  {option === effort ? <IconCheckmark1Small size={14} aria-hidden /> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** "Regenerate" on the last reply: asks the same question again, with the
 * pictures its text names. Disabled, with the reason in its tooltip, when it
 * carried one its text does not name, which a rewind cannot send again. */
export function RegenerateAction({
  onRegenerate,
  blocked,
}: {
  onRegenerate: () => void;
  blocked?: boolean;
}) {
  const title = blocked
    ? t("A question with images cannot be asked again. Send it anew.")
    : t("Regenerate reply");
  return (
    <button
      type="button"
      className="agent-turn-action"
      aria-label={t("Regenerate reply")}
      title={title}
      disabled={blocked}
      onClick={onRegenerate}
    >
      <IconArrowRotateClockwise size={13} aria-hidden />
      <span>{t("Regenerate")}</span>
    </button>
  );
}

/**
 * A sent message, edited where it stands. Save sends the new text: the last
 * message is replaced in place, an earlier one in a new branch so the original
 * conversation stays as it was.
 */
export function UserTurnEditor({
  text,
  earlier,
  onSave,
  onCancel,
}: {
  text: string;
  /** Whether this is an earlier message (saving opens a branch). */
  earlier: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, []);
  const unchanged = !draft.trim() || draft.trim() === text.trim();

  return (
    <form
      className="agent-user-turn-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!unchanged) onSave(draft);
      }}
    >
      <textarea
        ref={inputRef}
        aria-label={t("Edit message")}
        value={draft}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !unchanged) {
            event.preventDefault();
            onSave(draft);
          }
        }}
      />
      {earlier ? (
        <p className="agent-user-turn-editor-hint">
          {t("Saving starts a new branch from here. This conversation stays as it is.")}
        </p>
      ) : null}
      <div className="agent-user-turn-editor-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button type="submit" className="btn btn-primary" disabled={unchanged}>
          {t("Save")}
        </button>
      </div>
    </form>
  );
}
