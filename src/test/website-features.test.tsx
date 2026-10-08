// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PERSONALIZATION, runTurn, turnTools } from "../../website/src/client/agent";
import {
  knownTables,
  pulledKinds,
  registerTables,
  tablesFingerprint,
} from "../../website/src/client/codec";
import {
  type BlockProps,
  featureStore,
  type FeatureHost,
  OPEN_GUARDS,
  type TurnAddition,
  type WebFeature,
} from "../../website/src/client/feature";
import { messagesOf, type Message } from "../../website/src/client/library";
import { catalogChatModels } from "../../website/src/client/models";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { picturesAddition, visionModelFor } from "../../website/src/client/attachments";
import { WebClient } from "../../website/src/client/ui/WebClient";
import { prepareObject } from "../../website/src/lib/vault";
import { FakeJournal, fakeOperator, text, toolCall } from "./website-client-fakes";

const ACCOUNT = {
  id: "0191d1a4-0000-7000-8000-00000000a11c",
  email: "a@example.test",
  created_at: "",
};
const KEY = () => new Uint8Array(32).fill(7);

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const question = (content: string): Message => ({
  id: crypto.randomUUID(),
  taskId: "t",
  role: "user",
  content,
  createdAt: new Date().toISOString(),
});

/** A revision another device wrote, sealed the way the app seals it. */
async function foreign(
  journal: FakeJournal,
  kind: string,
  table: string,
  row: Record<string, unknown>,
) {
  const body = await prepareObject(KEY(), ACCOUNT.id, String(row.id), kind, table, row, null);
  const [operation] = JSON.parse(body).operations;
  journal.accept(operation);
}

describe("a feature's sealed store", () => {
  it("keeps only ciphertext and lists by prefix", async () => {
    const store = memoryClientStore();
    const research = featureStore(ACCOUNT.id, KEY(), store, "research");
    await research.put("run:b", { question: "Second" });
    await research.put("run:a", { question: "First, about my salary" });
    await research.put("other", 1);
    const raw = JSON.stringify([...(store.areas.get("local")?.values() ?? [])]);
    expect(raw).not.toContain("salary");
    expect((await research.list<{ question: string }>("run:")).map((entry) => entry.id)).toEqual([
      "run:a",
      "run:b",
    ]);
    expect(await research.get("run:a")).toEqual({ question: "First, about my salary" });
    // Another feature, or another key, reads nothing.
    expect(await featureStore(ACCOUNT.id, KEY(), store, "study").get("run:a")).toBeUndefined();
    expect(
      await featureStore(ACCOUNT.id, new Uint8Array(32).fill(1), store, "research").get("run:a"),
    ).toBeUndefined();
    await research.delete("run:a");
    expect(await research.get("run:a")).toBeUndefined();
  });
});

describe("tables a feature registers", () => {
  it("are skipped unread until registered, then read from the start", async () => {
    const journal = new FakeJournal();
    const store = memoryClientStore();
    const sync = new SyncClient(ACCOUNT.id, KEY(), store, journal.transport());
    const run = {
      id: "0192f000-0000-7000-8000-0000000000aa",
      assignment_id: "a",
      slot: "2026-10-08T07:00:00Z",
    };
    // A table no feature registers yet (a later build's), then registered.
    await foreign(journal, "artifact", "lab_runs", run);
    await foreign(journal, "artifact", "audio_artifacts", {
      id: "0192f000-0000-7000-8000-0000000000bb",
    });
    await foreign(journal, "folder", "health_days", {
      id: "0192f000-0000-7000-8000-0000000000cc",
    });
    // An unknown table of a pulled kind does not stop the pull.
    await sync.pull();
    expect(sync.objects.has(run.id)).toBe(false);
    const before = tablesFingerprint("artifact");

    registerTables({
      lab_runs: { kind: "artifact", columns: ["id", "assignment_id", "slot"] },
      // The chat's own tables are never redefined.
      notes: { kind: "artifact", columns: ["id"] },
    });
    expect(knownTables().notes.kind).toBe("note");
    expect(pulledKinds()).toContain("artifact");
    expect(tablesFingerprint("artifact")).not.toBe(before);
    await sync.pull();
    expect(sync.rows("lab_runs").map((object) => object.row)).toEqual([run]);
    // The other artifact table is still left alone.
    expect(sync.objects.has("0192f000-0000-7000-8000-0000000000bb")).toBe(false);
  });
});

