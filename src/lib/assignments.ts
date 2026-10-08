import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { intlLocale, t } from "./i18n";

/**
 * Assignments and scheduled tasks (ADR-0091): the thin side.
 *
 * The rows, the clock and the runs all live in Rust (`src-tauri/src/
 * assignments/`). This module names the commands, and holds the pure pieces
 * both shells render the same way: what a cadence says, what a run's state
 * says, and which tools a form may offer on this shell.
 */
export const ASSIGNMENTS_EVENT = "june://assignments";

export type AssignmentKind = "assignment" | "task";
export type Cadence = "hourly" | "daily" | "weekdays" | "weekly" | "every";
export type Autonomy = "ask" | "act";
export type RunState = "running" | "needs_review" | "approved" | "rejected" | "done" | "failed";

export type AssignmentRun = {
  id: string;
  assignmentId: string;
  slot: string;
  late: boolean;
  deviceId: string;
  /** `phone` or `computer`. */
  deviceName: string;
  handle: string | null;
  state: RunState;
  result: string | null;
  error: string | null;
  feedback: string | null;
  reviewedAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
};

export type Assignment = {
  id: string;
  kind: AssignmentKind;
  title: string;
  goal: string;
  cadence: Cadence;
  atMinute: number;
  weekday: number;
  everyHours: number;
  autonomy: Autonomy;
  tools: string[];
  deviceId: string;
  deviceName: string;
  originDeviceId: string;
  paused: boolean;
  activeSince: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  runsHere: boolean;
  waitingForConsent: boolean;
  waiting: number;
  lastRun: AssignmentRun | null;
};

export type AssignmentInput = {
  id?: string;
  kind: AssignmentKind;
  title: string;
  goal: string;
  cadence: Cadence;
  atMinute: number;
  weekday: number;
  everyHours: number;
  autonomy: Autonomy;
  tools: string[];
  /** Another of your devices to run it; absent for this one. */
  deviceId?: string;
  deviceName?: string;
};

const asList = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

export const assignmentList = () =>
  invoke<Assignment[]>("assignment_list").then(asList<Assignment>);
export const assignmentSave = (request: AssignmentInput) =>
  invoke<Assignment>("assignment_save", { request });
export const assignmentDelete = (id: string) => invoke<void>("assignment_delete", { id });
export const assignmentSetPaused = (id: string, paused: boolean) =>
  invoke<Assignment>("assignment_set_paused", { id, paused });
export const assignmentRunNow = (id: string) =>
  invoke<{ outcome: "started" | "sent"; deviceName: string }>("assignment_run_now", { id });
export const assignmentRuns = (assignmentId?: string, limit?: number) =>
  invoke<AssignmentRun[]>("assignment_runs", { assignmentId, limit }).then(asList<AssignmentRun>);
export const assignmentInbox = () =>
  invoke<AssignmentRun[]>("assignment_inbox").then(asList<AssignmentRun>);
export const assignmentReview = (runId: string, approve: boolean, feedback?: string) =>
  invoke<AssignmentRun>("assignment_review", { runId, approve, feedback });

export const onAssignmentsChanged = (handler: () => void) => {
  const unlisten = listen(ASSIGNMENTS_EVENT, () => handler());
  return () => {
    void unlisten.then((off) => off());
  };
};

/** The tool groups a form offers. The desktop ones that leave the device
 * or change the machine never run under "ask first" (`acts`), and the phone
 * has none of them. Mirrors `TOOL_GROUPS` in `assignments/prompt.rs`. */
export type ToolChoice = { id: string; label: string; detail: string; acts: boolean };

export function toolChoices(platform: "desktop" | "phone"): ToolChoice[] {
  const shared: ToolChoice[] = [
    { id: "web", label: t("Search the web"), detail: t("Search and read pages."), acts: false },
    {
      id: "notes",
      label: t("Your notes"),
      detail: t("Read your notes and calendar, and write notes."),
      acts: false,
    },
    { id: "memory", label: t("Memory"), detail: t("Recall and remember facts."), acts: false },
  ];
  // The phone's runs use its own connectors (ADR-0092); each tool keeps its
  // allow, ask or deny rule inside a run.
  if (platform === "phone")
    return [
      ...shared,
      {
        id: "connectors",
        label: t("Connectors"),
        detail: t("Use your connected services. Changes still ask first."),
        acts: false,
      },
    ];
  return [
    ...shared,
    { id: "files", label: t("Files"), detail: t("Read and change files, run code."), acts: true },
    {
      id: "terminal",
      label: t("Terminal"),
      detail: t("Run commands on this computer."),
      acts: true,
    },
    { id: "browser", label: t("Browser"), detail: t("Drive a browser on web sites."), acts: true },
  ];
}

