import "../../styles/study-research.css";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconDeepSearch } from "central-icons/IconDeepSearch";
import { IconGlobe } from "central-icons/IconGlobe";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconPlusSmall } from "central-icons/IconPlusSmall";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useCallback, useEffect, useId, useState } from "react";
import { requestOpenNoteFromChat } from "../../lib/chat-blocks-nav";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  approveResearch,
  clampPlanSearches,
  type DocumentFormat,
  deleteResearch,
  estimatedModelCost,
  exportNoteDocument,
  getResearch,
  listResearch,
  onResearchChanged,
  planResearch,
  planSearches,
  RESEARCH_DEPTHS,
  type ResearchDepth,
  type ResearchPlan,
  type ResearchRun,
  type ResearchSource,
  resumeResearch,
  startResearch,
  stopResearch,
} from "../../lib/research";
import { Dialog } from "../ui/Dialog";

const DEPTHS: ResearchDepth[] = ["quick", "standard", "deep"];

function depthLabel(depth: ResearchDepth): string {
  switch (depth) {
    case "quick":
      return t("Quick");
    case "standard":
      return t("Standard");
    default:
      return t("Deep");
  }
}

function phaseLabel(run: ResearchRun): string {
  switch (run.phase) {
    case "searching":
      return t("Searching");
    case "writing":
      return t("Writing the report");
    default:
      return t("Reading sources");
  }
}

function sourcesRead(count: number): string {
  return count === 1 ? t("Read 1 source") : t("Read {count} sources", { count });
}

/**
 * Deep research (ADR-0089), the one surface both shells open from the
 * composer: ask, answer the clarifying questions, edit the plan and see what
 * it costs, then follow the run and stop it, and finally open or export the
 * report, which is a note. The run itself lives in Rust as rows; closing this
 * dialog never stops it, and opening it again finds it in the list.
 */
export function ResearchDialog({
  open,
  onClose,
  initialQuestion = "",
  chatId,
}: {
  open: boolean;
  onClose: () => void;
  initialQuestion?: string;
  chatId?: string | null;
}) {
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [recent, setRecent] = useState<ResearchRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshList = useCallback(() => {
    void listResearch()
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    setRun(null);
    setError(null);
    refreshList();
  }, [open, refreshList]);

  const runId = run?.id;
  useEffect(() => {
    if (!open) return;
    return onResearchChanged((id) => {
      if (id === runId) {
        void getResearch(id)
          .then(setRun)
          .catch(() => undefined);
      } else {
        refreshList();
      }
    });
  }, [open, runId, refreshList]);

  const act = useCallback(async (action: () => Promise<ResearchRun | null>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) setRun(next);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("Deep research")}
      leading={<IconDeepSearch size={18} aria-hidden />}
      className="research-dialog"
    >
      {error ? (
        <p className="study-error" role="alert">
          {error}
        </p>
      ) : null}
      {run === null ? (
        <ResearchStart
          initialQuestion={initialQuestion}
          busy={busy}
          recent={recent}
          onOpen={(id) => void act(() => getResearch(id))}
          onDelete={(id) => void deleteResearch(id).then(refreshList)}
          onStart={(question, depth, useNotes) =>
            void act(() => startResearch({ question, depth, useNotes, chatId }))
          }
        />
      ) : run.status === "clarifying" ? (
        <ResearchClarify
          run={run}
          busy={busy}
          onContinue={(answers) => void act(() => planResearch(run.id, answers))}
        />
      ) : run.status === "planned" && run.plan ? (
        <ResearchPlanEditor
          run={run}
          busy={busy}
          onApprove={(plan, depth) => void act(() => approveResearch(run.id, plan, depth))}
        />
      ) : (
        <ResearchProgress
          run={run}
          busy={busy}
          onStop={() => void act(() => stopResearch(run.id))}
          onResume={(finishNow) => void act(() => resumeResearch(run.id, finishNow))}
          onOpenReport={(noteId) => {
            requestOpenNoteFromChat(noteId);
            onClose();
          }}
          onError={setError}
        />
      )}
      {run !== null ? (
        <footer className="research-footer">
          <button
            type="button"
            className="study-button"
            onClick={() => {
              setRun(null);
              refreshList();
            }}
          >
            {t("All research")}
          </button>
        </footer>
      ) : null}
    </Dialog>
  );
}

