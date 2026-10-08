// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
// @ts-expect-error node:fs is available in the Vitest runtime.
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addConnector,
  connectorFor,
  getConnector,
  listConnectors,
  removeConnector,
  setToolRule,
} from "../../website/src/client/connectors/store";
import { connectorObjectId } from "../../website/src/client/object-ids";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import type { Change } from "../../website/src/lib/api";
import { decode, encode } from "../../website/src/lib/vault";
import { FakeJournal } from "./website-client-fakes";
import { ACCOUNT } from "./website-connectors-fakes";

// A connector's definition travels under a UUID derived from its id: the
// service refuses any other object id (ADR-0092 addendum).
const FIXTURE = "src-tauri/tests/fixtures/web-client-connectors-v1.json";
const key = () => new Uint8Array(32).fill(9);

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe("a connector's object", () => {
  it("is the UUID Rust derives from the id (`connectors::object_id`)", async () => {
    expect(await connectorObjectId("sentry")).toBe("30d6d457-5215-5277-8982-cdf85fe0357b");
    expect(await connectorObjectId("github")).toBe("e102780d-6272-5361-a478-76b2594a99b2");
    expect(await connectorObjectId("my_server-a1b2c3")).toBe(
      "8f16ae94-67db-5fcb-8c30-3b9e91299e73",
    );
  });

  it("reaches the service and another browser, its revisions chained, its id kept", async () => {
    const journal = new FakeJournal();
    const sync = new SyncClient(ACCOUNT, key(), memoryClientStore(), journal.transport());
    await addConnector(sync, connectorFor({ catalogId: "sentry" }));
    await sync.flush();
    await setToolRule(sync, "sentry", "search_issues", "ask");
    await sync.flush();
    expect(sync.failedCount).toBe(0);
    const object = await connectorObjectId("sentry");
    expect(journal.pushes.map((push) => push.object_id)).toEqual([object, object]);
    expect(journal.pushes[1].parent_revision).toBe(journal.changes[0].revision);

    const reader = new SyncClient(ACCOUNT, key(), memoryClientStore(), journal.transport());
    await reader.pull();
    expect(getConnector(reader, "sentry")).toMatchObject({
      id: "sentry",
      toolPolicy: { search_issues: "ask" },
    });
    expect(reader.conflicts.size).toBe(0);

    await removeConnector(reader, "sentry");
    await reader.flush();
    expect(journal.pushes.at(-1)).toMatchObject({ object_id: object, deleted: true });
    await sync.pull();
    expect(listConnectors(sync)).toEqual([]);
  });

  it("sends again, under the UUID, a write the service refused under the old id", async () => {
    const journal = new FakeJournal();
    const store = memoryClientStore();
    const before = new SyncClient(ACCOUNT, key(), store, {
      ...journal.transport(),
      push: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await addConnector(before, connectorFor({ catalogId: "linear" }));
    // What a tab queued before the object id was derived: the connector's
    // own id as the object, refused by the service.
    const [entry] = await store.list<Record<string, unknown>>("outbox", `${ACCOUNT}:`);
    const key0 = `${ACCOUNT}:${String(entry.sequence).padStart(12, "0")}`;
    await store.put("outbox", key0, { ...entry, objectId: "linear", failed: "invalid_request" });

    const after = new SyncClient(ACCOUNT, key(), store, journal.transport());
    await after.load();
    expect(getConnector(after, "linear")?.name).toBe("Linear");
    expect(after.failedCount).toBe(0);
    await after.flush();
    expect(journal.pushes.map((push) => push.object_id)).toEqual([
      await connectorObjectId("linear"),
    ]);
    expect(after.pendingCount).toBe(0);
  });

  it("matches the committed fixture the Rust apply test reads", async () => {
    // @ts-expect-error process is available in the Vitest runtime.
    if (process.env.SUBROSA_WRITE_WEB_FIXTURE) {
      const journal = new FakeJournal();
      const sync = new SyncClient(ACCOUNT, key(), memoryClientStore(), journal.transport());
      await addConnector(sync, connectorFor({ catalogId: "sentry" }));
      await setToolRule(sync, "sentry", "search_issues", "deny");
      const custom = connectorFor({ name: "Team wiki", url: "https://wiki.example.com/mcp" });
      await addConnector(sync, { ...custom, id: "team_wiki-a1b2c3" });
      await sync.flush();
      writeFileSync(
        FIXTURE,
        `${JSON.stringify({ account: ACCOUNT, key: encode(key()), changes: journal.changes }, null, 2)}\n`,
      );
      return;
    }
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8") as string) as {
      account: string;
      key: string;
      changes: Change[];
    };
    for (const change of fixture.changes) expect(change.object_id).toMatch(/^[0-9a-f-]{36}$/);
    const reader = new SyncClient(fixture.account, decode(fixture.key), memoryClientStore(), {
      pull: async (kind) => ({
        changes: fixture.changes.filter((change) => change.kind === kind),
        cursor: fixture.changes.length,
      }),
      push: async () => ({ results: [] }),
    });
    await reader.pull();
    expect(listConnectors(reader).map((connector) => connector.id)).toEqual([
      "sentry",
      "team_wiki-a1b2c3",
    ]);
    expect(getConnector(reader, "sentry")?.toolPolicy).toEqual({ search_issues: "deny" });
  });
});
