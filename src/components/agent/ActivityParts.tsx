import { IconConsole } from "central-icons/IconConsole";
import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { DotSpinner } from "../DotSpinner";
import { Spinner } from "../ui/Spinner";
import type { BackgroundProcess } from "../../lib/hermes-background-processes";

/** The agent timeline's activity affordances, out of AgentWorkspace.tsx. */

export function ActivityIndicator({
  active,
  large = false,
  status = "running",
}: {
  active: boolean;
  large?: boolean;
  status?: "running" | "waitingForUser";
}) {
  if (!active) return null;
  return (
    <span className="agent-activity-indicator" data-large={large} data-status={status}>
      <span aria-hidden="true" />
      {status === "waitingForUser" ? t("Needs you") : t("Working")}
    </span>
  );
}

// Bottom-of-timeline "responding" affordance: a shimmering label, reusing the
// same text-shimmer the recorder uses while transcribing. Lives in the timeline
// (not the header) so it reads like the agent is actively composing the next
// turn.
export function AgentThinking() {
  return (
    <div className="agent-thinking" role="status" aria-live="polite">
      <Spinner aria-hidden />
      <span className="text-shimmer agent-thinking-label">{t("Thinking…")}</span>
    </div>
  );
}

/** How long the current step has been running, for the label beside
 * "Thinking". Seconds while they still mean something, then minutes: the point
 * is to make a six-minute wait look like six minutes. */
export function formatThinkingElapsed(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

/** Rounded, single-unit elapsed time — "12 min", "2 h 40". Long jobs are the
 * point here, so seconds only matter for the first minute. */
export function backgroundElapsedLabel(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Says that work is still running outside the turn. Since v1.27.0 the agent
 * parks long tasks in a background process and ENDS ITS TURN — the gateway
 * wakes it when the process finishes — so a finished turn and an idle composer
 * are the normal look of a job with hours left. Without this the app simply
 * looked dead, and the user re-prompted to find out whether anything was
 * happening.
 */
export function BackgroundWorkNotice({ processes }: { processes: BackgroundProcess[] }) {
  const [now, setNow] = useState(() => Date.now());
  const running = processes.filter((process) => process.status === "running");
  useEffect(() => {
    if (!running.length) return;
    // A minute's resolution is all the label shows; ticking every 15s keeps it
    // honest without a per-second re-render behind the composer.
    const interval = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(interval);
  }, [running.length]);

  if (!running.length) {
    // The process ended and the chained turn has not announced itself yet.
    // Saying so beats going silent in the one gap where the user is most likely
    // to think the agent gave up.
    return (
      <>
        <IconConsole size={14} aria-hidden />
        <span>{t("Background task finished. Sub Rosa is picking it back up.")}</span>
      </>
    );
  }

  const oldest = running.reduce((earliest, process) =>
    Date.parse(process.startedAt) < Date.parse(earliest.startedAt) ? process : earliest,
  );
  const elapsed = backgroundElapsedLabel(oldest.startedAt, now);
  return (
    <>
      <DotSpinner />
      <span>
        {running.length === 1
          ? t("Running in the background")
          : t("{count} tasks running in the background", { count: running.length })}
      </span>
      {running.length === 1 && oldest.label ? (
        <code className="agent-composer-notice-command">{oldest.label}</code>
      ) : null}
      {elapsed ? <span className="agent-composer-notice-elapsed">{elapsed}</span> : null}
    </>
  );
}