function ResearchStart({
  initialQuestion,
  busy,
  recent,
  onOpen,
  onDelete,
  onStart,
}: {
  initialQuestion: string;
  busy: boolean;
  recent: ResearchRun[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onStart: (question: string, depth: ResearchDepth, useNotes: boolean) => void;
}) {
  const [question, setQuestion] = useState(initialQuestion);
  const [depth, setDepth] = useState<ResearchDepth>("standard");
  const [useNotes, setUseNotes] = useState(true);
  const fieldId = useId();
  return (
    <form
      className="research-start"
      onSubmit={(event) => {
        event.preventDefault();
        if (question.trim() && !busy) onStart(question.trim(), depth, useNotes);
      }}
    >
      <label className="dialog-field-label" htmlFor={fieldId}>
        {t("What should be researched?")}
      </label>
      <textarea
        id={fieldId}
        className="study-input research-question"
        rows={3}
        value={question}
        placeholder={t("A question, a topic, a decision to prepare")}
        onChange={(event) => setQuestion(event.target.value)}
      />
      <DepthPicker value={depth} onChange={setDepth} />
      <label className="research-check">
        <input
          type="checkbox"
          checked={useNotes}
          onChange={(event) => setUseNotes(event.target.checked)}
        />
        {t("Also read my notes and the project's files")}
      </label>
      <div className="research-actions">
        <button
          type="submit"
          className="study-button study-button-primary"
          disabled={busy || !question.trim()}
        >
          {busy ? t("Reading your request…") : t("Continue")}
        </button>
      </div>
      {recent.length > 0 ? (
        <section className="research-recent" aria-label={t("Recent research")}>
          <h3 className="research-heading">{t("Recent research")}</h3>
          <ul>
            {recent.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="research-recent-row"
                  onClick={() => onOpen(item.id)}
                >
                  <span className="research-recent-title">{item.plan?.title || item.question}</span>
                  <span className="study-muted">{statusLabel(item)}</span>
                </button>
                <button
                  type="button"
                  className="study-icon-button"
                  aria-label={t("Forget this research")}
                  title={t("Forget this research")}
                  onClick={() => onDelete(item.id)}
                >
                  <IconTrashCan size={14} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </form>
  );
}

function statusLabel(run: ResearchRun): string {
  switch (run.status) {
    case "running":
      return sourcesRead(run.sourcesRead);
    case "done":
      return t("Report ready");
    case "stopped":
      return t("Stopped");
    case "failed":
      return t("Did not finish");
    default:
      return t("Not started");
  }
}

function DepthPicker({
  value,
  onChange,
}: {
  value: ResearchDepth;
  onChange: (depth: ResearchDepth) => void;
}) {
  return (
    <fieldset className="research-depths">
      <legend className="dialog-field-label">{t("Depth")}</legend>
      {DEPTHS.map((depth) => (
        <button
          key={depth}
          type="button"
          className="research-depth"
          aria-pressed={value === depth}
          onClick={() => onChange(depth)}
        >
          <span>{depthLabel(depth)}</span>
          <span className="study-muted">
            {t("Up to {count} sources", { count: RESEARCH_DEPTHS[depth].sources })}
          </span>
        </button>
      ))}
    </fieldset>
  );
}

function ResearchClarify({
  run,
  busy,
  onContinue,
}: {
  run: ResearchRun;
  busy: boolean;
  onContinue: (answers: string[]) => void;
}) {
  const [answers, setAnswers] = useState<string[]>(() => run.clarifyQuestions.map(() => ""));
  const none = run.clarifyQuestions.length === 0;
  // Nothing to clarify: go straight on to the plan.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per run
  useEffect(() => {
    if (none) onContinue([]);
  }, [run.id]);
  if (none) return <p className="study-muted">{t("Drafting the plan…")}</p>;
  return (
    <form
      className="research-clarify"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onContinue(answers);
      }}
    >
      <p>{t("A few questions first, so the research looks in the right place.")}</p>
      {run.clarifyQuestions.map((question, index) => (
        <label key={question} className="research-clarify-question">
          <span>{question}</span>
          <input
            className="study-input"
            value={answers[index] ?? ""}
            onChange={(event) =>
              setAnswers((current) =>
                current.map((answer, i) => (i === index ? event.target.value : answer)),
              )
            }
          />
        </label>
      ))}
      <div className="research-actions">
        <button
          type="button"
          className="study-button"
          disabled={busy}
          onClick={() => onContinue([])}
        >
          {t("Skip")}
        </button>
        <button type="submit" className="study-button study-button-primary" disabled={busy}>
          {busy ? t("Drafting the plan…") : t("Continue")}
        </button>
      </div>
    </form>
  );
}

function ResearchPlanEditor({
  run,
  busy,
  onApprove,
}: {
  run: ResearchRun;
  busy: boolean;
  onApprove: (plan: ResearchPlan, depth: ResearchDepth) => void;
}) {
  const [plan, setPlan] = useState<ResearchPlan>(() => run.plan as ResearchPlan);
  const [depth, setDepth] = useState<ResearchDepth>(run.depth);
  const [cost, setCost] = useState<string | undefined>();
  const limits = RESEARCH_DEPTHS[depth];
  const searches = planSearches(plan);
  const pageReads = limits.sources;
  const modelCalls = pageReads + 1;

  useEffect(() => {
    if (!run.estimate) return;
    // The ceiling scales with the sources a depth reads; the Rust estimate
    // is for the run's own depth.
    const scale = limits.sources / RESEARCH_DEPTHS[run.depth].sources;
    void estimatedModelCost(
      {
        ...run.estimate,
        promptTokens: run.estimate.promptTokens * scale,
        completionTokens: run.estimate.completionTokens * scale,
      },
      run.model,
    ).then(setCost);
  }, [run.estimate, run.model, run.depth, limits.sources]);

  const updateSection = (index: number, patch: Partial<ResearchPlan["sections"][number]>) =>
    setPlan((current) => ({
      ...current,
      sections: current.sections.map((section, i) =>
        i === index ? { ...section, ...patch } : section,
      ),
    }));

  return (
    <form
      className="research-plan"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        const cleaned = clampPlanSearches(
          {
            ...plan,
            sections: plan.sections.map((section) => ({
              ...section,
              queries: section.queries.map((query) => query.trim()).filter(Boolean),
            })),
          },
          depth,
        );
        onApprove(cleaned, depth);
      }}
    >
      <label className="research-clarify-question">
        <span className="dialog-field-label">{t("Report title")}</span>
        <input
          className="study-input"
          value={plan.title}
          onChange={(event) => setPlan((current) => ({ ...current, title: event.target.value }))}
        />
      </label>
      <ol className="research-sections">
        {plan.sections.map((section, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sections are edited in place
          <li key={index} className="research-section">
            <div className="research-section-head">
              <input
                className="study-input"
                aria-label={t("Section title")}
                value={section.title}
                onChange={(event) => updateSection(index, { title: event.target.value })}
              />
              <button
                type="button"
                className="study-icon-button"
                aria-label={t("Remove this section")}
                title={t("Remove this section")}
                disabled={plan.sections.length === 1}
                onClick={() =>
                  setPlan((current) => ({
                    ...current,
                    sections: current.sections.filter((_, i) => i !== index),
                  }))
                }
              >
                <IconCrossSmall size={14} />
              </button>
            </div>
            <textarea
              className="study-input"
              aria-label={t("Searches, one per line")}
              rows={Math.max(2, section.queries.length)}
              value={section.queries.join("\n")}
              onChange={(event) =>
                updateSection(index, { queries: event.target.value.split("\n") })
              }
            />
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="study-button"
        disabled={plan.sections.length >= 8}
        onClick={() =>
          setPlan((current) => ({
            ...current,
            sections: [...current.sections, { title: "", queries: [""] }],
          }))
        }
      >
        <IconPlusSmall size={14} aria-hidden />
        {t("Add a section")}
      </button>
      <DepthPicker value={depth} onChange={setDepth} />
      <div className="research-estimate" role="status">
        <p>
          {t(
            "Up to {sources} sources: {searches} searches, {pages} page reads and {calls} model calls.",
            {
              sources: limits.sources,
              searches: Math.min(searches, limits.searches),
              pages: pageReads,
              calls: modelCalls,
            },
          )}
        </p>
        {searches > limits.searches ? (
          <p className="study-muted">
            {t("This depth runs the first {count} searches of the plan.", {
              count: limits.searches,
            })}
          </p>
        ) : null}
        <p className="study-muted">
          {cost
            ? t("At most about {cost} in model tokens. Searches and page reads are billed apart.", {
                cost,
              })
            : t("Searches and page reads are billed apart from the model tokens.")}
        </p>
      </div>
      <div className="research-actions">
        <button
          type="submit"
          className="study-button study-button-primary"
          disabled={busy || searches === 0}
        >
          {t("Start research")}
        </button>
      </div>
    </form>
  );
}

function SourceRow({ source }: { source: ResearchSource }) {
  let host = "";
  if (source.url) {
    try {
      host = new URL(source.url).hostname.replace(/^www\./, "");
    } catch {
      host = "";
    }
  }
  return (
    <li className="research-source" data-status={source.status}>
      <span className="research-source-icon" aria-hidden>
        {source.kind === "web" ? <IconGlobe size={14} /> : <IconNoteText size={14} />}
      </span>
      <span className="research-source-title">{source.title}</span>
      <span className="study-muted">
        {host ||
          (source.kind === "note"
            ? t("Your note")
            : source.kind === "project_file"
              ? t("Project files")
              : "")}
      </span>
      <span className="research-source-state">
        {source.status === "read" ? (
          <IconCheckmark1Small size={14} aria-label={t("Read")} />
        ) : source.status === "failed" ? (
          <span>{t("Unreadable")}</span>
        ) : source.status === "skipped" ? (
          <span>{t("Not useful")}</span>
        ) : null}
      </span>
    </li>
  );
}

function ResearchProgress({
  run,
  busy,
  onStop,
  onResume,
  onOpenReport,
  onError,
}: {
  run: ResearchRun;
  busy: boolean;
  onStop: () => void;
  onResume: (finishNow: boolean) => void;
  onOpenReport: (noteId: string) => void;
  onError: (message: string | null) => void;
}) {
  const [exporting, setExporting] = useState<DocumentFormat | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const progress = run.maxSources > 0 ? Math.min(1, run.sourcesRead / run.maxSources) : 0;

  const exportAs = async (noteId: string, format: DocumentFormat) => {
    setExporting(format);
    setExported(null);
    onError(null);
    try {
      const result = await exportNoteDocument(noteId, format);
      if (result.path) setExported(t("Saved to {path}", { path: result.path }));
    } catch (err) {
      onError(messageFromError(err));
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="research-progress">
      <h3 className="research-heading">{run.plan?.title || run.question}</h3>
      {run.status === "running" ? (
        <>
          <p role="status">
            {phaseLabel(run)} · {sourcesRead(run.sourcesRead)}
          </p>
          <progress className="research-bar" max={1} value={progress} />
          <p className="study-muted">
            {t("You can close this window. The report will be saved in your notes.")}
          </p>
          <div className="research-actions">
            <button type="button" className="study-button" disabled={busy} onClick={onStop}>
              {t("Stop")}
            </button>
          </div>
        </>
      ) : run.status === "stopped" ? (
        <>
          <p role="status">
            {t("Stopped.")} {sourcesRead(run.sourcesRead)}
          </p>
          <div className="research-actions">
            <button
              type="button"
              className="study-button"
              disabled={busy}
              onClick={() => onResume(false)}
            >
              {t("Resume")}
            </button>
            {run.sourcesRead > 0 ? (
              <button
                type="button"
                className="study-button study-button-primary"
                disabled={busy}
                onClick={() => onResume(true)}
              >
                {t("Write the report now")}
              </button>
            ) : null}
          </div>
        </>
      ) : run.status === "failed" ? (
        <>
          <p role="alert">{run.error ? t(run.error) : t("The research did not finish.")}</p>
          <div className="research-actions">
            <button
              type="button"
              className="study-button study-button-primary"
              disabled={busy}
              onClick={() => onResume(false)}
            >
              {t("Try again")}
            </button>
          </div>
        </>
      ) : run.status === "done" && run.reportNoteId ? (
        <>
          <p role="status">
            {t("The report is in your notes.")}{" "}
            {run.citedSources === 1
              ? t("It cites 1 source.")
              : t("It cites {count} sources.", { count: run.citedSources })}
          </p>
          {run.inventedCitations > 0 ? (
            <p className="study-muted">
              {run.inventedCitations === 1
                ? t("1 citation named no source and was removed.")
                : t("{count} citations named no source and were removed.", {
                    count: run.inventedCitations,
                  })}
            </p>
          ) : null}
          <div className="research-actions">
            <button
              type="button"
              className="study-button study-button-primary"
              onClick={() => onOpenReport(run.reportNoteId as string)}
            >
              {t("Open the report")}
            </button>
          </div>
          <fieldset className="research-export" aria-label={t("Export the report")}>
            <span className="study-muted">{t("Export")}</span>
            {(
              [
                ["markdown", t("Markdown")],
                ["pdf", t("PDF")],
                ["docx", t("Word")],
              ] as [DocumentFormat, string][]
            ).map(([format, label]) => (
              <button
                key={format}
                type="button"
                className="study-button"
                disabled={exporting !== null}
                onClick={() => void exportAs(run.reportNoteId as string, format)}
              >
                {label}
              </button>
            ))}
          </fieldset>
          {exported ? <p className="study-muted">{exported}</p> : null}
        </>
      ) : null}
      {run.sources.length > 0 ? (
        <ul className="research-sources" aria-label={t("Sources")}>
          {run.sources.map((source) => (
            <SourceRow key={source.position} source={source} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
