import "../../styles/assignments.css";
import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { IconPlusSmall } from "central-icons/IconPlusSmall";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  type Assignment,
  type AssignmentInput,
  type AssignmentKind,
  type AssignmentRun,
  assignmentInbox,
  assignmentList,
  blankAssignment,
  cadenceLabel,
  inputFrom,
  onAssignmentsChanged,
} from "../../lib/assignments";
import { type Today, dailyBriefToday } from "../../lib/daily-brief";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { AssignmentDetail } from "./AssignmentDetail";
import { AssignmentEditor } from "./AssignmentEditor";
import { AutostartOffer } from "./AutostartOffer";
import { DailyBrief } from "./DailyBrief";
import { RunReview } from "./RunReview";

type Page =
  | { kind: "today" }
  | { kind: "detail"; id: string }
  | { kind: "edit"; input: AssignmentInput; back: Page };

export type HeaderProps = { title: string; onBack?: () => void; trailing?: ReactNode };

/**
 * Today, on both shells: the daily brief, the results waiting for a verdict,
 * and the assignments and scheduled tasks themselves (ADR-0091). The shell
 * draws the header (a stack header on the phone, a page title on the
 * desktop); everything under it is the same.
 */
export function TodaySurface({
  platform,
  renderHeader,
  onExit,
  onOpenRun,
  backgroundNote,
}: {
  platform: "desktop" | "phone";
  renderHeader: (header: HeaderProps) => ReactNode;
  /** Back from the root page, where the shell has somewhere to go back to. */
  onExit?: () => void;
  /** Opens a run's conversation (the phone's runs are chats). */
  onOpenRun?: (run: AssignmentRun) => void;
  /** What this phone can and cannot do in the background, said plainly. */
  backgroundNote?: string;
}) {
  const [page, setPage] = useState<Page>({ kind: "today" });
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [inbox, setInbox] = useState<AssignmentRun[]>([]);
  const [today, setToday] = useState<Today | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, waiting] = await Promise.all([assignmentList(), assignmentInbox()]);
      setAssignments(list);
      setInbox(waiting);
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }, []);

  useEffect(() => {
    void load();
    void dailyBriefToday()
      .then(setToday)
      .catch(() => setToday(null));
    return onAssignmentsChanged(() => void load());
  }, [load]);

  const titles = new Map(assignments.map((assignment) => [assignment.id, assignment.title]));
  const openAssignment = (id: string) => setPage({ kind: "detail", id });
  const create = (kind: AssignmentKind) =>
    setPage({ kind: "edit", input: blankAssignment(kind), back: { kind: "today" } });

  if (page.kind === "edit") {
    const isTask = page.input.kind === "task";
    return (
      <div className="today-surface">
        {renderHeader({
          title: page.input.id
            ? isTask
              ? t("Edit the task")
              : t("Edit the assignment")
            : isTask
              ? t("New scheduled task")
              : t("New assignment"),
          onBack: () => setPage(page.back),
        })}
        <div className="today-scroll">
          <AssignmentEditor
            initial={page.input}
            platform={platform}
            onCancel={() => setPage(page.back)}
            onSaved={(saved) => {
              void load();
              setPage({ kind: "detail", id: saved.id });
            }}
          />
        </div>
      </div>
    );
  }

  if (page.kind === "detail") {
    const assignment = assignments.find((entry) => entry.id === page.id);
    return (
      <div className="today-surface">
        {renderHeader({
          title: assignment?.title ?? t("Assignment"),
          onBack: () => setPage({ kind: "today" }),
        })}
        <div className="today-scroll">
          {assignment ? (
            <AssignmentDetail
              assignment={assignment}
              platform={platform}
              onOpenRun={onOpenRun}
              onEdit={() => setPage({ kind: "edit", input: inputFrom(assignment), back: page })}
              onDeleted={() => {
                void load();
                setPage({ kind: "today" });
              }}
              onChanged={(changed) =>
                setAssignments((current) =>
                  current.map((entry) => (entry.id === changed.id ? changed : entry)),
                )
              }
            />
          ) : (
            <p className="assignment-meta">{t("That assignment no longer exists.")}</p>
          )}
        </div>
      </div>
    );
  }

  const ofKind = (kind: AssignmentKind) => assignments.filter((entry) => entry.kind === kind);
  const tasks = ofKind("task");
  return (
    <div className="today-surface">
      {renderHeader({ title: t("Today"), onBack: onExit })}
      <div className="today-scroll">
        {error ? (
          <p className="assignment-error" role="alert">
            {error}
          </p>
        ) : null}
        <DailyBrief today={today} onToday={setToday} onOpenAssignment={openAssignment} />

        {inbox.length ? (
          <section className="assignment-section" aria-label={t("Needs your review")}>
            <h2 className="assignment-section-title">{t("Needs your review")}</h2>
            {inbox.map((run) => (
              <RunReview
                key={run.id}
                run={run}
                title={titles.get(run.assignmentId)}
                onOpenRun={onOpenRun}
                onReviewed={() => void load()}
              />
            ))}
          </section>
        ) : null}

        {platform === "desktop" ? <AutostartOffer hasAssignments={assignments.length > 0} /> : null}

        <AssignmentList
          title={t("Assignments")}
          empty={t(
            "An assignment is a goal the assistant works on again and again, on a schedule. You review each result, and your feedback shapes the next run.",
          )}
          items={ofKind("assignment")}
          createLabel={t("New assignment")}
          onCreate={() => create("assignment")}
          onOpen={openAssignment}
        />

        {platform === "phone" || tasks.length ? (
          <AssignmentList
            title={t("Scheduled tasks")}
            empty={t("A scheduled task runs on its own and lets you know when it is done.")}
            items={tasks}
            createLabel={t("New scheduled task")}
            onCreate={() => create("task")}
            onOpen={openAssignment}
          />
        ) : null}

        {backgroundNote ? <p className="assignment-meta">{backgroundNote}</p> : null}
      </div>
    </div>
  );
}

function AssignmentList({
  title,
  empty,
  items,
  createLabel,
  onCreate,
  onOpen,
}: {
  title: string;
  empty: string;
  items: Assignment[];
  createLabel: string;
  onCreate: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="assignment-section" aria-label={title}>
      <div className="assignment-section-head">
        <h2 className="assignment-section-title">{title}</h2>
        <button type="button" className="assignment-button" onClick={onCreate}>
          <IconPlusSmall size={16} aria-hidden />
          {createLabel}
        </button>
      </div>
      {items.length ? (
        <ul className="assignment-list">
          {items.map((item) => (
            <li key={item.id}>
              <button type="button" className="assignment-list-row" onClick={() => onOpen(item.id)}>
                <span className="assignment-list-body">
                  <span className="assignment-list-title">{item.title}</span>
                  <span className="assignment-meta">
                    {item.paused ? t("Paused") : cadenceLabel(item)}
                    {item.runsHere ? "" : ` · ${item.deviceName || t("Your other device")}`}
                  </span>
                </span>
                {item.waiting ? (
                  <span className="assignment-badge">
                    {t("{count} to review", { count: item.waiting })}
                  </span>
                ) : null}
                <IconChevronRightSmall size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="assignment-meta">{empty}</p>
      )}
    </section>
  );
}
