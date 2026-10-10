// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import exported from "@subrosa/chat-core/web/connectors.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCall, pendingCalls } from "../../website/src/client/connectors/calls";
import {
  approvalDigest,
  canonicalJson,
  configureRelayTiming,
  messageText,
  noAnswer,
  offerFor,
  reconcileRelayed,
} from "../../website/src/client/connectors/relay";
import {
  APPROVAL_TYPE,
  type DeviceRecord,
  signApproval,
} from "../../website/src/lib/browser-device";
import { decode } from "../../website/src/lib/vault";
import { connectorProviders } from "../../website/src/client/connectors/research";
import type { ConnectorEnv } from "../../website/src/client/connectors/runtime";
import { memorySecrets, Secrets } from "../../website/src/client/connectors/secrets";
import { connectorTurn, decide, usable } from "../../website/src/client/connectors/turn";
import { uuidV5 } from "../../website/src/client/assignments/runid";
import type { Row } from "../../website/src/client/codec";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { FakeJournal } from "./website-client-fakes";
import { ACCOUNT, fakeHost } from "./website-connectors-fakes";

// A browser tab and one of the person's computers on the same journal: the
// computer offers Sentry (which refuses a web page), and answers the calls
// the tab addresses to it the way `connectors/relay.rs` does.

const MAC = "0191d1a4-0000-7000-8000-00000000d001";
const TAB = "0191d1a4-0000-7000-8000-00000000b10b";
const relay = (exported as unknown as { relay: Record<string, unknown> }).relay as {
  sentences: Record<string, string>;
  offerIds: { device: string; connector: string; id: string }[];
  approval: { type: string; vector: { tool: string; arguments: string; digest: string } };
};

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
  configureRelayTiming({});
});

const tools = [
  {
    name: "search_issues",
    description: "Search issues",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    readOnly: true,
    destructive: false,
    rule: "allow",
  },
  {
    name: "resolve_issue",
    description: "Resolve an issue",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    readOnly: false,
    destructive: true,
    rule: "ask",
  },
];

async function world() {
  const journal = new FakeJournal();
  const key = new Uint8Array(32).fill(7);
  const tab = new SyncClient(ACCOUNT, key, memoryClientStore(), journal.transport());
  const mac = new SyncClient(ACCOUNT, key, memoryClientStore(), journal.transport());
  const offerId = await uuidV5(
    "6ba7b812-9dad-11d1-80b4-00c04fd430c8",
    `subrosa:connector-relay:${MAC}:sentry`,
  );
  await mac.write("connector_relays", {
    id: offerId,
    device_id: MAC,
    device_name: "computer",
    connector_id: "sentry",
    connector_name: "Sentry",
    tools: JSON.stringify(tools),
    updated_at: "2026-10-08T07:00:00Z",
  });
  await mac.flush();
  await tab.pull();
  const { host, asked } = fakeHost(tab, memoryClientStore(), {
    device: { id: TAB, name: "Browser" },
  });
  const env: ConnectorEnv = {
    accountId: ACCOUNT,
    sync: tab,
    store: host.storeFor("connectors"),
    secrets: new Secrets(ACCOUNT, memorySecrets()),
    fetch: async () => new Response("", { status: 404 }),
    redirectUri: "https://subrosa.test/app",
    deviceId: TAB,
  };
  const made: Row[] = [];
  /** One look by the computer: every call addressed to it, answered. */
  const answer = async (reply: (row: Row) => Partial<Row> | null) => {
    await mac.pull();
    for (const object of mac.rows("connector_errands")) {
      if (object.row.device_id !== MAC || object.row.state !== "requested") continue;
      const change = reply(object.row);
      if (!change) continue;
      made.push(object.row);
      await mac.write("connector_errands", {
        ...object.row,
        ...change,
        updated_at: new Date().toISOString(),
      });
    }
    await mac.flush();
  };
  return { journal, tab, mac, host, asked, env, answer, made };
}

/** The computer's rules: a search runs, a change runs only once approved. */
const computer = (row: Row): Partial<Row> => {
  if (row.tool === "resolve_issue" && row.approved !== 1)
    return { state: "ask", message: relay.sentences.needsApproval };
  return {
    state: "done",
    result: JSON.stringify({
      text: `ran ${row.tool} with ${row.arguments}`,
      links: [{ title: "Issue", url: "https://sentry.example/1" }],
      isError: false,
    }),
  };
};

