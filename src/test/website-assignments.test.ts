// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PERSONALIZATION, turnTools } from "../../website/src/client/agent";
import {
  allowToolFor,
  effectiveGroups,
  resultSummary,
  runPrompt,
} from "../../website/src/client/assignments/prompt";
import {
  listAssignments,
  listRuns,
  review,
  saveAssignment,
  setPaused,
} from "../../website/src/client/assignments/rows";
import { runId } from "../../website/src/client/assignments/runid";
import {
  forgetLiveRuns,
  RUN_LOST,
  runNow,
  saveSettings,
  startEventRun,
  tick,
} from "../../website/src/client/assignments/runner";
import {
  due,
  fixedZone,
  latestAtOrBefore,
  nextAfter,
  type Schedule,
  slotKey,
} from "../../website/src/client/assignments/schedule";
import { ASSIGNMENTS } from "../../website/src/client/assignments/words";
import { messagesOf } from "../../website/src/client/library";
import { BROWSER, fakeHost, PHONE } from "./website-assignments-fakes";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  forgetLiveRuns();
  vi.unstubAllGlobals();
});

const paris = fixedZone(120);
/** October 2026, Paris summer time: the 5th is a Monday, the 10th a Saturday. */
const at = (day: number, hour: number, minute: number) =>
  Date.UTC(2026, 9, day, hour, minute) - 120 * 60_000;
const schedule = (cadence: Schedule["cadence"], over: Partial<Schedule> = {}): Schedule => ({
  cadence,
  atMinute: 9 * 60,
  weekday: 1,
  everyHours: 4,
  ...over,
});
const never = () => false;

describe("the assignment clock, as Rust keeps it", () => {
  it("finds today's daily slot once its time has passed", () => {
    const daily = schedule("daily");
    expect(latestAtOrBefore(daily, at(7, 9, 30), paris)).toBe(at(7, 9, 0));
    expect(latestAtOrBefore(daily, at(7, 8, 59), paris)).toBe(at(6, 9, 0));
    expect(nextAfter(daily, at(7, 9, 0), paris)).toBe(at(8, 9, 0));
  });

  it("skips the weekend on weekdays and keeps a weekly day", () => {
    const weekdays = schedule("weekdays");
    expect(latestAtOrBefore(weekdays, at(11, 12, 0), paris)).toBe(at(9, 9, 0));
    expect(nextAfter(weekdays, at(9, 10, 0), paris)).toBe(at(12, 9, 0));
    const weekly = schedule("weekly");
    expect(latestAtOrBefore(weekly, at(8, 12, 0), paris)).toBe(at(5, 9, 0));
    expect(nextAfter(weekly, at(8, 12, 0), paris)).toBe(at(12, 9, 0));
  });

  it("counts hourly and every few hours from the day", () => {
    const hourly = schedule("hourly", { atMinute: 15 });
    expect(latestAtOrBefore(hourly, at(7, 13, 20), paris)).toBe(at(7, 13, 15));
    expect(nextAfter(hourly, at(7, 13, 20), paris)).toBe(at(7, 14, 15));
    const every = schedule("every", { atMinute: 60, everyHours: 6 });
    expect(latestAtOrBefore(every, at(7, 12, 0), paris)).toBe(at(7, 7, 0));
    expect(nextAfter(every, at(7, 19, 0), paris)).toBe(at(8, 1, 0));
  });

  it("turns a missed week into one late run, not seven", () => {
    const daily = schedule("daily");
    const owed = due(daily, at(1, 8, 0), at(8, 12, 0), never, "executor", paris);
    expect(owed).toEqual({ slot: at(8, 9, 0), late: true });
    const key = slotKey(at(8, 9, 0));
    expect(due(daily, at(1, 8, 0), at(8, 12, 0), (ran) => ran === key, "executor", paris)).toBe(
      null,
    );
  });

  it("is on time just after its slot and owes nothing before it was active", () => {
    const daily = schedule("daily");
    expect(due(daily, at(1, 8, 0), at(7, 9, 2), never, "executor", paris)?.late).toBe(false);
    expect(due(daily, at(7, 14, 0), at(7, 15, 0), never, "executor", paris)).toBe(null);
  });

  it("leaves a slot to the device that runs it for a while, then catches up late", () => {
    const daily = schedule("daily");
    expect(due(daily, at(1, 8, 0), at(7, 9, 20), never, "fallback", paris)).toBe(null);
    expect(due(daily, at(1, 8, 0), at(7, 9, 40), never, "fallback", paris)?.late).toBe(true);
  });

  it("writes slot keys in UTC to the second, as Rust does", () => {
    expect(slotKey(at(7, 9, 0))).toBe("2026-10-07T07:00:00Z");
  });
});

