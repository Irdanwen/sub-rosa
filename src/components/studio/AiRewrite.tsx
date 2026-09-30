import { IconArrowsRepeat } from "central-icons/IconArrowsRepeat";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconSparkle } from "central-icons/IconSparkle";
import { IconCheckmark1 } from "central-icons-filled/IconCheckmark1";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import {
  type ScenarioIntent,
  type StudioRewriteInput,
  useStudioRewrite,
} from "../../lib/studio/studio-rewrite";
import { DotSpinner } from "../DotSpinner";
import { InlineNotice } from "../ui/InlineNotice";

type Intent = { value: ScenarioIntent; label: string };

/**
 * A Studio text field and its "Improve with AI", in one frame.
 *
 * The field, what is known about it (which model the prompt was written for,
 * whether it went stale) and the action that rewrites it sit together, so the
 * button reads as part of the field it acts on rather than as a stray control
 * under it. When there is more than one way to rewrite (the scenario), the
 * button is split: the main half does the usual thing, the chevron offers the
 * others.
 *
 * The proposal is shown and never applied (ADR-0038): it replaces text the
 * person wrote, so it waits for Accept. Accepting keeps what it replaced until
 * the field changes again, so one tap brings it back.
 */
export function AiRewrite({
  field,
  status,
  value,
  onAccept,
  request,
  intents,
  hint,
  disabled,
  label,
}: {
  /** The text field itself, drawn inside the frame. */
  field: ReactNode;
  /** What the bar says about the field: a badge, a stale warning. */
  status?: ReactNode;
  value: string;
  onAccept: (text: string) => void;
  /** Builds the request from the chosen intent and instruction. `undefined`
   * when there is nothing to work from yet. */
  request: (intent?: ScenarioIntent, instruction?: string) => StudioRewriteInput | undefined;
  /** The ways to rewrite, the first being the usual one. Scenario only. */
  intents?: Intent[];
  /** A sentence under the proposal, about what the proposal is. */
  hint?: string;
  disabled?: boolean;
  /** What the field is, for the proposal's accessible name. */
  label: string;
}) {
  const { run, start, stop, dismiss } = useStudioRewrite();
  const [asking, setAsking] = useState<"custom" | undefined>();
  const [instruction, setInstruction] = useState("");
  const [idea, setIdea] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [last, setLast] = useState<{ intent?: ScenarioIntent; instruction?: string }>({});
  const [previous, setPrevious] = useState<{ before: string; after: string }>();
  const menuWrap = useRef<HTMLDivElement>(null);
  const chevron = useRef<HTMLButtonElement>(null);
  const instructionInput = useRef<HTMLInputElement>(null);
  const running = run?.status === "running";
  const ready = run?.status === "ready" && run.text.trim().length > 0;
  const canUndo = previous !== undefined && previous.after === value;
  const usual = intents?.[0]?.value;
  // An empty scenario has nothing to improve: it starts from a sentence.
  const fromIdea = !value.trim() && intents?.some((intent) => intent.value === "develop");
  const main = fromIdea ? request("develop", idea.trim() || undefined) : request(usual, undefined);
  const custom = request("custom", instruction.trim() || undefined);
  const retry = request(last.intent, last.instruction);
  const blocked = disabled || running;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!menuWrap.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    menuWrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => window.removeEventListener("mousedown", onPointer);
  }, [menuOpen]);

  // Choosing "your own instruction" asks for it right there.
  useEffect(() => {
    if (asking === "custom") instructionInput.current?.focus();
  }, [asking]);

  const begin = (intent: ScenarioIntent | undefined, text: string | undefined) => {
    const input = request(intent, text);
    if (!input) return;
    setLast({ intent, instruction: text });
    start(input);
  };

  const choose = (intent: ScenarioIntent) => {
    setMenuOpen(false);
    if (intent === "custom") {
      setAsking("custom");
      return;
    }
    setAsking(undefined);
    begin(intent, undefined);
  };

  // A popover, not a modal (spec/modal-focus.md's exception): arrows move
  // between the items, Escape closes it and gives focus back to the chevron.
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuWrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      chevron.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  };

  return (
    <div className="ai-rewrite">
      <div className="ai-field" data-disabled={disabled}>
        {field}
        {asking === "custom" && !fromIdea ? (
          <form
            className="ai-field-ask"
            onSubmit={(event) => {
              event.preventDefault();
              begin("custom", instruction.trim());
            }}
          >
            <input
              aria-label={t("Your instruction")}
              placeholder={t("For example: make it darker, set it in winter")}
              value={instruction}
              ref={instructionInput}
              disabled={blocked}
              onChange={(event) => setInstruction(event.target.value)}
            />
            <button
              type="submit"
              className="btn btn-secondary"
              disabled={blocked || !instruction.trim() || !custom}
            >
              {t("Rewrite")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setAsking(undefined)}>
              {t("Cancel")}
            </button>
          </form>
        ) : null}
        <div className="ai-field-bar">
          <div className="ai-field-status">
            {fromIdea ? (
              <input
                className="ai-field-idea"
                aria-label={t("Your idea in one sentence")}
                placeholder={t("Your idea in one sentence")}
                value={idea}
                disabled={blocked}
                onChange={(event) => setIdea(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && idea.trim()) {
                    event.preventDefault();
                    begin("develop", idea.trim());
                  }
                }}
              />
            ) : (
              status
            )}
          </div>
          <div className="ai-field-actions">
            {canUndo ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  onAccept(previous.before);
                  setPrevious(undefined);
                }}
              >
                {t("Undo")}
              </button>
            ) : null}
            <div className="ai-split" ref={menuWrap}>
              <button
                type="button"
                className="btn btn-secondary ai-rewrite-start"
                disabled={blocked || !main}
                onClick={() => (fromIdea ? begin("develop", idea.trim()) : begin(usual, undefined))}
              >
                {running ? <DotSpinner /> : <IconSparkle size={14} aria-hidden />}
                {value.trim() ? t("Improve with AI") : t("Write with AI")}
              </button>
              {intents && intents.length > 1 && !fromIdea ? (
                <button
                  ref={chevron}
                  type="button"
                  className="btn btn-secondary ai-split-more"
                  aria-label={t("Other ways to rewrite")}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  disabled={blocked}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <IconChevronDownSmall size={14} aria-hidden />
                </button>
              ) : null}
              {menuOpen && intents ? (
                <div className="ai-split-menu" role="menu" onKeyDown={onMenuKey}>
                  {intents.map((intent) => (
                    <button
                      key={intent.value}
                      type="button"
                      role="menuitem"
                      disabled={intent.value !== "custom" && !request(intent.value, undefined)}
                      onClick={() => choose(intent.value)}
                    >
                      {intent.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {run ? (
        <section
          className="ai-rewrite-proposal"
          aria-label={t("Proposal for {field}", { field: label })}
        >
          <header>
            <span>{t("Proposal")}</span>
            {running ? <DotSpinner /> : null}
          </header>
          {run.status === "failed" || run.status === "cancelled" ? (
            <InlineNotice
              tone="warning"
              body={run.error ?? t("That rewrite did not go through.")}
            />
          ) : (
            <div className="ai-rewrite-body" aria-live="polite" aria-busy={running}>
              {run.text || <span className="project-muted">{t("Writing")}</span>}
            </div>
          )}
          {hint && ready ? <p className="project-muted">{hint}</p> : null}
          <footer>
            {running ? (
              <button type="button" className="btn btn-ghost" onClick={stop}>
                {t("Stop")}
              </button>
            ) : (
              <>
                {ready ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      setPrevious({ before: value, after: run.text });
                      onAccept(run.text);
                      setAsking(undefined);
                      setIdea("");
                      dismiss();
                    }}
                  >
                    <IconCheckmark1 size={14} aria-hidden />
                    {t("Accept")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={!retry}
                  onClick={() => begin(last.intent, last.instruction)}
                >
                  <IconArrowsRepeat size={14} aria-hidden />
                  {t("Try again")}
                </button>
                <button type="button" className="btn btn-ghost" onClick={dismiss}>
                  {t("Discard")}
                </button>
              </>
            )}
          </footer>
        </section>
      ) : null}
    </div>
  );
}
