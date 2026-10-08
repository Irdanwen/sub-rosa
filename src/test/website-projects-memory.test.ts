// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PERSONALIZATION, runTurn } from "../../website/src/client/agent";
import {
  addReference,
  conversationSnapshot,
  saveAssistant,
  startAssistantChat,
} from "../../website/src/client/assistants";
import { AGENT_LITE } from "../../website/src/client/codec";
import { addMessage, createChat, listChats, messagesOf } from "../../website/src/client/library";
import {
  addMemory,
  allMemories,
  forgetMemory,
  memoriesInScope,
  updateMemory,
} from "../../website/src/client/memories";
import { pastChatsBlock, searchPastChats } from "../../website/src/client/past-chats";
import {
  addProjectFile,
  createProject,
  getProject,
  moveChatToProject,
  projectIdOfChat,
  projectSection,
  saveProjectSettings,
  searchProjectFiles,
} from "../../website/src/client/projects";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { planTurn } from "../../website/src/client/turn-plan";
import { FakeJournal, fakeOperator, text, toolCall } from "./website-client-fakes";

const ACCOUNT = "0191d1a4-0000-7000-8000-00000000a11c";
const key = () => new Uint8Array(32).fill(4);

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

function client() {
  const journal = new FakeJournal();
  return {
    journal,
    sync: new SyncClient(ACCOUNT, key(), memoryClientStore(), journal.transport()),
  };
}

const systemOf = (body: Record<string, unknown>) =>
  ((body.messages as { role: string; content: string }[])[0]?.content ?? "") as string;
const toolNames = (body: Record<string, unknown>) =>
  ((body.tools as { function: { name: string } }[] | undefined) ?? []).map(
    (tool) => tool.function.name,
  );

describe("managing memories from the browser", () => {
  it("adds, edits, pauses and forgets, every change a synchronised write", async () => {
    const { journal, sync } = client();
    expect(await addMemory(sync, "Prefers tea.")).toBe("stored");
    expect(await addMemory(sync, "prefers TEA.")).toBe("known");
    const [memory] = allMemories(sync);
    await updateMemory(sync, memory.id, { text: "Prefers green tea." });
    await sync.flush();
    await updateMemory(sync, memory.id, { disabled: true });
    expect(memoriesInScope(sync, null)).toHaveLength(0);
    expect(allMemories(sync)[0]).toMatchObject({ text: "Prefers green tea.", disabled: true });
    await forgetMemory(sync, memory.id);
    await sync.flush();
    expect(allMemories(sync)).toEqual([]);
    expect(journal.pushes.at(-1)).toMatchObject({ kind: "memory", deleted: true });
    // The person's own memory travels without a scope column.
    await addMemory(sync, "Walks to work.");
    await sync.flush();
    const sent = journal.pushes.at(-1);
    expect(sent?.kind).toBe("memory");
    expect(allMemories(sync)[0].scope).toBeNull();
  });
});

describe("projects (ADR-0085)", () => {
  it("files a chat, renders the app's section and searches the project's files", async () => {
    const { sync } = client();
    const project = await createProject(sync, "Garden");
    await saveProjectSettings(sync, project, {
      instructions: "Answer as a gardener.",
      memoryMode: "project",
    });
    await addProjectFile(sync, project, {
      name: "plan.md",
      format: "md",
      text: "Tomatoes go in the south bed. Basil beside them.",
    });
    const chat = await createChat(sync, "What goes south?", null);
    await moveChatToProject(sync, chat, project);
    expect(projectIdOfChat(sync, chat)).toBe(project);
    const loaded = getProject(sync, project);
    expect(loaded).toMatchObject({ name: "Garden", memoryMode: "project" });
    const section = projectSection(loaded as NonNullable<typeof loaded>);
    expect(section).toContain('project "Garden"');
    expect(section).toContain("Answer as a gardener.");
    expect(section).toContain("files: plan.md");
    expect(section).toContain("keeps its own memory");
    expect(searchProjectFiles(loaded as NonNullable<typeof loaded>, "tomatoes south")).toContain(
      "[Reference: plan.md; passage 1;",
    );
    expect(searchProjectFiles(loaded as NonNullable<typeof loaded>, "zucchini")).toBe(
      "No passage of the project's files matches that.",
    );
    await moveChatToProject(sync, chat, null);
    expect(projectIdOfChat(sync, chat)).toBeNull();
  });

  it("gives a Project only chat its section, its own memories, and keeps what it learns there", async () => {
    const { sync } = client();
    const project = await createProject(sync, "Garden");
    await saveProjectSettings(sync, project, { instructions: "", memoryMode: "project" });
    await addMemory(sync, "Own: lives in Geneva.");
    await addMemory(sync, "Garden: soil is clay.", project);
    const chat = await createChat(sync, "Remember the beds", null);
    await moveChatToProject(sync, chat, project);
    await addMessage(sync, chat, "user", "Remember the beds");
    const replies = [toolCall("remember", { text: "Three raised beds." }), text("Noted.")];
    let index = 0;
    const { operator, calls } = fakeOperator(() => replies[index++]);
    const history = messagesOf(sync, chat);
    await runTurn(
      {
        sync,
        operator,
        key: "cdm_test",
        model: AGENT_LITE.defaultModel,
        memory: true,
        personalization: DEFAULT_PERSONALIZATION,
        temporary: false,
        onText: () => undefined,
        plan: planTurn({
          sync,
          chatId: chat,
          history,
          memory: true,
          pastChats: true,
          project: getProject(sync, project),
          assistant: null,
          attachments: [],
        }),
      },
      history,
    );
    const system = systemOf(calls[0].body);
    expect(system).toContain("Garden: soil is clay.");
    expect(system).not.toContain("lives in Geneva");
    expect(system).toContain('project "Garden"');
    expect(system).toContain(AGENT_LITE.cardsPrompt.slice(0, 40));
    expect(memoriesInScope(sync, project).map((memory) => memory.text)).toContain(
      "Three raised beds.",
    );
    expect(memoriesInScope(sync, null).map((memory) => memory.text)).not.toContain(
      "Three raised beds.",
    );
  });
});