describe("what a run is told and may use", () => {
  it("assembles the very prompts Rust renders", () => {
    for (const vector of ASSIGNMENTS.vectors.prompts)
      expect(runPrompt(vector.input)).toBe(vector.prompt);
  });

  it("summarises a result as Rust does", () => {
    for (const vector of ASSIGNMENTS.vectors.summaries)
      expect(resultSummary(vector.answer)).toBe(vector.summary);
  });

  it("derives the run ids Rust derives", async () => {
    for (const vector of ASSIGNMENTS.vectors.runIds)
      expect(await runId(vector.assignmentId, vector.slot)).toBe(vector.runId);
  });

  it("drops what leaves the device under ask first, and offers only the groups' tools", () => {
    const ticked = ["web", "terminal", "browser", "notes"];
    expect(effectiveGroups(ticked, "ask").map((group) => group.id)).toEqual(["web", "notes"]);
    expect(effectiveGroups(ticked, "act").map((group) => group.id)).toEqual([
      "web",
      "notes",
      "terminal",
      "browser",
    ]);
    const allow = allowToolFor(effectiveGroups(["web", "memory"], "act"));
    expect(allow("web_search")).toBe(true);
    expect(allow("remember")).toBe(true);
    expect(allow("create_note")).toBe(false);
    expect(allow("linear__list_issues")).toBe(false);
    expect(allow("make_document")).toBe(false);
    expect(allowToolFor(effectiveGroups(["connectors"], "ask"))("linear__list_issues")).toBe(true);
  });

  it("reads the finances only for a run whose definition names them", () => {
    const notes = allowToolFor(effectiveGroups(["notes"], "act"));
    expect(notes("spending_summary")).toBe(false);
    expect(notes("transactions_search")).toBe(false);
    const personal = allowToolFor(effectiveGroups(["notes", "personal"], "ask"));
    expect(personal("spending_summary")).toBe(true);
    expect(personal("transactions_search")).toBe(true);
  });

  it("narrows the turn's tools to the run's", () => {
    const { sync } = fakeHost();
    const tools = turnTools({
      sync,
      operator: { root: "", fetch },
      key: "",
      model: "m",
      memory: true,
      personalization: DEFAULT_PERSONALIZATION,
      temporary: false,
      onText: () => undefined,
      allowTool: allowToolFor(effectiveGroups(["web"], "ask")),
    }).map((tool) => tool.function.name);
    expect(tools.sort()).toEqual(["fetch_page", "web_search"]);
  });
});

async function assignment(
  host: ReturnType<typeof fakeHost>["host"],
  over: Partial<Parameters<typeof saveAssignment>[1]> = {},
  me = { id: BROWSER, name: "Browser - Firefox" },
) {
  return saveAssignment(
    host.sync,
    {
      title: "Energy watch",
      goal: "Watch the French energy market",
      cadence: "daily",
      atMinute: 9 * 60,
      autonomy: "ask",
      tools: ["web", "notes"],
      ...over,
    },
    me,
  );
}

/** Makes a row active since a past instant, as if it was created then. */
async function activeSince(host: ReturnType<typeof fakeHost>["host"], id: string, instant: number) {
  const object = host.sync.objects.get(id);
  if (!object) throw new Error("missing row");
  await host.sync.write("assignments", {
    ...object.row,
    active_since: new Date(instant).toISOString(),
  });
}

