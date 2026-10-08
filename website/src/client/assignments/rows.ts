/**
 * The two travelling tables (`assignments`, `assignment_runs`), read from and
 * written to the encrypted journal as the app's own rows, so a browser's
 * assignment or run is an ordinary one on every device.
 */
import { type Row, timestamp } from "../codec";
import type { SyncClient } from "../sync";
import { type Autonomy, parseAutonomy, resultSummary, type Reviewed } from "./prompt";
import { type Cadence, parseCadence, type Schedule } from "./schedule";
import { ASSIGNMENTS } from "./words";

export interface Assignment {
  id: string;
  /** `assignment` (its results are reviewed) or `task` (a scheduled task). */
  kind: "assignment" | "task";
  title: string;
  goal: string;
  cadence: string;
  atMinute: number;
  weekday: number;
  everyHours: number;
  autonomy: Autonomy;
  tools: string[];
  /** The device that runs it. */
  deviceId: string;
  deviceName: string;
  originDeviceId: string;
  paused: boolean;
  activeSince: string;
  createdAt: string;
  updatedAt: string;
}

export type RunState = "running" | "needs_review" | "done" | "failed" | "approved" | "rejected";

export interface Run {
  id: string;
  assignmentId: string;
  slot: string;
  late: boolean;
  deviceId: string;
  /** `phone`, `computer` or `browser`: where it ran. */
  deviceName: string;
  /** The run's chat. */
  handle: string | null;
  state: RunState;
  result: string | null;
  error: string | null;
  feedback: string | null;
  reviewedAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const optional = (value: unknown) => (typeof value === "string" ? value : null);
const integer = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;

function tools(raw: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(text(raw) || "[]");
    return Array.isArray(parsed) ? parsed.filter((tool) => typeof tool === "string") : [];
  } catch {
    return [];
  }
}