describe("memory of past chats (ADR-0081)", () => {
  it("quotes other general chats, never an assistant's or a closed project's", async () => {
    const { sync } = client();
    const old = await createChat(sync, "Bike", null);
    await addMessage(sync, old, "user", "My bike is a blue Peugeot from 1984.");
    const closed = await createProject(sync, "Secret");
    await saveProjectSettings(sync, closed, { instructions: "", memoryMode: "project" });
    const hidden = await createChat(sync, "Hidden", null);
    await addMessage(sync, hidden, "user", "The Peugeot needs new brakes.");
    await moveChatToProject(sync, hidden, closed);
    const assistant = await saveAssistant(sync, {
      name: "Mechanic",
      description: "",
      instructions: "Fix bikes.",
      model: "",
      openingMessage: "",
      tools: [],
      allowNotes: false,
      allowMemory: false,
    });
    await startAssistantChat(sync, assistant, "Peugeot gears are stiff.");
    const now = await createChat(sync, "Now", null);
    const found = searchPastChats(sync, "what about my Peugeot", {
      exclude: now,
      scope: null,
      limit: 5,
    });
    expect(found.map((snippet) => snippet.excerpt)).toEqual([
      "My bike is a blue Peugeot from 1984.",
    ]);
    const block = pastChatsBlock(found);
    expect(block.startsWith(AGENT_LITE.pastChats.header)).toBe(true);
    expect(block).toContain('- "Bike" (');
    expect(block).toContain("the user said): My bike is a blue Peugeot");
    expect(
      searchPastChats(sync, "Peugeot brakes", { exclude: null, scope: closed, limit: 5 }).map(
        (s) => s.taskId,
      ),
    ).toEqual([hidden]);
    expect(listChats(sync)).toHaveLength(4);
  });

  it("offers search_past_chats only while the setting and memory are on", () => {
    const { sync } = client();
    const plan = (pastChats: boolean, memory: boolean) =>
      planTurn({
        sync,
        chatId: "c",
        history: [],
        memory,
        pastChats,
        project: null,
        assistant: null,
        attachments: [],
      }).tools.map((tool) => tool.function.name);
    expect(plan(true, true)).toEqual(["search_past_chats"]);
    expect(plan(false, true)).toEqual([]);
    expect(plan(true, false)).toEqual([]);
  });
});

describe("a custom assistant's turn (ADR-0058)", () => {
  it("runs on its snapshot: its prompt, its permitted tools and its references", async () => {
    const { sync } = client();
    await addMemory(sync, "Lives in Geneva.");
    const id = await saveAssistant(sync, {
      name: "Coach",
      description: "",
      instructions: "Coach my running.",
      model: "",
      openingMessage: "",
      tools: ["web"],
      allowNotes: false,
      allowMemory: false,
    });
    await addReference(sync, id, {
      name: "Plan",
      format: "md",
      text: "Week one: run three times.",
    });
    const chat = await startAssistantChat(sync, id, "What is week one?");
    const snapshot = conversationSnapshot(sync, chat);
    expect(snapshot?.definition.name).toBe("Coach");
    expect(sync.objects.get(chat)?.bodyTable).toBe("assistant_conversations");
    const replies = [
      toolCall("search_references", { query: "week one" }),
      text("Run three times."),
    ];
    let index = 0;
    const { operator, calls } = fakeOperator(() => replies[index++]);
    const history = messagesOf(sync, chat);
    await runTurn(
      {
        sync,
        operator,
        key: "cdm_test",
        model: AGENT_LITE.defaultModel,
        memory: false,
        personalization: { ...DEFAULT_PERSONALIZATION, aboutYou: "A nurse." },
        temporary: false,
        onText: () => undefined,
        plan: planTurn({
          sync,
          chatId: chat,
          history,
          memory: false,
          pastChats: true,
          project: null,
          assistant: snapshot,
          attachments: [],
        }),
      },
      history,
    );
    const system = systemOf(calls[0].body);
    expect(system.startsWith("You are Coach, a private assistant in Sub Rosa.")).toBe(true);
    expect(system).toContain("Coach my running.");
    expect(system).not.toContain("A nurse.");
    expect(system).not.toContain("Lives in Geneva.");
    expect(toolNames(calls[0].body).sort()).toEqual([
      "fetch_page",
      "search_references",
      "web_search",
    ]);
    const toolResult = (calls[1].body.messages as { role: string; content: string }[]).find(
      (m) => m.role === "tool",
    );
    expect(toolResult?.content).toContain("[Reference: Plan; Document; passage 1]");
  });
});