describe("running assignments in this browser", () => {
  it("runs the latest slot of a row naming this browser once, late, writing the run first", async () => {
    const { host, sync, asked, notices } = fakeHost();
    const row = await assignment(host);
    await activeSince(host, row.id, at(1, 8, 0));
    const started = await tick(host, { now: at(8, 12, 0), zone: paris });
    expect(started).toHaveLength(1);
    const [run] = listRuns(sync);
    expect(run.state).toBe("running");
    expect(run.late).toBe(true);
    expect(run.deviceId).toBe(BROWSER);
    expect(run.id).toBe(await runId(row.id, "2026-10-08T07:00:00Z"));
    await vi.waitFor(() => expect(listRuns(sync)[0].state).toBe("needs_review"));
    expect(listRuns(sync)[0].result).toContain("All good.");
    expect(asked).toHaveLength(1);
    expect(asked[0].options.background).toBe(true);
    expect(asked[0].question).toContain("This run is late");
    expect(asked[0].options.allowTool?.("create_note")).toBe(true);
    expect(asked[0].options.allowTool?.("remember")).toBe(false);
    const chat = listRuns(sync)[0].handle as string;
    expect(sync.objects.get(chat)?.row.title).toBe("Energy watch");
    expect(messagesOf(sync, chat).map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(notices[0]).toContain("To review: All good.");

    // The same slot never runs again, not even after the page reloads.
    expect(await tick(host, { now: at(8, 12, 5), zone: paris })).toEqual([]);
    forgetLiveRuns();
    const reloaded = fakeHost({ sync, store: undefined });
    expect(await tick(reloaded.host, { now: at(8, 12, 10), zone: paris })).toEqual([]);
  });

  it("keeps a slot this browser started single use across a reload, through its ledger", async () => {
    const { host, store } = fakeHost();
    const row = await assignment(host);
    await activeSince(host, row.id, at(1, 8, 0));
    await tick(host, { now: at(8, 12, 0), zone: paris });
    await vi.waitFor(() => expect(listRuns(host.sync)[0].state).not.toBe("running"));
    forgetLiveRuns();
    // A page whose journal has not brought the run back yet: the ledger in
    // this browser's store is what stops the slot running twice.
    const blank = fakeHost();
    const again = fakeHost({ store, sync: blank.sync });
    const object = host.sync.objects.get(row.id);
    await again.sync.write("assignments", { ...(object?.row ?? {}) });
    expect(listRuns(again.sync)).toEqual([]);
    expect(await tick(again.host, { now: at(8, 13, 0), zone: paris })).toEqual([]);
    // Without that ledger, the same journal would run it again.
    expect(await tick(blank.host, { now: at(8, 13, 0), zone: paris })).toHaveLength(1);
  });

  it("closes a run a closed tab left running", async () => {
    const { host, sync } = fakeHost({ answer: () => new Error("never") });
    const row = await assignment(host);
    await sync.write("assignment_runs", {
      id: "lost",
      assignment_id: row.id,
      slot: "now:x",
      late: 0,
      device_id: BROWSER,
      device_name: "browser",
      handle: null,
      state: "running",
      result: null,
      error: null,
      feedback: null,
      reviewed_at: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      updated_at: new Date().toISOString(),
    });
    await tick(host, { now: at(7, 8, 0), zone: paris });
    const lost = listRuns(sync).find((run) => run.id === "lost");
    expect(lost?.state).toBe("failed");
    expect(lost?.error).toBe(RUN_LOST);
  });

  it("runs a row another device sent here only once this browser accepts them", async () => {
    const { host } = fakeHost();
    const row = await assignment(
      host,
      { deviceId: BROWSER, deviceName: "Browser" },
      { id: PHONE, name: "Phone" },
    );
    expect(row.originDeviceId).toBe(PHONE);
    expect(row.deviceId).toBe(BROWSER);
    await activeSince(host, row.id, at(1, 8, 0));
    expect(await tick(host, { now: at(7, 9, 1), zone: paris })).toEqual([]);
    await saveSettings(host, { acceptOthers: true });
    expect(await tick(host, { now: at(7, 9, 1), zone: paris })).toHaveLength(1);
  });

  it("leaves a row named for another device alone, and catches up the ones it wrote", async () => {
    const { host } = fakeHost();
    const theirs = await assignment(host, {}, { id: PHONE, name: "Phone" });
    await activeSince(host, theirs.id, at(1, 8, 0));
    const mine = await assignment(host, { deviceId: PHONE, deviceName: "Phone", title: "Mine" });
    await activeSince(host, mine.id, at(1, 8, 0));
    expect(await tick(host, { now: at(7, 9, 20), zone: paris })).toEqual([]);
    const caught = await tick(host, { now: at(7, 9, 40), zone: paris });
    expect(caught).toHaveLength(1);
    const run = listRuns(host.sync).find((item) => item.id === caught[0]);
    expect(run?.assignmentId).toBe(mine.id);
    expect(run?.late).toBe(true);
  });

  it("runs nothing while paused, nor the slots it was paused through", async () => {
    const { host } = fakeHost();
    const row = await assignment(host);
    await activeSince(host, row.id, at(1, 8, 0));
    await setPaused(host.sync, row.id, true);
    expect(await tick(host, { now: at(7, 9, 1), zone: paris })).toEqual([]);
    await setPaused(host.sync, row.id, false);
    // Resumed now (after the 7th): the 7th's slot is not owed.
    expect(await tick(host, { now: at(7, 9, 1), zone: paris })).toEqual([]);
  });

  it("closes a scheduled task as done and a failed run with its reason", async () => {
    let fail = false;
    const { host, sync } = fakeHost({
      answer: () => (fail ? new Error("The model could not answer.") : "Morning digest."),
    });
    const task = await assignment(host, { kind: "task", title: "Digest" });
    await activeSince(host, task.id, at(1, 8, 0));
    await tick(host, { now: at(7, 9, 1), zone: paris });
    await vi.waitFor(() => expect(listRuns(sync)[0]?.state).toBe("done"));
    fail = true;
    await runNow(host, task.id);
    await vi.waitFor(() => expect(listRuns(sync).some((run) => run.state === "failed")).toBe(true));
    expect(listRuns(sync).find((run) => run.state === "failed")?.error).toBe(
      "The model could not answer.",
    );
  });

  it("reads back the person's feedback, and carries out an approved proposal once", async () => {
    const { host, sync, asked } = fakeHost({
      answer: (question) =>
        question.includes("Carry it out now")
          ? "Sent.\n## Result\nSent the drafts."
          : "Proposal: send the three drafts.",
    });
    const row = await assignment(host);
    await activeSince(host, row.id, at(1, 8, 0));
    await tick(host, { now: at(6, 9, 1), zone: paris });
    await vi.waitFor(() => expect(listRuns(sync)[0]?.state).toBe("needs_review"));
    const first = listRuns(sync)[0];
    await review(sync, first.id, true, "Good, but shorter");

    const started = await tick(host, { now: at(6, 9, 2), zone: paris });
    expect(started).toEqual([await runId(row.id, `approved:${first.id}`)]);
    await vi.waitFor(() =>
      expect(listRuns(sync).find((run) => run.id === started[0])?.state).toBe("done"),
    );
    expect(asked[1].question).toContain("Proposal: send the three drafts.");
    // Carried out once.
    expect(await tick(host, { now: at(6, 9, 3), zone: paris })).toEqual([]);

    await tick(host, { now: at(7, 9, 1), zone: paris });
    await vi.waitFor(() => expect(asked).toHaveLength(3));
    expect(asked[2].question).toContain("I approved your result");
    expect(asked[2].question).toContain("My feedback: Good, but shorter");
  });

  it("starts an event run once per event, with what happened", async () => {
    const { host, asked } = fakeHost();
    const row = await assignment(host);
    const first = await startEventRun(host, row.id, "trigger-1:item-9", "A new issue was filed");
    expect(first).toBe(await runId(row.id, "event:trigger-1:item-9"));
    expect(await startEventRun(host, row.id, "trigger-1:item-9", "Again")).toBe(null);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0].question).toContain(`${ASSIGNMENTS.words.eventCause.trim()}`);
    expect(asked[0].question).toContain("A new issue was filed");
    // A row this browser does not run never starts one here.
    const elsewhere = await assignment(host, { deviceId: PHONE, deviceName: "Phone" });
    expect(await startEventRun(host, elsewhere.id, "t:i", "x")).toBe(null);
  });

  it("saves rows the app can read, the device that wrote one staying its origin", async () => {
    const { host, sync } = fakeHost();
    const row = await assignment(host, { title: "", tools: ["web", "made-up", "web"] });
    expect(row.title).toBe("Watch the French energy market");
    expect(row.tools).toEqual(["web"]);
    const edited = await saveAssignment(
      sync,
      {
        id: row.id,
        title: "Edited",
        goal: row.goal,
        cadence: "weekly",
        autonomy: "act",
        tools: [],
      },
      { id: PHONE, name: "Phone" },
    );
    expect(edited.originDeviceId).toBe(BROWSER);
    expect(edited.activeSince).toBe(row.activeSince);
    const stored = sync.objects.get(row.id)?.row;
    expect(stored?.tools).toBe("[]");
    expect(stored?.paused).toBe(0);
    expect(listAssignments(sync)[0].cadence).toBe("weekly");
  });
});
