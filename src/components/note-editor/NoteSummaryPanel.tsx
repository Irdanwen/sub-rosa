import { t } from "../../lib/i18n";
import { IconClipboard } from "central-icons/IconClipboard";
import { IconRotate } from "central-icons/IconRotate";
import { IconBookSimple } from "central-icons/IconBookSimple";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DotSpinner } from "../DotSpinner";
import { messageFromError } from "../../lib/errors";
import { parseChapters } from "../../lib/chapters";
import { SimpleMarkdown } from "../../lib/simple-markdown";
import {
  forgetNoteSummary,
  noteSummary as fetchNoteSummary,
  noteSummaryPlan as fetchNoteSummaryPlan,
  NOTE_SUMMARY_EVENT,
  type NoteSummaryDto,
  type NoteSummaryPlan,
  summarizeNoteLongform,
} from "../../lib/tauri";

/**
 * The long-form reading of a recording (ADR-0027): a short paragraph, then a
 * detailed account with timestamped chapters.
 *
 * Deliberately not automatic. A two-hour talk is a dozen model calls, and the
 * user is paying for them, so the run is asked for and the cost is stated
 * before it starts. Once started, the row is the source of truth and this
 * panel only listens: no polling, so a locked phone or a closed window costs
 * nothing (ADR-0018).
 */
