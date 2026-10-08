/**
 * Running assignments in this browser (ADR-0091): the page is an open app,
 * so while a tab on `/app` is open it runs the slots of the rows that name
 * it, on the app's own clock, and nothing runs when it is closed.
 *
 * The rules are the app's (`assignments/mod.rs`):
 * - one device runs a row, the one it names; a row another device wrote and
 *   addressed here runs only when this browser's owner said so (the errand
 *   consent of ADR-0054, kept per browser, off until switched on);
 * - each slot runs once: a ledger in this browser, plus the run rows that
 *   arrived from anywhere, plus the run's id derived from assignment and slot
 *   so two devices that both ran one slot made one object;
 * - only the latest slot is owed; a late run says so;
 * - a row this browser wrote for another device is caught up here, late, when
 *   that device left a slot unrun for the grace period, as the phone does;
 * - the run row is written first, then the run is an ordinary chat turn in
 *   the background with only the tools of the assignment's groups.
 *
 * Whether a run is live is a question for this page (`LIVE`), never a
 * column: a run row this browser left running when the tab closed is closed
 * as failed the next time the page looks.
 */
import { t } from "../../lib/i18n";
import type { FeatureHost } from "../feature";
import { createChat } from "../library";
import { allowToolFor, type Autonomy, effectiveGroups, resultSummary, runPrompt } from "./prompt";
import {
  type Assignment,
  finishRun,
  getRun,
  insertRun,
  listAssignments,
  listRuns,
  reviewedForPrompt,
  type Run,
  scheduleOf,
  setHandle,
} from "./rows";
import { runId } from "./runid";
import { browserZone, type Due, due, type Role, slotKey, type Zone } from "./schedule";
import { ASSIGNMENTS } from "./words";

/** What "ran on" says for a run this browser made. */
export const BROWSER_DEVICE_NAME = "browser";
/** Written on a run this page started and lost (the tab was closed or
 * reloaded mid-run): one of the app's own sentences, which it translates. */
export const RUN_LOST = "The run did not finish in time.";

/** The browser's own choices, in its sealed store. */
export interface AssignmentSettings {
  /** Run rows another device wrote and addressed to this browser. */
  acceptOthers: boolean;
}
export const DEFAULT_SETTINGS: AssignmentSettings = { acceptOthers: false };

/** The runs this page has under way, by run id. */
const LIVE = new Map<string, AbortController>();

export function isLive(runIdValue: string) {
  return LIVE.has(runIdValue);
}

/** For tests: forget what this page runs, as a reload would. */
export function forgetLiveRuns() {
  for (const controller of LIVE.values()) controller.abort();
  LIVE.clear();
}

export async function loadSettings(host: FeatureHost): Promise<AssignmentSettings> {
  return {
    ...DEFAULT_SETTINGS,
    ...((await host.storeFor("assignments").get<AssignmentSettings>("settings")) ?? {}),
  };
}

export function saveSettings(host: FeatureHost, settings: AssignmentSettings) {
  return host.storeFor("assignments").put("settings", settings);
}

/** This browser's device id, or empty when the service has not admitted it. */
function me(host: FeatureHost): string {
  return host.device.id ?? "";
}

/** `runs_here`: the row names this browser. */
export function runsHere(row: Assignment, device: string): boolean {
  return !!device && row.deviceId === device;
}

/** Another device wrote the row. */
export function foreign(row: Assignment, device: string): boolean {
  return !!row.originDeviceId && row.originDeviceId !== device;
}

/** How this browser relates to a row's slots, or null when it has none. */
export function roleFor(row: Assignment, device: string): Role | null {
  if (runsHere(row, device)) return "executor";
  if (device && row.originDeviceId === device) return "fallback";
  return null;
}

/** Every slot already run: this browser's ledger and every run row. */
async function ranSlots(host: FeatureHost, assignmentId: string): Promise<Set<string>> {
  const ledger = await host.storeFor("assignments").list<string>(`ledger:${assignmentId}:`);
  const prefix = `ledger:${assignmentId}:`;
  return new Set([
    ...ledger.map((entry) => entry.id.slice(prefix.length)),
    ...listRuns(host.sync, assignmentId).map((run) => run.slot),
  ]);
}

/** Takes a slot for this browser, once: false when it was taken already. */
async function claimSlot(host: FeatureHost, assignmentId: string, slot: string, run: string) {
  const store = host.storeFor("assignments");
  const key = `ledger:${assignmentId}:${slot}`;
  if ((await store.get(key)) !== undefined) return false;
  if (listRuns(host.sync, assignmentId).some((item) => item.slot === slot || item.id === run))
    return false;
  await store.put(key, run);
  return true;
}

