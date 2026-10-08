// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agendaOf,
  cardId,
  deviceCards,
  eventsOfDay,
} from "../../website/src/client/assignments/agenda";
import { compose, DEFAULT_BRIEF, prepareBrief } from "../../website/src/client/assignments/brief";
import { forgetLiveRuns } from "../../website/src/client/assignments/runner";
import { ASSIGNMENTS } from "../../website/src/client/assignments/words";
import type { Row } from "../../website/src/client/codec";
import { configureRelayTiming } from "../../website/src/client/connectors/relay";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { ACCOUNT, BROWSER, fakeHost } from "./website-assignments-fakes";
import { FakeJournal } from "./website-client-fakes";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  forgetLiveRuns();
  configureRelayTiming({});
  vi.unstubAllGlobals();
});

const MAC = "0192f000-0000-7000-8000-000000000ac0";
/** A local morning: 8 October 2026, 7:45. */
const MORNING = new Date(2026, 9, 8, 7, 45);
const at = (hour: number, minute = 0) => new Date(2026, 9, 8, hour, minute).toISOString();

function world() {
  const journal = new FakeJournal();
  const key = new Uint8Array(32).fill(7);
  const mac = new SyncClient(ACCOUNT.id, key, memoryClientStore(), journal.transport());
  const { host } = fakeHost({ journal });
  return { journal, mac, host };
}

describe("the agenda line the web computes", () => {
  it("counts and picks the meeting the way Rust does", () => {
    for (const vector of ASSIGNMENTS.vectors.agendas)
      expect(agendaOf(vector.events, vector.now)).toEqual(vector.agenda);
  });

  it("names a device's card the way Rust does", async () => {
    for (const vector of ASSIGNMENTS.vectors.cardIds)
      expect(await cardId(vector.device, vector.day)).toBe(vector.id);
  });

  it("reads today's entries from Google's and Microsoft's events", () => {
    const events = eventsOfDay(
      {
        events: [
          { title: "Stand-up", start: at(9) },
          { title: "Holiday", start: "2026-10-08" },
          { title: "Graph lunch", start: new Date(2026, 9, 8, 12).toISOString().replace("Z", "") },
          { title: "Tomorrow", start: new Date(2026, 9, 9, 9).toISOString() },
          { title: "Broken", start: "" },
        ],
      },
      MORNING,
    );
    expect(events.map((event) => [event.title, event.allDay, event.at])).toEqual([
      ["Stand-up", false, "09:00"],
      ["Holiday", true, ""],
      ["Graph lunch", false, "12:00"],
    ]);
    expect(agendaOf(events, Math.floor(MORNING.getTime() / 1000))).toEqual({
      count: 2,
      firstTitle: "Stand-up",
      firstAt: "09:00",
    });
  });
});

describe("the daily brief on the web gets its agenda", () => {
  it("from a Google calendar an app reads for the tab", async () => {
    const { mac, host } = world();
    await mac.write("connector_relays", {
      id: crypto.randomUUID(),
      device_id: MAC,
      device_name: "computer",
      connector_id: "google",
      connector_name: "Google",
      tools: JSON.stringify([{ name: "calendar_list", readOnly: true, rule: "allow" }]),
      updated_at: at(7),
    });
    await mac.flush();
    await host.sync.pull();
    const asked: Row[] = [];
    configureRelayTiming({
      pollMs: 1,
      waitMs: 50,
      async sleep() {
        await mac.pull();
        for (const object of mac.rows("connector_errands")) {
          if (object.row.state !== "requested") continue;
          asked.push(object.row);
          await mac.write("connector_errands", {
            ...object.row,
            state: "done",
            result: JSON.stringify({
              text: "2 events",
              links: [],
              isError: false,
              structured: {
                events: [
                  { title: "Stand-up", start: at(9) },
                  { title: "Review", start: at(14) },
                ],
              },
            }),
          });
        }
        await mac.flush();
      },
    });
    const card = await compose(host, DEFAULT_BRIEF, MORNING);
    expect(asked[0]).toMatchObject({ tool: "calendar_list", device_id: MAC });
    expect(JSON.parse(String(asked[0].arguments))).toEqual({ days: 1 });
    expect(card.agenda).toEqual({ count: 2, firstTitle: "Stand-up", firstAt: "09:00" });
    expect(card.agendaFrom).toBeNull();
  });

  it("from the card a device composed this morning, and files its own", async () => {
    const { mac, host } = world();
    await mac.write("daily_brief_cards", {
      id: await cardId(MAC, "2026-10-08"),
      day: "2026-10-08",
      device_id: MAC,
      device_name: "phone",
      card: JSON.stringify({
        day: "2026-10-08",
        createdAt: at(7, 30),
        agenda: { count: 3, firstTitle: "Dentist", firstAt: "08:30" },
        notes: [],
        reviews: [],
        failures: [],
        topics: [],
      }),
      status: "delivered",
      created_at: at(7, 30),
      updated_at: at(7, 30),
    });
    await mac.flush();
    await host.sync.pull();
    expect(deviceCards(host, "2026-10-08")[0]).toMatchObject({ deviceName: "phone" });
    const stored = await prepareBrief(host, MORNING);
    expect(stored?.card.agenda).toEqual({ count: 3, firstTitle: "Dentist", firstAt: "08:30" });
    expect(stored?.card.agendaFrom).toBe("phone");
    expect(stored?.status).toBe("quiet");
    // This browser's card travels too, as the app's do.
    const own = host.sync.object("daily_brief_cards", await cardId(BROWSER, "2026-10-08"));
    expect(own?.row).toMatchObject({ device_id: BROWSER, device_name: "browser", status: "quiet" });
    expect(deviceCards(host, "2026-10-08"), "its own card is not shown as another's").toHaveLength(
      1,
    );
  });

  it("is left out when nothing can add it", async () => {
    const { host } = world();
    const card = await compose(host, DEFAULT_BRIEF, MORNING);
    expect(card.agenda).toBeNull();
  });
});
