// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
// @ts-expect-error node:fs is available in the Vitest runtime.
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addReference,
  conversationSnapshot,
  listAssistants,
  saveAssistant,
  startAssistantChat,
} from "../../website/src/client/assistants";
import {
  type BlobTransport,
  listGalleryPictures,
  saveToGallery,
} from "../../website/src/client/gallery";
import { addMessage } from "../../website/src/client/library";
import { addMemory, memoriesInScope } from "../../website/src/client/memories";
import {
  addProjectFile,
  createProject,
  listProjects,
  moveChatToProject,
  projectIdOfChat,
  renameProject,
  saveProjectSettings,
} from "../../website/src/client/projects";
import { linkSaveRequest, listSaved, saveItem } from "../../website/src/client/saved";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import type { Change } from "../../website/src/lib/api";
import { decode, encode } from "../../website/src/lib/vault";
import { FakeJournal } from "./website-client-fakes";

const ACCOUNT = "0191d1a4-0000-7000-8000-00000000a11c";
const FIXTURE = "src-tauri/tests/fixtures/web-client-objects-v2.json";
const key = () => new Uint8Array(32).fill(9);
const PNG = "data:image/png;base64,iVBORw0KGgo=";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

const nowhere: BlobTransport = { put: async () => undefined, get: async () => "" };

describe("WP20's rows, written by a browser", () => {
  it("keeps a project's folder and its settings as two rows of one object", async () => {
    const journal = new FakeJournal();
    const store = memoryClientStore();
    const sync = new SyncClient(ACCOUNT, key(), store, journal.transport());
    const project = await createProject(sync, "Garden");
    await saveProjectSettings(sync, project, { instructions: "Be brief.", memoryMode: "project" });
    await sync.flush();
    await renameProject(sync, project, { name: "Allotment" });
    await sync.flush();
    // One object on the service, its revisions chained.
    expect(new Set(journal.pushes.map((push) => push.object_id))).toEqual(new Set([project]));
    expect(journal.pushes[1].parent_revision).toBe(journal.changes[0].revision);
    expect(journal.pushes[2].parent_revision).toBe(journal.changes[1].revision);
    for (const reader of [
      new SyncClient(ACCOUNT, key(), memoryClientStore(), journal.transport()),
      new SyncClient(ACCOUNT, key(), store, journal.transport()),
    ]) {
      await reader.load();
      await reader.pull();
      expect(listProjects(reader)).toMatchObject([
        { name: "Allotment", instructions: "Be brief.", memoryMode: "project" },
      ]);
      expect(reader.conflicts.size).toBe(0);
    }
  });

  it("matches the committed fixture the Rust apply test reads", async () => {
    // @ts-expect-error process is available in the Vitest runtime.
    if (process.env.SUBROSA_WRITE_WEB_FIXTURE) {
      const journal = new FakeJournal();
      const sync = new SyncClient(ACCOUNT, key(), memoryClientStore(), journal.transport());
      const project = await createProject(sync, "Garden");
      await saveProjectSettings(sync, project, {
        instructions: "Answer as a gardener.",
        memoryMode: "project",
      });
      await addProjectFile(sync, project, {
        name: "plan.md",
        format: "md",
        text: "Tomatoes south.",
      });
      await addMemory(sync, "Soil is clay.", project);
      const assistant = await saveAssistant(sync, {
        name: "Coach",
        description: "Running",
        instructions: "Coach my running.",
        model: "",
        openingMessage: "Ready?",
        tools: ["web"],
        allowNotes: false,
        allowMemory: true,
      });
      await addReference(sync, assistant, {
        name: "Plan",
        format: "md",
        text: "Week one: run three times.",
      });
      const chat = await startAssistantChat(sync, assistant, "What is week one?");
      await addMessage(sync, chat, "assistant", "Run three times.");
      await saveItem(sync, linkSaveRequest({ url: "https://example.com/a", title: "A" }, chat));
      await saveToGallery(
        sync,
        ACCOUNT,
        key(),
        { dataUrl: PNG, model: "flux-2", prompt: "A fox" },
        nowhere,
      );
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
    const reader = new SyncClient(fixture.account, decode(fixture.key), memoryClientStore(), {
      pull: async (kind) => ({
        changes: fixture.changes.filter((change) => change.kind === kind),
        cursor: fixture.changes.length,
      }),
      push: async () => ({ results: [] }),
    });
    await reader.pull();
    const [project] = listProjects(reader);
    expect(project).toMatchObject({
      name: "Garden",
      instructions: "Answer as a gardener.",
      memoryMode: "project",
    });
    expect(project.files.map((file) => file.name)).toEqual(["plan.md"]);
    expect(memoriesInScope(reader, project.id).map((memory) => memory.text)).toEqual([
      "Soil is clay.",
    ]);
    const [assistant] = listAssistants(reader);
    expect(assistant).toMatchObject({ name: "Coach", tools: ["web"], allow_memory: true });
    const chat = [...reader.objects.values()].find(
      (object) => object.bodyTable === "assistant_conversations",
    );
    expect(
      conversationSnapshot(reader, chat?.id ?? "")?.references.map((reference) => reference.name),
    ).toEqual(["Plan"]);
    expect(projectIdOfChat(reader, chat?.id ?? "")).toBeNull();
    expect(listSaved(reader).map((item) => item.sourceKey)).toEqual(["link:https://example.com/a"]);
    expect(listGalleryPictures(reader)).toMatchObject([{ format: "png", prompt: "A fox" }]);
    expect(moveChatToProject).toBeDefined();
  });
});
