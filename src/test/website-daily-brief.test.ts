// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  briefTick,
  cleanTopics,
  followUps,
  freshLinks,
  headline,
  prepareBrief,
  saveBrief,
  todaysCard,
} from "../../website/src/client/assignments/brief";
import { saveAssignment } from "../../website/src/client/assignments/rows";
import { forgetLiveRuns } from "../../website/src/client/assignments/runner";
import { ASSIGNMENTS } from "../../website/src/client/assignments/words";
import type { Operator } from "../../website/src/client/carpe-diem";
import { BROWSER, fakeHost } from "./website-assignments-fakes";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  forgetLiveRuns();
  vi.unstubAllGlobals();
});

/** A local morning: 8 October 2026, 7:45. */
const MORNING = new Date(2026, 9, 8, 7, 45);
const YESTERDAY = new Date(2026, 9, 7, 15, 0).toISOString();

function searchOperator(results: Record<string, unknown>[]) {
  const queries: string[] = [];
  const operator: Operator = {
    root: "https://operator.test",
    fetch: async (input, init) => {
      if (String(input).endsWith("/v1/augment/search")) {
        queries.push(String(JSON.parse(String(init?.body)).query));
        return new Response(JSON.stringify({ results }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    },
  };
  return { operator, queries };
}

async function note(
  host: ReturnType<typeof fakeHost>["host"],
  title: string,
  body: string,
  at: string,
) {
  await host.sync.write("notes", {
    id: crypto.randomUUID(),
    title,
    generated_content: null,
    edited_content: body,
    active_tab: "notes",
    processing_status: "draft",
    created_at: at,
    updated_at: at,
    calendar_event_id: null,
    scheduled_start: null,
    attendees_json: null,
  });
}

describe("the daily brief's rules", () => {
  it("finds the follow-ups Rust finds", () => {
    for (const vector of ASSIGNMENTS.vectors.followUps)
      expect(followUps(vector.content)).toEqual(vector.followUps);
  });

  it("keeps fresh dated links, else the first ones, web links only, two at most", () => {
    const now = MORNING.getTime();
    expect(
      freshLinks(
        [
          { title: "Old", url: "https://a.test/old", date: "2026-09-01T00:00:00Z" },
          { title: "New", url: "https://a.test/new", date: new Date(now - 3600_000).toISOString() },
          { title: "Undated", url: "https://a.test/undated" },
        ],
        now,
      ),
    ).toEqual([{ title: "New", url: "https://a.test/new" }]);
    expect(
      freshLinks(
        [
          { title: "One", url: "https://a.test/1" },
          { title: "Script", url: "javascript:alert(1)" },
          { title: "", url: "https://a.test/2" },
          { title: "Three", url: "https://a.test/3" },
        ],
        now,
      ),
    ).toEqual([
      { title: "One", url: "https://a.test/1" },
      { title: "https://a.test/2", url: "https://a.test/2" },
    ]);
  });

  it("follows five topics at most, once each", () => {
    expect(cleanTopics([" Energy  prices ", "energy prices", "a", "b", "c", "d", "e"])).toEqual([
      "Energy prices",
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});

describe("the daily brief in the browser", () => {
  it("is off until asked for, and waits for its time", async () => {
    const { host } = fakeHost();
    expect(await briefTick(host, MORNING)).toBe(null);
    await saveBrief(host, { enabled: true, atMinute: 8 * 60, topics: [] });
    expect(await briefTick(host, MORNING)).toBe(null);
  });

  it("says nothing on a morning with nothing to say, once", async () => {
    const { host, notices } = fakeHost();
    await saveBrief(host, { enabled: true, atMinute: 7 * 60 + 30, topics: [] });
    const card = await briefTick(host, MORNING);
    expect(card?.status).toBe("silent");
    expect(notices).toEqual([]);
    expect(await briefTick(host, new Date(2026, 9, 8, 9, 0))).toBe(null);
    expect((await todaysCard(host, MORNING))?.status).toBe("silent");
  });

  it("reads yesterday's notes, results, failures and followed topics, and announces them", async () => {
    const { operator, queries } = searchOperator([
      {
        title: "Tariffs move",
        url: "https://news.test/a",
        date: new Date(MORNING.getTime() - 3600_000).toISOString(),
      },
    ]);
    const { host, sync, notices } = fakeHost({ operator });
    await note(host, "Client call", "## Next steps\n- Send the quote", YESTERDAY);
    await note(host, "Older", "# Action\n- not today", new Date(2026, 9, 5).toISOString());
    const row = await saveAssignment(
      sync,
      { title: "Watch", goal: "Watch", cadence: "daily", autonomy: "ask", tools: [] },
      { id: BROWSER, name: "Browser" },
    );
    const base = {
      assignment_id: row.id,
      late: 0,
      device_id: BROWSER,
      device_name: "browser",
      handle: null,
      feedback: null,
      reviewed_at: null,
      started_at: YESTERDAY,
      finished_at: YESTERDAY,
    };
    await sync.write("assignment_runs", {
      ...base,
      id: "r1",
      slot: "a",
      state: "needs_review",
      result: "## Result\nTwo new tenders.",
      error: null,
      updated_at: YESTERDAY,
    });
    await sync.write("assignment_runs", {
      ...base,
      id: "r2",
      slot: "b",
      state: "failed",
      result: null,
      error: "The run did not finish in time.",
      updated_at: new Date(MORNING.getTime() - 3600_000).toISOString(),
    });
    await saveBrief(host, { enabled: true, atMinute: 7 * 60 + 30, topics: ["Energy prices"] });
    const stored = await briefTick(host, MORNING);
    expect(stored?.status).toBe("delivered");
    const card = stored?.card;
    expect(card?.notes.map((item) => [item.title, item.followUps])).toEqual([
      ["Client call", ["Send the quote"]],
    ]);
    expect(card?.reviews).toEqual([
      { runId: "r1", assignmentId: row.id, title: "Watch", detail: "Two new tenders." },
    ]);
    expect(card?.failures[0].detail).toBe("The run did not finish in time.");
    expect(card?.topics).toEqual([
      { topic: "Energy prices", links: [{ title: "Tariffs move", url: "https://news.test/a" }] },
    ]);
    expect(queries).toEqual(["Energy prices"]);
    expect(notices).toEqual([`Your day: ${headline(card as NonNullable<typeof card>)}`]);
    expect(notices[0]).toBe(
      "Your day: 1 note from yesterday, 1 result to review, 1 run that failed, news on 1 followed topic",
    );
  });

  it("waits quietly when it is first written long after its time", async () => {
    const { host, notices } = fakeHost();
    await note(host, "Client call", "Notes", YESTERDAY);
    await saveBrief(host, { enabled: true, atMinute: 7 * 60, topics: [] });
    const stored = await briefTick(host, new Date(2026, 9, 8, 11, 30));
    expect(stored?.status).toBe("quiet");
    expect(notices).toEqual([]);
  });

  it("prepares today's card on demand without announcing it", async () => {
    const { host, notices } = fakeHost();
    await note(host, "Client call", "Notes", YESTERDAY);
    const stored = await prepareBrief(host, MORNING);
    expect(stored?.status).toBe("quiet");
    expect(notices).toEqual([]);
    await saveBrief(host, { enabled: true, atMinute: 7 * 60, topics: [] });
    expect(await briefTick(host, MORNING)).toBe(null);
  });
});
