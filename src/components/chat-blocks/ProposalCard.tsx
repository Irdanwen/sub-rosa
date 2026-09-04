import { intlLocale, t } from "../../lib/i18n";
import { IconBookSimple } from "central-icons/IconBookSimple";
import { IconChainLink1 } from "central-icons/IconChainLink1";
import { IconBell } from "central-icons/IconBell";
import { IconCalendar1 } from "central-icons/IconCalendar1";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconNoteText } from "central-icons/IconNoteText";
import { useEffect, useState } from "react";
import type { ProposalChatBlock, ProposedAction } from "../../lib/chat-blocks";
import { actionExecute, actionStates } from "../../lib/tauri";
import { DotSpinner } from "../DotSpinner";

/**
 * What the assistant offers to do, and the one gesture that does it.
 *
 * The card reads its own history on mount: a message is immutable, so "done"
 * cannot live in the text that proposed it, or reopening the conversation
 * tomorrow would offer to create the same reminder again. The durable rows
 * behind `actionStates` are the truth (crate::actions); this is only how it
 * was asked.
 */
export function ProposalCard({ block }: { block: ProposalChatBlock }) {
  const [done, setDone] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    actionStates(block.proposalId)
      .then((states) => {
        if (cancelled) return;
        setDone(
          Object.fromEntries(
            states
              .filter((state) => state.status === "done")
              .map((state) => [state.actionId, state.detail ?? "Done"]),
          ),
        );
      })
      .catch(() => {
        // No history is the same as nothing done yet: offer the buttons.
      });
    return () => {
      cancelled = true;
    };
  }, [block.proposalId]);

  const run = async (action: ProposedAction) => {
    if (busy || done[action.id]) return;
    setBusy(action.id);
    setFailed((current) => {
      const next = { ...current };
      delete next[action.id];
      return next;
    });
    try {
      const state = await actionExecute(block.proposalId, action);
      setDone((current) => ({ ...current, [action.id]: state.detail ?? "Done" }));
    } catch (error) {
      // Nothing happened, so the button stays — with the reason next to it.
      setFailed((current) => ({
        ...current,
        [action.id]: error instanceof Error ? error.message : "That could not be done just now.",
      }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="chat-block" aria-label={block.title || "Suggested follow-ups"}>
      <h4 className="chat-block-title">{block.title || "Suggested follow-ups"}</h4>
      <ul className="chat-block-rows">
        {block.actions.map((action) => {
          const detail = done[action.id];
          const error = failed[action.id];
          return (
            <li key={action.id}>
              <div className="chat-block-row proposal-row" data-done={detail ? "true" : undefined}>
                <span className="chat-block-row-icon" aria-hidden>
                  <ActionIcon kind={action.kind} />
                </span>
                <span className="chat-block-row-body">
                  <span className="chat-block-row-title">{action.label}</span>
                  <span className="chat-block-row-meta">
                    {detail ?? error ?? actionHint(action)}
                  </span>
                </span>
                {detail ? (
                  <span className="proposal-done" aria-label={t("Done")}>
                    <IconCheckmark1Small size={14} />
                  </span>
                ) : (
                  <button
                    type="button"
                    className="proposal-do"
                    disabled={busy !== null}
                    onClick={() => void run(action)}
                  >
                    {busy === action.id ? <DotSpinner /> : "Add"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ActionIcon({ kind }: { kind: ProposedAction["kind"] }) {
  if (kind === "reminder") return <IconBell size={16} />;
  if (kind === "event") return <IconCalendar1 size={16} />;
  if (kind === "summarize") return <IconBookSimple size={16} />;
  if (kind === "importLink") return <IconChainLink1 size={16} />;
  return <IconNoteText size={16} />;
}

/** What tapping will do, said before it is done. */
function actionHint(action: ProposedAction): string {
  switch (action.kind) {
    case "reminder":
      return action.due
        ? `Reminder · ${new Date(action.due).toLocaleString(intlLocale(), {
            dateStyle: "medium",
            timeStyle: "short",
          })}`
        : "Reminder";
    case "event":
      return `Calendar · ${new Date(action.start).toLocaleString(intlLocale(), {
        dateStyle: "medium",
        timeStyle: "short",
      })}`;
    case "summarize":
      // These two take minutes and cost model calls, so the hint says what it
      // starts rather than what it produces.
      return "Reads the whole recording · takes a few minutes";
    case "importLink":
      return `Fetches ${hostOf(action.url)} · takes a few minutes`;
    default:
      return "Adds a line to your note";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the link";
  }
}