export function NoteSummaryPanel({
  noteId,
  onJumpToTime,
}: {
  noteId: string;
  /** Jump the transcript to this point in the recording. Absent when there is
   * nothing to jump to, in which case chapters stay readable but inert. */
  onJumpToTime?: (startMs: number) => void;
}) {
  const [summary, setSummary] = useState<NoteSummaryDto | null>(null);
  const [plan, setPlan] = useState<NoteSummaryPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingForget, setConfirmingForget] = useState(false);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [current, nextPlan] = await Promise.all([
        fetchNoteSummary(noteId),
        fetchNoteSummaryPlan(noteId),
      ]);
      setSummary(current);
      setPlan(nextPlan);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setLoading(false);
    }
  }, [noteId]);

  useEffect(() => {
    setLoading(true);
    setSummary(null);
    setError(null);
    setConfirmingForget(false);
    void reload();
  }, [reload]);

  // The run reports through the row, so the panel survives being unmounted,
  // backgrounded, or reopened on another screen mid-run.
  useEffect(() => {
    const unlisten = listen<NoteSummaryDto>(NOTE_SUMMARY_EVENT, (event) => {
      if (event.payload.noteId !== noteId) return;
      setSummary(event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [noteId]);

  const start = useCallback(async () => {
    setError(null);
    try {
      setSummary(await summarizeNoteLongform(noteId));
    } catch (err) {
      setError(messageFromError(err));
    }
  }, [noteId]);

  const forget = useCallback(async () => {
    setConfirmingForget(false);
    try {
      await forgetNoteSummary(noteId);
      setSummary(null);
    } catch (err) {
      setError(messageFromError(err));
    }
  }, [noteId]);

  /** The whole reading, as markdown, timestamps and all. A summary that cannot
   * leave the app is half a feature. */
  const copySummary = useCallback(async (current: NoteSummaryDto) => {
    const text = [current.shortSummary, current.detailedSummary]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join("\n\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be refused; staying silent beats an alarm.
    }
  }, []);

  if (loading) {
    return (
      <div className="note-summary-panel" aria-busy>
        <DotSpinner />
      </div>
    );
  }

  const running = summary?.status === "pending" || summary?.status === "running";
  const ready = summary?.status === "ready" && Boolean(summary.detailedSummary);

  return (
    <div className="note-summary-panel">
      {error ? (
        <p className="note-summary-error" role="alert">
          {error}
        </p>
      ) : null}

      {summary?.status === "failed" && summary.lastError ? (
        <p className="note-summary-error" role="alert">
          {summary.lastError}
        </p>
      ) : null}

      {running ? (
        <div className="note-summary-progress-row">
          <SummaryProgress summary={summary} />
          <button type="button" className="primary-action" onClick={() => void forget()}>
            {t("Stop")}
          </button>
        </div>
      ) : null}

      {/* The provisional paragraph arrives after the first pass, so a long run
          is worth something within seconds rather than only at the end. */}
      {summary?.shortSummary ? <p className="note-summary-short">{summary.shortSummary}</p> : null}

      {ready && summary.detailedSummary ? (
        <>
          <ChapterList markdown={summary.detailedSummary} onJumpToTime={onJumpToTime} />
          <div className="note-summary-detailed">
            <SimpleMarkdown text={summary.detailedSummary} />
          </div>
        </>
      ) : null}

      {!running && !ready ? <SummaryInvitation plan={plan} onStart={start} /> : null}

      {ready ? (
        <div className="note-summary-footer">
          <button
            type="button"
            className="primary-action"
            onClick={() => void copySummary(summary)}
          >
            <IconClipboard size={13} />
            {copied ? t("Copied") : t("Copy")}
          </button>
          <button type="button" className="primary-action" onClick={() => void start()}>
            <IconRotate size={13} />
            {t("Read it again")}
          </button>
          {confirmingForget ? (
            <>
              <span className="note-summary-confirm">{t("Delete this summary?")}</span>
              <button type="button" className="primary-action" onClick={() => void forget()}>
                {t("Delete")}
              </button>
              <button
                type="button"
                className="primary-action"
                onClick={() => setConfirmingForget(false)}
              >
                {t("Keep")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="primary-action"
              onClick={() => setConfirmingForget(true)}
            >
              <IconTrashCan size={13} />
              {t("Delete")}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The chapters, read back out of the summary's own headings.
 *
 * They are a way into the transcript, not a media player: ADR-0026 is explicit
 * that nothing here plays audio. Jumping to the transcript is what a reader
 * actually wants anyway — the transcript is the thing you read.
 */
function ChapterList({
  markdown,
  onJumpToTime,
}: {
  markdown: string;
  onJumpToTime?: (startMs: number) => void;
}) {
  const chapters = useMemo(() => parseChapters(markdown), [markdown]);
  if (chapters.length < 2) return null;
  return (
    <nav className="note-chapters" aria-label={t("Chapters")}>
      {chapters.map((chapter) => (
        <button
          key={`${chapter.startMs}-${chapter.title}`}
          type="button"
          className="note-chapter"
          data-level={chapter.level}
          disabled={!onJumpToTime}
          onClick={() => onJumpToTime?.(chapter.startMs)}
        >
          <span className="note-chapter-time">{chapter.label}</span>
          <span className="note-chapter-title">{chapter.title}</span>
        </button>
      ))}
    </nav>
  );
}

function SummaryProgress({ summary }: { summary: NoteSummaryDto }) {
  const total = Math.max(summary.chunkCount, 1);
  const done = Math.min(summary.chunksDone, total);
  // Every part is read but the row is still running: the merge and the closing
  // paragraph are the last two calls, and they are not quick on a long
  // recording. Saying so beats a progress line frozen at "part 12 of 12".
  const merging = done >= total;
  return (
    <div className="note-summary-progress" role="status" aria-live="polite">
      <DotSpinner className="note-summary-spinner" />
      <span>
        {merging
          ? t("Putting it together")
          : total > 1
            ? t("Reading part {part} of {total}", { part: done + 1, total })
            : t("Reading the recording")}
      </span>
    </div>
  );
}

function SummaryInvitation({
  plan,
  onStart,
}: {
  plan: NoteSummaryPlan | null;
  onStart: () => void | Promise<void>;
}) {
  if (plan && !plan.summarizable) {
    return (
      <div className="note-summary-empty">
        <IconBookSimple size={22} />
        <p>{plan.reason ?? t("This recording cannot be summarized.")}</p>
      </div>
    );
  }
  return (
    <div className="note-summary-empty">
      <IconBookSimple size={22} />
      <h2>{t("Read this recording end to end")}</h2>
      <p>
        {t(
          "A faithful account of everything that was said, with chapters you can jump to. Different from the note above, which keeps only what a meeting needs.",
        )}
      </p>
      {plan ? (
        <p className="note-summary-cost">
          {plan.chunkCount > 1
            ? t("About {duration} of speech, read in {parts} passes ({calls} model calls).", {
                duration: formatMinutes(plan.transcriptChars),
                parts: plan.chunkCount,
                calls: plan.modelCalls,
              })
            : t("About {duration} of speech ({calls} model calls).", {
                duration: formatMinutes(plan.transcriptChars),
                calls: plan.modelCalls,
              })}
        </p>
      ) : null}
      <button type="button" className="primary-action primary-solid" onClick={() => void onStart()}>
        <IconBookSimple size={13} />
        {t("Summarize")}
      </button>
    </div>
  );
}

/** Speech runs at roughly 900 characters a minute, which is close enough to
 * turn a character count into something a person can picture. */
function formatMinutes(chars: number): string {
  const minutes = Math.max(Math.round(chars / 900), 1);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
