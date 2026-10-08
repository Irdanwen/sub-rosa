// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
// @ts-expect-error node:fs is available in the Vitest runtime.
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMessage,
  archiveChat,
  createChat,
  createNote,
  listChats,
  listMemories,
  listNotes,
  messagesOf,
  remember,
  restoreChat,
} from "../../website/src/client/library";
import type { Change } from "../../website/src/lib/api";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { decode, decrypt, encode } from "../../website/src/lib/vault";
import { FakeJournal } from "./website-client-fakes";

const ACCOUNT = "0191d1a4-0000-7000-8000-00000000a11c";
const FIXTURE = "src-tauri/tests/fixtures/web-client-objects-v1.json";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

function vaultKey(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(32).fill(9);
}

describe("the web client's sync writer", () => {
  it("writes the app's rows in the app's wire format and context", async () => {
    const journal = new FakeJournal();
    const sync = new SyncClient(ACCOUNT, vaultKey(), memoryClientStore(), journal.transport());
    const chat = await createChat(sync, "What did we decide on Tuesday?", "zai-org-glm-5-2");
    await addMessage(sync, chat, "user", "What did we decide on Tuesday?");
    await sync.flush();
    // One task, one message (the task's later touch coalesced with its
    // unsent creation, as the app's triggers do).
    expect(journal.pushes.map((operation) => operation.kind)).toEqual([
      "conversation",
      "conversation",
    ]);
    const [task] = journal.pushes;
    expect(task.object_id).toBe(chat);
    const body = await decrypt<Record<string, unknown>>(
      vaultKey(),
      task.ciphertext,
      `subrosa:object:v1:${ACCOUNT}:conversation:${chat}`,
    );
    expect(body).toMatchObject({
      v: 1,
      operation_id: task.operation_id,
      parent_revision: null,
      resolved_revisions: [],
      deleted: false,
      table: "agent_tasks",
      row: {
        id: chat,
        title: "What did we decide on Tuesday?",
        status: "completed",
        safety_profile: "autonomous_private",
        model: "zai-org-glm-5-2",
      },
    });
    expect(Object.keys(body.row as object).sort()).toEqual(
      [
        "id",
        "title",
        "prompt",
        "status",
        "safety_profile",
        "progress_summary",
        "created_at",
        "updated_at",
        "completed_at",
        "model",
      ].sort(),
    );
    // A different context does not open it: the AAD binds kind and object.
    await expect(
      decrypt(vaultKey(), task.ciphertext, `subrosa:object:v1:${ACCOUNT}:note:${chat}`),
    ).rejects.toThrow();
  });

  it("round trips a chat, a note, a memory and an archive to another device", async () => {
    const journal = new FakeJournal();
    const browser = new SyncClient(ACCOUNT, vaultKey(), memoryClientStore(), journal.transport());
    const chat = await createChat(browser, "Plan the launch", null);
    await addMessage(browser, chat, "user", "Plan the launch");
    await addMessage(browser, chat, "assistant", "Here is a plan.");
    await createNote(browser, "Launch", "Ship on Monday.");
    await remember(browser, "Prefers short answers.");
    await archiveChat(browser, chat);
    await browser.flush();

    const other = new SyncClient(ACCOUNT, vaultKey(), memoryClientStore(), journal.transport());
    await other.pull();
    expect(listChats(other)).toEqual([
      expect.objectContaining({ id: chat, title: "Plan the launch", archived: true }),
    ]);
    expect(messagesOf(other, chat).map((message) => [message.role, message.content])).toEqual([
      ["user", "Plan the launch"],
      ["assistant", "Here is a plan."],
    ]);
    expect(listNotes(other)[0]).toMatchObject({ title: "Launch", body: "Ship on Monday." });
    expect(listMemories(other).map((memory) => memory.text)).toEqual(["Prefers short answers."]);

    await restoreChat(other, chat);
    await other.flush();
    await browser.pull();
    expect(listChats(browser)[0].archived).toBe(false);
  });

  it("keeps nothing readable at rest and survives a reload offline", async () => {
    const journal = new FakeJournal();
    const store = memoryClientStore();
    const first = new SyncClient(ACCOUNT, vaultKey(), store, journal.transport());
    const chat = await createChat(first, "A secret plan", null);
    await addMessage(first, chat, "user", "A secret plan");
    journal.failNextPush = 1;
    await expect(first.flush()).rejects.toThrow();
    expect(journal.changes).toHaveLength(0);
    for (const area of store.areas.values())
      for (const value of area.values()) expect(JSON.stringify(value)).not.toContain("secret");

    const reloaded = new SyncClient(ACCOUNT, vaultKey(), store, journal.transport());
    await reloaded.load();
    expect(messagesOf(reloaded, chat).map((message) => message.content)).toEqual(["A secret plan"]);
    expect(reloaded.pendingCount).toBe(2);
    await reloaded.flush();
    expect(reloaded.pendingCount).toBe(0);
    expect(journal.changes).toHaveLength(2);
  });

  it("retries a lost answer with the same operation and the same bytes", async () => {
    const journal = new FakeJournal();
    const sync = new SyncClient(ACCOUNT, vaultKey(), memoryClientStore(), journal.transport());
    await createNote(sync, "Retry", "Body");
    const transport = journal.transport();
    let answered = 0;
    const lossy = {
      ...transport,
      push: async (body: string) => {
        const result = await transport.push(body);
        answered += 1;
        if (answered === 1) throw new TypeError("connection reset");
        return result;
      },
    };
    const flaky = new SyncClient(ACCOUNT, vaultKey(), memoryClientStore(), lossy);
    await createNote(flaky, "Lost answer", "Body");
    await expect(flaky.flush()).rejects.toThrow();
    await flaky.flush();
    const sent = journal.pushes.filter((operation) => operation.kind === "note");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(journal.changes).toHaveLength(1);
  });

  it("keeps a concurrent edit as a conflict, and acknowledges one that agrees", async () => {
    const journal = new FakeJournal();
    const a = new SyncClient(ACCOUNT, vaultKey(), memoryClientStore(), journal.transport());
    const note = await createNote(a, "Shared", "One");
    await a.flush();
    const b = new SyncClient(ACCOUNT, vaultKey(), memoryClientStore(), journal.transport());
    await b.pull();

    // Both edit the same revision. B's arrives second and becomes a sibling.
    const rowA = a.objects.get(note.id)?.row ?? {};
    await a.write("notes", { ...rowA, edited_content: "Edited on the phone" });
    await a.flush();
    const rowB = b.objects.get(note.id)?.row ?? {};
    await b.write("notes", { ...rowB, edited_content: "Edited in the browser" });
    await b.flush();
    expect(journal.heads.get(note.id)?.size).toBe(2);
    await b.pull();
    // The browser keeps its own text and the phone's as a conflict to review.
    expect(b.objects.get(note.id)?.row.edited_content).toBe("Edited in the browser");
    expect(b.conflicts.get(note.id)?.map((conflict) => conflict.row.edited_content)).toEqual([
      "Edited on the phone",
    ]);

    // Two devices that wrote the same thing converge without anybody.
    const sameA = await createNote(a, "Same", "Same text");
    await a.flush();
    const c = new SyncClient(ACCOUNT, vaultKey(), memoryClientStore(), journal.transport());
    await c.pull();
    const rowSame = c.objects.get(sameA.id)?.row ?? {};
    await a.write("notes", { ...rowSame, title: "Agreed" });
    await c.write("notes", { ...rowSame, title: "Agreed" });
    await a.flush();
    await c.flush();
    await c.pull();
    expect(c.conflicts.get(sameA.id)).toBeUndefined();
    await c.flush();
    const resolution = journal.pushes.at(-1);
    expect(resolution?.resolved_revisions).toHaveLength(1);
    expect(journal.heads.get(sameA.id)?.size).toBe(1);
  });

  it("refuses a substituted or foreign revision before anything changes", async () => {
    const journal = new FakeJournal();
    const sync = new SyncClient(ACCOUNT, vaultKey(), memoryClientStore(), journal.transport());
    await createNote(sync, "Mine", "Body");
    await sync.flush();
    journal.changes[0] = { ...journal.changes[0], kind: "memory" };
    const reader = new SyncClient(ACCOUNT, vaultKey(), memoryClientStore(), journal.transport());
    await expect(reader.pull()).rejects.toThrow();
    expect(listNotes(reader)).toEqual([]);
  });

  it("matches the committed fixture the Rust apply test reads", async () => {
    const key = vaultKey();
    // @ts-expect-error process is available in the Vitest runtime.
    if (process.env.SUBROSA_WRITE_WEB_FIXTURE) {
      const journal = new FakeJournal();
      const sync = new SyncClient(ACCOUNT, key, memoryClientStore(), journal.transport());
      const chat = await createChat(sync, "From the browser", "zai-org-glm-5-2");
      await addMessage(sync, chat, "user", "From the browser");
      await addMessage(sync, chat, "assistant", "An answer.");
      await createNote(sync, "Browser note", "Written in a browser.");
      await remember(sync, "Writes from a browser.");
      await archiveChat(sync, chat);
      await sync.flush();
      writeFileSync(
        FIXTURE,
        `${JSON.stringify({ account: ACCOUNT, key: encode(key), changes: journal.changes }, null, 2)}\n`,
      );
      return;
    }
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8") as string) as {
      account: string;
      key: string;
      changes: Change[];
    };
    expect(fixture.account).toBe(ACCOUNT);
    const reader = new SyncClient(fixture.account, decode(fixture.key), memoryClientStore(), {
      pull: async (kind) => ({
        changes: fixture.changes.filter((change) => change.kind === kind),
        cursor: fixture.changes.length,
      }),
      push: async () => ({ results: [] }),
    });
    await reader.pull();
    const [chat] = listChats(reader);
    expect(chat).toMatchObject({ title: "From the browser", archived: true });
    expect(messagesOf(reader, chat.id)).toHaveLength(2);
    expect(listNotes(reader)[0].title).toBe("Browser note");
    expect(listMemories(reader)[0].text).toBe("Writes from a browser.");
  });
});