/** What asked for a run; each becomes the run's slot key. */
export type Slot =
  | { kind: "due"; due: Due }
  | { kind: "now"; at: string }
  | { kind: "event"; key: string }
  | { kind: "approved"; run: Run };

function slotKeyOf(slot: Slot): string {
  switch (slot.kind) {
    case "due":
      return slotKey(slot.due.slot);
    case "now":
      return `now:${slot.at}`;
    case "event":
      return `event:${slot.key}`;
    case "approved":
      return `approved:${slot.run.id}`;
  }
}

/** The slot as the person reads it, in this browser's time, as Rust formats
 * it for a late run. */
function localSlot(slot: number): string {
  const date = new Date(slot);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/**
 * Starts one run, once: the slot is claimed, the run row written, the chat
 * filed under the assignment's title, then the turn runs in the background.
 * Returns the run's id, or null when the slot was taken. The returned promise
 * settles when the run row is written; `done` settles when the run closed.
 */
export async function startRun(
  host: FeatureHost,
  row: Assignment,
  slot: Slot,
): Promise<{ id: string; done: Promise<void> } | null> {
  const key = slotKeyOf(slot);
  const id = await runId(row.id, key);
  if (!(await claimSlot(host, row.id, key, id))) return null;
  // Live before the row exists, so no look at the clock in between takes it
  // for a run a closed tab left behind.
  const controller = new AbortController();
  LIVE.set(id, controller);
  const late = slot.kind === "due" && slot.due.late;
  try {
    await insertRun(host.sync, {
      id,
      assignmentId: row.id,
      slot: key,
      late,
      deviceId: me(host),
      deviceName: BROWSER_DEVICE_NAME,
    });
  } catch (failure) {
    LIVE.delete(id);
    throw failure;
  }
  host.refresh();
  const approved = slot.kind === "approved" ? slot.run : null;
  const autonomy: Autonomy = approved ? "act" : row.autonomy;
  const text = runPrompt({
    kind: row.kind,
    title: row.title,
    goal: row.goal,
    autonomy,
    lateFor: slot.kind === "due" && late ? localSlot(slot.due.slot) : null,
    reviewed: reviewedForPrompt(host.sync, row.id),
    approvedProposal: approved?.result ?? null,
  });
  const done = (async () => {
    try {
      const chatId = await createChat(host.sync, text, host.model || null, row.title);
      await setHandle(host.sync, id, chatId);
      const result = await host.ask(text, {
        chatId,
        background: true,
        allowTool: allowToolFor(effectiveGroups(row.tools, autonomy)),
        signal: controller.signal,
      });
      const state = row.kind !== "task" && !approved ? "needs_review" : "done";
      if (result.stopped && !result.answer.trim()) {
        await finishRun(host.sync, id, "failed", null, RUN_LOST);
        return;
      }
      if (await finishRun(host.sync, id, state, result.answer, null)) {
        const summary = resultSummary(result.answer);
        host.notify(
          state === "needs_review"
            ? summary
              ? t(`${row.title}. To review: ${summary}`, `${row.title}. À examiner : ${summary}`)
              : t(
                  `${row.title}. A result is waiting for your review.`,
                  `${row.title}. Un résultat attend votre examen.`,
                )
            : `${row.title}. ${summary}`,
        );
      }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : RUN_LOST;
      if (await finishRun(host.sync, id, "failed", null, message))
        host.notify(
          t(
            `${row.title}. This run did not finish. ${message}`,
            `${row.title}. Cette exécution n’a pas abouti. ${message}`,
          ),
        );
    } finally {
      LIVE.delete(id);
      host.refresh();
    }
  })();
  return { id, done };
}

/** Closes the runs this browser started that no page here is running any
 * more: the tab that ran them was closed or reloaded. */
export async function harvest(host: FeatureHost) {
  const device = me(host);
  if (!device) return;
  for (const run of listRuns(host.sync)) {
    if (run.state !== "running" || run.deviceId !== device || LIVE.has(run.id)) continue;
    await finishRun(host.sync, run.id, "failed", null, RUN_LOST);
  }
}

/** Approved "ask first" proposals of rows this browser runs, recent enough
 * to still mean what they said, not yet carried out anywhere. */
export function pendingCarryOuts(host: FeatureHost, ledger: Set<string>, now: number): Run[] {
  const rows = new Map(listAssignments(host.sync).map((row) => [row.id, row]));
  const since = now - ASSIGNMENTS.clock.carryOutDays * 86_400_000;
  const runs = listRuns(host.sync);
  return runs.filter((run) => {
    const row = rows.get(run.assignmentId);
    if (row?.autonomy !== "ask" || row.kind === "task") return false;
    if (run.state !== "approved" || run.slot.startsWith("approved:")) return false;
    if (!run.reviewedAt || Date.parse(run.reviewedAt) < since) return false;
    const slot = `approved:${run.id}`;
    return (
      !runs.some((other) => other.assignmentId === run.assignmentId && other.slot === slot) &&
      !ledger.has(`${run.assignmentId}:${slot}`)
    );
  });
}

/**
 * One look at the clock: close what was lost, run what is due here, carry
 * out what was approved. Runs start and are not awaited, so a long run never
 * holds the next look; the ledger keeps a slot from starting twice.
 */
export async function tick(
  host: FeatureHost,
  options: { now?: number; zone?: Zone } = {},
): Promise<string[]> {
  const now = options.now ?? Date.now();
  const zone = options.zone ?? browserZone;
  const device = me(host);
  const started: string[] = [];
  if (!device) return started;
  await harvest(host);
  const settings = await loadSettings(host);
  const rows = listAssignments(host.sync);
  for (const row of rows) {
    if (row.paused) continue;
    const role = roleFor(row, device);
    if (!role) continue;
    if (role === "executor" && foreign(row, device) && !settings.acceptOthers) continue;
    const schedule = scheduleOf(row);
    const activeSince = Date.parse(row.activeSince);
    if (!schedule || Number.isNaN(activeSince)) continue;
    const ran = await ranSlots(host, row.id);
    const owed = due(schedule, activeSince, now, (key) => ran.has(key), role, zone);
    if (!owed) continue;
    const run = await startRun(host, row, { kind: "due", due: owed });
    if (run) started.push(run.id);
  }
  const ledger = new Set(
    (await host.storeFor("assignments").list<string>("ledger:")).map((entry) =>
      entry.id.slice("ledger:".length),
    ),
  );
  for (const run of pendingCarryOuts(host, ledger, now)) {
    const row = rows.find((item) => item.id === run.assignmentId);
    if (!row || !runsHere(row, device)) continue;
    const carried = await startRun(host, row, { kind: "approved", run });
    if (carried) started.push(carried.id);
  }
  return started;
}

/** Whether this browser evaluates a row's triggers and runs its events: the
 * device it names, under the same consent as its slots. */
/** Whether the assignment exists, is not paused and names this browser: the
 * question a trigger asks before it looks (consent is asked when it fires). */
export function assignmentRunsHere(host: FeatureHost, assignmentId: string): boolean {
  const row = listAssignments(host.sync).find((item) => item.id === assignmentId);
  return !!row && !row.paused && runsHere(row, me(host));
}

export async function evaluatesHere(host: FeatureHost, row: Assignment): Promise<boolean> {
  const device = me(host);
  if (row.paused || !runsHere(row, device)) return false;
  return !foreign(row, device) || (await loadSettings(host)).acceptOthers;
}

/**
 * Runs an assignment because a connector reported something (ADR-0092),
 * once per event: its slot is `event:<eventKey>` (a trigger names it
 * `<trigger>:<item>`), and what happened joins the goal for this run only.
 * Returns the run's id, or null when nothing ran (not here, paused, already
 * run).
 */
export async function startEventRun(
  host: FeatureHost,
  assignmentId: string,
  eventKey: string,
  summary: string,
): Promise<string | null> {
  const row = listAssignments(host.sync).find((item) => item.id === assignmentId);
  if (!row || !(await evaluatesHere(host, row))) return null;
  const run = await startRun(
    host,
    { ...row, goal: `${row.goal}${ASSIGNMENTS.words.eventCause}${summary}` },
    { kind: "event", key: eventKey },
  );
  return run?.id ?? null;
}

/** "Run now", for a row this browser runs. */
export async function runNow(host: FeatureHost, assignmentId: string): Promise<string | null> {
  const row = listAssignments(host.sync).find((item) => item.id === assignmentId);
  if (!row || !runsHere(row, me(host))) return null;
  const run = await startRun(host, row, { kind: "now", at: new Date().toISOString() });
  return run?.id ?? null;
}

export { getRun };