/** "07:30" for a minute of the day, in the reader's convention. */
export function formatMinute(minute: number): string {
  const date = new Date(2026, 0, 1, Math.floor(minute / 60), minute % 60);
  return date.toLocaleTimeString(intlLocale(), { hour: "numeric", minute: "2-digit" });
}

/** `HH:MM` from an `<input type="time">` to a minute of the day. */
export function minuteFromTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** The value an `<input type="time">` takes for a minute of the day. */
export function timeFromMinute(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function weekdayName(weekday: number): string {
  // 2026-01-04 is a Sunday, so day 0 lands on Sunday.
  return new Date(2026, 0, 4 + (weekday % 7)).toLocaleDateString(intlLocale(), {
    weekday: "long",
  });
}

/** What the cadence says, in one line. */
export function cadenceLabel(
  assignment: Pick<Assignment, "cadence" | "atMinute" | "weekday" | "everyHours">,
): string {
  const time = formatMinute(assignment.atMinute);
  switch (assignment.cadence) {
    case "hourly":
      return t("Every hour at :{minute}", {
        minute: String(assignment.atMinute % 60).padStart(2, "0"),
      });
    case "daily":
      return t("Every day at {time}", { time });
    case "weekdays":
      return t("Weekdays at {time}", { time });
    case "weekly":
      return t("Every {day} at {time}", { day: weekdayName(assignment.weekday), time });
    case "every":
      return t("Every {hours} hours from {time}", { hours: assignment.everyHours, time });
  }
}

export function runStateLabel(state: RunState): string {
  switch (state) {
    case "running":
      return t("Running");
    case "needs_review":
      return t("To review");
    case "approved":
      return t("Approved");
    case "rejected":
      return t("Rejected");
    case "done":
      return t("Done");
    case "failed":
      return t("Failed");
  }
}

/** Where a run ran, as the reader says it. */
export function runPlaceLabel(run: Pick<AssignmentRun, "deviceName">): string {
  return run.deviceName === "phone" ? t("On your phone") : t("On your computer");
}

/** The reasons the Rust side writes when a run fails, translated. Anything
 * else (a provider's own words) is shown as it came. */
export function runErrorLabel(error: string | null): string {
  if (!error) return "";
  switch (error) {
    case "The run did not start.":
      return t("The run did not start.");
    case "The run did not finish in time.":
      return t("The run did not finish in time.");
    case "The run left no answer.":
      return t("The run left no answer.");
    case "The run did not finish.":
      return t("The run did not finish.");
    case "The chat this run wrote in was deleted.":
      return t("The chat this run wrote in was deleted.");
    case "The assistant is not running on this computer.":
      return t("The assistant is not running on this computer.");
    case "The assistant did not accept the run.":
      return t("The assistant did not accept the run.");
    default:
      return error;
  }
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(intlLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A run's short answer: the "Result" section it was asked to end with, or
 * its first real line. Mirrors `result_summary` in `assignments/prompt.rs`. */
export function resultSummary(answer: string | null): string {
  if (!answer) return "";
  const lines = answer.split("\n").map((line) => line.trim());
  const heading = lines.findIndex(
    (line) =>
      line
        .replace(/^#+/, "")
        .trim()
        .replace(/^\*+|\*+$/g, "")
        .replace(/:$/, "")
        .toLowerCase() === "result",
  );
  const rest = lines.slice(heading + 1);
  const found = rest.find((line) => line && !line.startsWith("#") && !line.startsWith("---"));
  return (found ?? "").replace(/^[-*•]+\s*/, "").replaceAll("**", "");
}

/** A blank form, for a kind. */
export function blankAssignment(kind: AssignmentKind): AssignmentInput {
  return {
    kind,
    title: "",
    goal: "",
    cadence: "daily",
    atMinute: 9 * 60,
    weekday: 1,
    everyHours: 4,
    autonomy: "ask",
    tools: ["web", "notes"],
  };
}

export function inputFrom(assignment: Assignment): AssignmentInput {
  return {
    id: assignment.id,
    kind: assignment.kind,
    title: assignment.title,
    goal: assignment.goal,
    cadence: assignment.cadence,
    atMinute: assignment.atMinute,
    weekday: assignment.weekday,
    everyHours: assignment.everyHours,
    autonomy: assignment.autonomy,
    tools: assignment.tools,
    deviceId: assignment.deviceId || undefined,
    deviceName: assignment.deviceName || undefined,
  };
}