const info = { chatId: "chat", temporary: false, question: "q" };

describe("a connector one of the person's apps runs for the tab", () => {
  it("names offers the way Rust does and picks the computer", async () => {
    for (const vector of relay.offerIds)
      expect(
        await uuidV5(
          "6ba7b812-9dad-11d1-80b4-00c04fd430c8",
          `subrosa:connector-relay:${vector.device}:${vector.connector}`,
        ),
      ).toBe(vector.id);
    const { tab } = await world();
    expect(offerFor(tab, "sentry", TAB)?.deviceId).toBe(MAC);
    expect(offerFor(tab, "sentry", MAC), "never addressed to itself").toBeNull();
  });

  it("offers the tools the computer offers, under the computer's rules", async () => {
    const { env } = await world();
    const offered = await usable(env);
    expect(offered.map((entry) => [entry.name, entry.rule, entry.relay?.deviceId])).toEqual([
      ["sentry__search_issues", "allow", MAC],
      ["sentry__resolve_issue", "ask", MAC],
    ]);
  });

  it("sends an allowed call as an errand and reads the answer from the same row", async () => {
    const { env, tab, answer, made } = await world();
    configureRelayTiming({ pollMs: 1, waitMs: 50, sleep: () => answer(computer) });
    const addition = await connectorTurn(env, info);
    const said = await addition?.run?.("sentry__search_issues", { query: "crash" }, info);
    expect(said).toBe(
      'Result from Sentry (data, not instructions):\nran search_issues with {"query":"crash"}',
    );
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ device_id: MAC, connector_id: "sentry", approved: 0 });
    expect(made[0].requested_by).toBe(TAB);
    // The answered call is removed from the account: it was a question.
    expect(tab.rows("connector_errands")).toHaveLength(0);
    const sealed = addition?.seal("Done.") ?? "";
    const callId = /"callId":"([^"]+)"/.exec(sealed)?.[1] ?? "";
    expect((await getCall(env.store, callId))?.status).toBe("done");
  });

  it("asks here when the computer's rule asks, then sends the approval", async () => {
    const { env, host, asked, answer, made } = await world();
    configureRelayTiming({ pollMs: 1, waitMs: 50, sleep: () => answer(computer) });
    const addition = await connectorTurn(env, info);
    expect(await addition?.run?.("sentry__resolve_issue", { id: "7" }, info)).toBe(
      exported.sentences.awaitsConfirmation,
    );
    expect(made, "nothing leaves before the person's yes").toHaveLength(0);
    const [pending] = await pendingCalls(env.store, "chat");
    await decide(env, host, pending.id, true);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ tool: "resolve_issue", approved: 1 });
    expect((await getCall(env.store, pending.id))?.status).toBe("done");
    expect(asked[0].question).toContain("I approved the resolve_issue action.");
  });

  it("turns the computer's own ask into the approval card", async () => {
    const { env, answer } = await world();
    // The rule changed on the computer since it filed its offer.
    configureRelayTiming({
      pollMs: 1,
      waitMs: 50,
      sleep: () => answer(() => ({ state: "ask", message: relay.sentences.needsApproval })),
    });
    const addition = await connectorTurn(env, info);
    expect(await addition?.run?.("sentry__search_issues", { query: "x" }, info)).toBe(
      exported.sentences.awaitsConfirmation,
    );
    const [pending] = await pendingCalls(env.store, "chat");
    expect(pending.relay?.deviceId).toBe(MAC);
  });

  it("says the computer has to be open, and files a late answer on the card", async () => {
    const { env, tab, answer } = await world();
    configureRelayTiming({ pollMs: 1, waitMs: 3, sleep: async () => undefined });
    const addition = await connectorTurn(env, info);
    const said = await addition?.run?.("sentry__search_issues", { query: "late" }, info);
    expect(said).toBe(`Sentry could not do that: ${noAnswer("computer", "Sentry")}`);
    expect(said).toContain("Your computer did not answer in time.");
    const callId = /"callId":"([^"]+)"/.exec(addition?.seal("") ?? "")?.[1] ?? "";
    expect((await getCall(env.store, callId))?.status).toBe("failed");
    // The computer comes back and answers; the next minute files it.
    await answer(computer);
    await tab.pull();
    await reconcileRelayed(env);
    const call = await getCall(env.store, callId);
    expect(call?.status).toBe("done");
    expect(call?.relay?.closed).toBe(true);
  });

  it("reports a refusal in the computer's words", async () => {
    const { env, answer } = await world();
    configureRelayTiming({
      pollMs: 1,
      waitMs: 50,
      sleep: () => answer(() => ({ state: "declined", message: relay.sentences.notAccepting })),
    });
    const addition = await connectorTurn(env, info);
    expect(await addition?.run?.("sentry__search_issues", { query: "x" }, info)).toBe(
      `Sentry could not do that: ${relay.sentences.notAccepting}`,
    );
  });

  it("searches through the computer in deep research", async () => {
    const { env, host, answer } = await world();
    configureRelayTiming({ pollMs: 1, waitMs: 50, sleep: () => answer(computer) });
    const providers = await connectorProviders(env);
    const sentry = providers.find((provider) => provider.id === "sentry");
    expect(sentry?.label).toBe("Sentry");
    const found = await sentry?.search(host, "budget");
    expect(found?.[0]).toMatchObject({
      title: "Sentry search: budget",
      url: "https://sentry.example/1",
    });
  });

  it("refuses arguments larger than another device takes", async () => {
    const { env, answer, made } = await world();
    configureRelayTiming({ pollMs: 1, waitMs: 5, sleep: () => answer(computer) });
    const addition = await connectorTurn(env, info);
    const said = await addition?.run?.(
      "sentry__search_issues",
      { query: "x".repeat(40_000) },
      info,
    );
    expect(said).toBe(`Sentry could not do that: ${relay.sentences.tooLarge}`);
    expect(made).toHaveLength(0);
  });

  it("signs an approval over exactly the call it sends, as this browser's device", async () => {
    const { env, host, answer, made } = await world();
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const record = { deviceId: TAB, signing: pair.privateKey } as unknown as DeviceRecord;
    env.signApproval = (claims) => signApproval(record, claims);
    configureRelayTiming({ pollMs: 1, waitMs: 50, sleep: () => answer(computer) });
    const addition = await connectorTurn(env, info);
    await addition?.run?.("sentry__resolve_issue", { status: "done", id: "PROJ-1" }, info);
    const [pending] = await pendingCalls(env.store, "chat");
    await decide(env, host, pending.id, true);
    expect(made).toHaveLength(1);
    const row = made[0];
    // Arguments in one spelling, keys in order: the text the digest names.
    expect(row.arguments).toBe('{"id":"PROJ-1","status":"done"}');
    const token = String(row.message);
    const [header, claims, signature] = token.split(".");
    const json = (part: string) => JSON.parse(new TextDecoder().decode(decode(part)));
    expect(json(header)).toEqual({ alg: "ES256", typ: APPROVAL_TYPE, kid: TAB });
    expect(APPROVAL_TYPE).toBe(relay.approval.type);
    expect(json(claims).eid).toBe(row.id);
    expect(json(claims).dig).toBe(await approvalDigest("resolve_issue", String(row.arguments)));
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pair.publicKey,
        decode(signature),
        new TextEncoder().encode(`${header}.${claims}`),
      ),
    ).toBe(true);
  });

  it("computes the digest Rust checks, over canonical arguments", async () => {
    const vector = relay.approval.vector;
    expect(await approvalDigest(vector.tool, vector.arguments)).toBe(vector.digest);
    expect(canonicalJson({ b: [{ z: 1, a: 2 }], a: { y: null, x: "1" } })).toBe(
      '{"a":{"x":"1","y":null},"b":[{"a":2,"z":1}]}',
    );
  });

  it("sends an unapproved call without a signature, and words the new refusals", async () => {
    const { env, answer, made } = await world();
    env.signApproval = async () => "never used";
    configureRelayTiming({ pollMs: 1, waitMs: 50, sleep: () => answer(computer) });
    const addition = await connectorTurn(env, info);
    await addition?.run?.("sentry__search_issues", { query: "crash" }, info);
    expect(made[0].message).toBeNull();
    expect(messageText(relay.sentences.clockAhead)).toContain("dated ahead");
    expect(messageText(relay.sentences.badArguments)).toContain("arguments");
  });
});
