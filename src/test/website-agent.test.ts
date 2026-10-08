// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_SECTION,
  DEFAULT_PERSONALIZATION,
  offeredTools,
  personalizationBlock,
  runTurn,
  type TurnContext,
} from "../../website/src/client/agent";
import { streamCompletion } from "../../website/src/client/carpe-diem";
import { AGENT_LITE } from "../../website/src/client/codec";
import { spokenReply } from "../../website/src/client/export";
import { createNote, listNotes, type Message, remember } from "../../website/src/client/library";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { FakeJournal, fakeOperator, text, toolCall } from "./website-client-fakes";

const ACCOUNT = "0191d1a4-0000-7000-8000-00000000a11c";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

function client() {
  return new SyncClient(
    ACCOUNT,
    new Uint8Array(32).fill(3),
    memoryClientStore(),
    new FakeJournal().transport(),
  );
}
const question = (content: string): Message => ({
  id: crypto.randomUUID(),
  taskId: "t",
  role: "user",
  content,
  createdAt: new Date().toISOString(),
});

function context(
  sync: SyncClient,
  operator: TurnContext["operator"],
  over: Partial<TurnContext> = {},
) {
  const shown: string[] = [];
  return {
    shown,
    context: {
      sync,
      operator,
      key: "cdm_test",
      model: "zai-org-glm-5-2",
      memory: true,
      personalization: DEFAULT_PERSONALIZATION,
      temporary: false,
      onText: (fragment: string) => shown.push(fragment),
      ...over,
    } satisfies TurnContext,
  };
}

describe("the web client's agent loop", () => {
  it("sends agent-lite's own prompt and tools, then runs a note search", async () => {
    const sync = client();
    await createNote(sync, "Tuesday", "We decided to ship on Monday.");
    await remember(sync, "Prefers short answers.");
    let round = 0;
    const { operator, calls } = fakeOperator(() =>
      round++ === 0 ? toolCall("search_notes", { query: "ship" }) : text("You ship on Monday."),
    );
    const { context: turn, shown } = context(sync, operator);
    const result = await runTurn(turn, [question("When do we ship?")]);
    expect(result.answer).toBe("You ship on Monday.");
    expect(shown.join("")).toBe("You ship on Monday.");
    expect(result.memories.map((memory) => memory.text)).toEqual(["Prefers short answers."]);

    const first = calls[0].body as {
      messages: { role: string; content: string }[];
      tools: unknown[];
    };
    expect(calls[0].path).toBe("/v1/chat/completions");
    expect(first.messages[0].content.startsWith(AGENT_LITE.systemPrompt)).toBe(true);
    expect(first.messages[0].content).toContain(AGENT_LITE.memoryBlockHeader);
    expect(first.messages[0].content).toContain("- Prefers short answers.");
    expect(first.messages[0].content.endsWith(BROWSER_SECTION)).toBe(true);
    expect(
      (first.tools as { function: { name: string } }[]).map((tool) => tool.function.name),
    ).toContain("search_notes");
    const second = calls[1].body as { messages: { role: string; content: string }[] };
    const tool = second.messages.find((message) => message.role === "tool");
    expect(JSON.parse(tool?.content ?? "[]")[0]).toMatchObject({ title: "Tuesday", kind: "note" });
  });

  it("writes a note the model asks for as a synchronised note", async () => {
    const sync = client();
    let round = 0;
    const { operator } = fakeOperator(() =>
      round++ === 0
        ? toolCall("create_note", { title: "Groceries", content: "- Bread\n- Milk" })
        : text("Saved."),
    );
    const { context: turn } = context(sync, operator);
    const result = await runTurn(turn, [question("Write my grocery list down")]);
    expect(result.notesWritten).toHaveLength(1);
    expect(listNotes(sync)[0]).toMatchObject({ title: "Groceries", body: "- Bread\n- Milk" });
    expect(sync.pendingCount).toBe(1);
  });

  it("offers a temporary chat no tool that writes", () => {
    const names = offeredTools(true, true).map((tool) => tool.function.name);
    expect(names).not.toContain("create_note");
    expect(names).not.toContain("append_to_note");
    expect(names).not.toContain("remember");
    expect(offeredTools(false, false).map((tool) => tool.function.name)).not.toContain(
      "search_memories",
    );
  });

  it("answers from what it found once the research budget is spent", async () => {
    const sync = client();
    const bodies: Record<string, unknown>[] = [];
    const { operator } = fakeOperator((body) => {
      bodies.push(body);
      return body.tool_choice === "none"
        ? text("Here is what I found.")
        : toolCall("search_notes", { query: "x" });
    });
    const { context: turn } = context(sync, operator);
    const result = await runTurn(turn, [question("Keep searching")]);
    expect(result.answer).toBe("Here is what I found.");
    expect(bodies).toHaveLength(AGENT_LITE.limits.maxToolRounds + 1);
    const last = bodies.at(-1) as { messages: { content: string }[] };
    expect(last.messages.at(-1)?.content).toBe(AGENT_LITE.finalAnswerNudge);
  });

  it("stops when asked, and refuses a reply cut off mid-stream", async () => {
    const sync = client();
    const controller = new AbortController();
    const { operator } = fakeOperator(() => text("never"));
    const aborting = {
      ...operator,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        controller.abort();
        if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return operator.fetch(input, init);
      },
    };
    const { context: turn } = context(sync, aborting, { signal: controller.signal });
    await expect(runTurn(turn, [question("Hello")])).rejects.toThrow();

    const cut = {
      root: "https://operator.test",
      fetch: async () =>
        new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Half" } }] })}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    };
    await expect(streamCompletion(cut, "cdm_test", {}, () => undefined)).rejects.toMatchObject({
      code: "reply_cut_off",
    });
  });

  it("renders personalization in the app's words and reads cards aloud by name", () => {
    expect(personalizationBlock(DEFAULT_PERSONALIZATION)).toBeNull();
    const block = personalizationBlock({
      ...DEFAULT_PERSONALIZATION,
      aboutYou: "I teach.",
      personality: "efficient",
    });
    expect(block).toBe(
      `${AGENT_LITE.personalization.header}${AGENT_LITE.personalization.about}I teach.\n${AGENT_LITE.personalization.personality}${AGENT_LITE.personalization.personalities.efficient}\n`,
    );
    expect(spokenReply('Look.\n```subrosa:links\n{"v":1}\n```')).toBe(
      "Look.\nThere are links here.",
    );
  });
});