describe("a turn with features", () => {
  it("offers their tools, joins their words, routes their calls and shapes the messages", async () => {
    const sync = new SyncClient(
      ACCOUNT.id,
      KEY(),
      memoryClientStore(),
      new FakeJournal().transport(),
    );
    const ran: string[] = [];
    const addition: TurnAddition = {
      tools: [
        {
          type: "function",
          function: { name: "make_thing", description: "Makes a thing.", parameters: {} },
        },
      ],
      prompt: "Thing mode is on.",
      run: async (name, args, turn) => {
        if (name !== "make_thing") return undefined;
        ran.push(`${turn.question}:${String(args.size)}`);
        return "Made.";
      },
    };
    let round = 0;
    const { operator, calls } = fakeOperator(() =>
      round++ === 0 ? toolCall("make_thing", { size: 3 }) : text("Done."),
    );
    const result = await runTurn(
      {
        sync,
        operator,
        key: "cdm_test",
        model: "zai-org-glm-5-2",
        memory: false,
        personalization: DEFAULT_PERSONALIZATION,
        temporary: false,
        additions: [addition, picturesAddition(["data:image/jpeg;base64,AAAA"])],
        promptBlocks: ["Protected words."],
        onText: () => undefined,
      },
      [question("Make one")],
    );
    expect(result.answer).toBe("Done.");
    expect(ran).toEqual(["Make one:3"]);
    const first = calls[0].body as {
      messages: { role: string; content: unknown }[];
      tools: { function: { name: string } }[];
    };
    expect(first.tools.map((tool) => tool.function.name)).toContain("make_thing");
    const system = String(first.messages[0].content);
    expect(system.indexOf("Thing mode is on.")).toBeGreaterThan(0);
    expect(system.indexOf("Protected words.")).toBeGreaterThan(system.indexOf("Thing mode"));
    expect(first.messages[1].content).toEqual([
      { type: "text", text: "Make one" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
    ]);
  });

  it("narrows the tools to what the turn allows, each named once", () => {
    const sync = new SyncClient(
      ACCOUNT.id,
      KEY(),
      memoryClientStore(),
      new FakeJournal().transport(),
    );
    const twice: TurnAddition = {
      tools: [
        { type: "function", function: { name: "web_search", description: "", parameters: {} } },
      ],
    };
    const names = turnTools({
      sync,
      operator: fakeOperator(() => []).operator,
      key: "",
      model: "",
      memory: true,
      personalization: DEFAULT_PERSONALIZATION,
      temporary: false,
      additions: [twice],
      allowTool: (name) => name === "web_search" || name === "search_notes",
      onText: () => undefined,
    }).map((tool) => tool.function.name);
    expect(names.sort()).toEqual(["search_notes", "web_search"]);
  });
});

describe("the web client with features", () => {
  it("starts them first, shows their panels, blocks and controls, and obeys their guards", async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    let host: FeatureHost | null = null;
    const Block = ({ payload }: BlockProps) => <p>Drawn {String(payload.word)}</p>;
    const feature: WebFeature = {
      id: "demo",
      label: () => "Demo",
      Panel: ({ host: given }) => {
        host = given;
        return <p>Demo panel</p>;
      },
      ComposerControl: ({ setDraft }) => (
        <button type="button" onClick={() => setDraft("From the control")}>
          Fill
        </button>
      ),
      blocks: { demo: Block },
      async start(given) {
        order.push("start");
        given.setGuards({
          ...OPEN_GUARDS,
          on: true,
          models: (models) => models.filter((model) => !model.id.includes("uncensored")),
          chatRefusal: (model) => (model === "refused-model" ? "Not this model." : null),
        });
      },
      turn: () => ({ tools: [], prompt: "Demo words." }),
      tick: async () => {
        order.push("tick");
      },
    };
    const journal = new FakeJournal();
    const { operator, calls } = fakeOperator(() =>
      text('Here:\n\n```subrosa:demo\n{"word":"hello"}\n```'),
    );
    render(
      <WebClient
        account={ACCOUNT}
        vaultKey={KEY()}
        openKey={async () => "cdm_test"}
        operator={operator}
        store={memoryClientStore()}
        transport={journal.transport()}
        features={[feature]}
        device={{ id: "dev-1", name: "Browser" }}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Fill" }));
    expect(screen.getByLabelText("Message")).toHaveValue("From the control");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Drawn hello")).toBeInTheDocument();
    expect(order[0]).toBe("start");
    await waitFor(() => expect(order).toContain("tick"));
    const sent = calls.find((call) => call.path === "/v1/chat/completions")?.body as {
      messages: { content: string }[];
    };
    expect(sent.messages[0].content).toContain("Demo words.");

    await user.click(screen.getByRole("button", { name: "Demo" }));
    expect(await screen.findByText("Demo panel")).toBeInTheDocument();
    expect(host).not.toBeNull();
    const shown = host as unknown as FeatureHost;
    expect(shown.device).toEqual({ id: "dev-1", name: "Browser" });

    // A feature's own turn: a background question in a new chat.
    const asked = await shown.ask("Background question", { background: true });
    expect(asked.answer).toContain("subrosa:demo");
    expect(messagesOf(shown.sync, asked.chatId).map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    // The guards refuse before anything leaves.
    const before = calls.length;
    await expect(shown.ask("Hi", { model: "refused-model", background: true })).rejects.toThrow(
      "Not this model.",
    );
    expect(calls.length).toBe(before);
    // Everything the turns wrote has reached the journal before the page goes.
    await waitFor(() => expect(shown.sync.pendingCount).toBe(0));
    await shown.sync.flush();
  });

  it("routes a feature's picture the way it routes a photo", async () => {
    let host: FeatureHost | null = null;
    const feature: WebFeature = {
      id: "frames",
      label: () => "Frames",
      Panel: ({ host: given }) => {
        host = given;
        return <p>Frames panel</p>;
      },
    };
    const { operator, calls } = fakeOperator(() => text("A cat."));
    render(
      <WebClient
        account={ACCOUNT}
        vaultKey={KEY()}
        openKey={async () => "cdm_test"}
        operator={operator}
        store={memoryClientStore()}
        transport={new FakeJournal().transport()}
        features={[feature]}
      />,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "Frames" }));
    await screen.findByText("Frames panel");
    const shown = host as unknown as FeatureHost;
    const models = catalogChatModels();
    const seeing = visionModelFor(models, shown.model);
    const frame = "data:image/jpeg;base64,AAAA";
    if (seeing) {
      await shown.ask("What is this?", { images: [frame], background: true });
      const sent = calls.filter((call) => call.path === "/v1/chat/completions").at(-1)?.body as {
        model: string;
        messages: { content: unknown }[];
      };
      expect(sent.model).toBe(seeing);
      expect(sent.messages.at(-1)?.content).toEqual([
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: frame } },
      ]);
    } else {
      await expect(
        shown.ask("What is this?", { images: [frame], background: true }),
      ).rejects.toThrow("No model as private as this one can read pictures.");
    }
    await shown.sync.flush();
  });
});