export function assignmentOf(id: string, row: Row): Assignment {
  return {
    id,
    kind: row.kind === "task" ? "task" : "assignment",
    title: text(row.title),
    goal: text(row.goal),
    cadence: text(row.cadence),
    atMinute: integer(row.at_minute, 9 * 60),
    weekday: integer(row.weekday, 1),
    everyHours: integer(row.every_hours, 4),
    autonomy: parseAutonomy(text(row.autonomy)),
    tools: tools(row.tools),
    deviceId: text(row.device_id),
    deviceName: text(row.device_name),
    originDeviceId: text(row.origin_device_id),
    paused: integer(row.paused, 0) !== 0,
    activeSince: text(row.active_since),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function runOf(id: string, row: Row): Run {
  return {
    id,
    assignmentId: text(row.assignment_id),
    slot: text(row.slot),
    late: integer(row.late, 0) !== 0,
    deviceId: text(row.device_id),
    deviceName: text(row.device_name),
    handle: optional(row.handle),
    state: (text(row.state) || "running") as RunState,
    result: optional(row.result),
    error: optional(row.error),
    feedback: optional(row.feedback),
    reviewedAt: optional(row.reviewed_at),
    startedAt: text(row.started_at),
    finishedAt: optional(row.finished_at),
    updatedAt: text(row.updated_at),
  };
}

/** `AssignmentRow::schedule`. */
export function scheduleOf(row: Assignment): Schedule | null {
  const cadence: Cadence | null = parseCadence(row.cadence);
  if (!cadence) return null;
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  return {
    cadence,
    atMinute: clamp(row.atMinute, 0, 24 * 60 - 1),
    weekday: clamp(row.weekday, 0, 6),
    everyHours: clamp(row.everyHours, 1, 24),
  };
}

const time = (value: string | null) => (value ? Date.parse(value) || 0 : 0);

/** Every assignment of the account, newest first. */
export function listAssignments(sync: SyncClient): Assignment[] {
  return sync
    .rows("assignments")
    .map((object) => assignmentOf(object.id, object.row))
    .sort((a, b) => time(b.createdAt) - time(a.createdAt));
}

/** Runs, newest first, of one assignment or all. */
export function listRuns(sync: SyncClient, assignmentId?: string): Run[] {
  return sync
    .rows("assignment_runs")
    .map((object) => runOf(object.id, object.row))
    .filter((run) => !assignmentId || run.assignmentId === assignmentId)
    .sort((a, b) => time(b.startedAt) - time(a.startedAt));
}

export function getRun(sync: SyncClient, id: string): Run | null {
  const object = sync.objects.get(id);
  return object && !object.deleted && object.table === "assignment_runs"
    ? runOf(object.id, object.row)
    : null;
}

function assignmentRow(row: Assignment): Row {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    goal: row.goal,
    cadence: row.cadence,
    at_minute: row.atMinute,
    weekday: row.weekday,
    every_hours: row.everyHours,
    autonomy: row.autonomy,
    tools: JSON.stringify(row.tools),
    device_id: row.deviceId,
    device_name: row.deviceName,
    origin_device_id: row.originDeviceId,
    paused: row.paused ? 1 : 0,
    active_since: row.activeSince,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function runRow(run: Run): Row {
  return {
    id: run.id,
    assignment_id: run.assignmentId,
    slot: run.slot,
    late: run.late ? 1 : 0,
    device_id: run.deviceId,
    device_name: run.deviceName,
    handle: run.handle,
    state: run.state,
    result: run.result,
    error: run.error,
    feedback: run.feedback,
    reviewed_at: run.reviewedAt,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    updated_at: run.updatedAt,
  };
}

export interface AssignmentInput {
  id?: string;
  kind?: string;
  title: string;
  goal: string;
  cadence: string;
  atMinute?: number;
  weekday?: number;
  everyHours?: number;
  autonomy: string;
  tools: string[];
  /** Another device of the account; absent or this browser's id: this one. */
  deviceId?: string;
  deviceName?: string;
}

export class AssignmentError extends Error {
  constructor(public code: "goal_missing" | "cadence_invalid" | "not_found") {
    super(code);
  }
}

function clip(value: string, limit: number): string {
  return Array.from(value.trim()).slice(0, limit).join("");
}

/**
 * `assignments::normalize`: a missing title comes from the goal, unknown
 * tools are dropped, the device that first wrote a row stays its origin.
 * One difference: a row this browser runs carries the browser's name, so the
 * app can say where it runs (the app leaves its own blank and says "this
 * device").
 */
export function normalize(
  input: AssignmentInput,
  existing: Assignment | null,
  me: { id: string; name: string },
  now: string,
): Assignment {
  const goal = clip(input.goal, ASSIGNMENTS.limits.goalChars);
  if (!goal) throw new AssignmentError("goal_missing");
  const cadence = parseCadence(input.cadence);
  if (!cadence) throw new AssignmentError("cadence_invalid");
  const title =
    clip(input.title, ASSIGNMENTS.limits.titleChars) || clip(goal.split("\n")[0] ?? "", 60);
  const known = ASSIGNMENTS.toolGroups.map((group) => group.id);
  const tools: string[] = [];
  for (const tool of input.tools)
    if (known.includes(tool) && !tools.includes(tool)) tools.push(tool);
  const elsewhere = input.deviceId?.trim();
  const [deviceId, deviceName] =
    elsewhere && elsewhere !== me.id
      ? [elsewhere, clip(input.deviceName ?? "", 80)]
      : [me.id, clip(me.name, 80)];
  return {
    id: existing?.id ?? (input.id || crypto.randomUUID()),
    kind: input.kind === "task" ? "task" : "assignment",
    title,
    goal,
    cadence,
    atMinute: Math.min(input.atMinute ?? 9 * 60, 24 * 60 - 1),
    weekday: (input.weekday ?? 1) % 7,
    everyHours: Math.min(24, Math.max(1, input.everyHours ?? 4)),
    autonomy: parseAutonomy(input.autonomy),
    tools,
    deviceId,
    deviceName,
    originDeviceId: existing ? existing.originDeviceId : me.id,
    paused: existing?.paused ?? false,
    activeSince: existing?.activeSince ?? now,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export async function saveAssignment(
  sync: SyncClient,
  input: AssignmentInput,
  me: { id: string; name: string },
): Promise<Assignment> {
  const existing = input.id
    ? (listAssignments(sync).find((row) => row.id === input.id) ?? null)
    : null;
  const row = normalize(input, existing, me, timestamp());
  await sync.write("assignments", assignmentRow(row));
  return row;
}

/** Pausing stops new slots; resuming starts the clock again from now, so the
 * slots it was paused through are not owed. */
export async function setPaused(sync: SyncClient, id: string, paused: boolean) {
  const row = listAssignments(sync).find((item) => item.id === id);
  if (!row || row.paused === paused) return;
  const now = timestamp();
  await sync.write(
    "assignments",
    assignmentRow({ ...row, paused, activeSince: paused ? row.activeSince : now, updatedAt: now }),
  );
}

/** Deleting an assignment takes its history with it: every run travels as a
 * deletion too. */
export async function deleteAssignment(sync: SyncClient, id: string) {
  for (const run of listRuns(sync, id))
    await sync.write("assignment_runs", runRow(run), { deleted: true });
  const row = listAssignments(sync).find((item) => item.id === id);
  if (row) await sync.write("assignments", assignmentRow(row), { deleted: true });
}

export async function insertRun(
  sync: SyncClient,
  run: Pick<Run, "id" | "assignmentId" | "slot" | "late" | "deviceId" | "deviceName">,
): Promise<Run> {
  const now = timestamp();
  const row: Run = {
    ...run,
    handle: null,
    state: "running",
    result: null,
    error: null,
    feedback: null,
    reviewedAt: null,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
  };
  await sync.write("assignment_runs", runRow(row));
  return row;
}

export async function setHandle(sync: SyncClient, runId: string, handle: string) {
  const run = getRun(sync, runId);
  if (run) await sync.write("assignment_runs", runRow({ ...run, handle, updatedAt: timestamp() }));
}

/** Closes a run; only a running run closes, so a late answer never
 * overwrites a review someone already gave. */
export async function finishRun(
  sync: SyncClient,
  runId: string,
  state: "needs_review" | "done" | "failed",
  result: string | null,
  error: string | null,
): Promise<boolean> {
  const run = getRun(sync, runId);
  if (run?.state !== "running") return false;
  const now = timestamp();
  await sync.write(
    "assignment_runs",
    runRow({ ...run, state, result, error, finishedAt: now, updatedAt: now }),
  );
  return true;
}

/** Approve or reject a result, with what the person said. The row travels,
 * so the next run reads it wherever it runs. */
export async function review(
  sync: SyncClient,
  runId: string,
  approve: boolean,
  feedback: string | null,
): Promise<Run | null> {
  const run = getRun(sync, runId);
  if (!run || !["needs_review", "approved", "rejected"].includes(run.state)) return run;
  const now = timestamp();
  const next: Run = {
    ...run,
    state: approve ? "approved" : "rejected",
    feedback: feedback?.trim() || null,
    reviewedAt: now,
    updatedAt: now,
  };
  await sync.write("assignment_runs", runRow(next));
  return next;
}

/** `store::reviewed_for_prompt`: what the person said, newest first. */
export function reviewedForPrompt(sync: SyncClient, assignmentId: string): Reviewed[] {
  return listRuns(sync, assignmentId)
    .filter((run) => run.state === "approved" || run.state === "rejected")
    .sort((a, b) => time(b.reviewedAt) - time(a.reviewedAt))
    .slice(0, ASSIGNMENTS.feedbackInPrompt)
    .map((run) => ({
      // The day in the zone the review was written in, as Rust formats it.
      when:
        run.reviewedAt && !Number.isNaN(Date.parse(run.reviewedAt))
          ? run.reviewedAt.slice(0, 10)
          : "",
      approved: run.state === "approved",
      feedback: run.feedback,
      result: run.result === null ? null : resultSummary(run.result),
    }));
}

/** The inbox: results waiting for a verdict, newest first. */
export function needsReview(sync: SyncClient): Run[] {
  return listRuns(sync)
    .filter((run) => run.state === "needs_review")
    .sort((a, b) => time(b.finishedAt) - time(a.finishedAt));
}
