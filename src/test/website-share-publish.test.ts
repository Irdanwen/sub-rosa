// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAssistant, referencesOf, saveAssistant } from "../../website/src/client/assistants";
import {
  importListing,
  listingPermissions,
  type PublishTransport,
  publishAssistant,
  publishNote,
  slugFor,
} from "../../website/src/client/publish";
import {
  isSaved,
  listSaved,
  removeSaved,
  saveItem,
  savedItemId,
  linkSaveRequest,
  replySaveRequest,
} from "../../website/src/client/saved";
import { createConversationShare, ShareError, visibleTurns } from "../../website/src/client/share";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { readShareLink, type SharedDocument } from "../../website/src/lib/share";
import { decrypt } from "../../website/src/lib/vault";
import { FakeJournal } from "./website-client-fakes";

const ACCOUNT = "0191d1a4-0000-7000-8000-00000000a11c";
const key = () => new Uint8Array(32).fill(3);

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

function client() {
  const journal = new FakeJournal();
  return {
    journal,
    sync: new SyncClient(ACCOUNT, key(), memoryClientStore(), journal.transport()),
  };
}

describe("sharing a chat from the browser (ADR-0053)", () => {
  it("keeps only what was said, without attached context or inline bytes", () => {
    expect(
      visibleTurns([
        { role: "user", content: "Look at this\n--- Attached Context ---\nsecret notes" },
        { role: "assistant", content: "A picture: data:image/png;base64,AAAA end" },
        { role: "user", content: "   " },
      ]),
    ).toEqual([
      { role: "user", content: "Look at this" },
      { role: "assistant", content: "A picture: [attachment] end" },
    ]);
  });

  it("seals the turns under a fresh key that only the link carries", async () => {
    const blobs = new Map<string, string>();
    const opened: { id: string; expires_at: string; blob_ids: string[] }[] = [];
    const transport = {
      origin: "https://subrosa.test",
      putBlob: async (id: string, sealed: string) => void blobs.set(id, sealed),
      open: async (body: { id: string; expires_at: string; blob_ids: string[] }) =>
        void opened.push(body),
      revoke: async () => undefined,
    };
    const now = new Date("2026-10-08T10:00:00Z");
    const link = await createConversationShare(
      "Trip",
      [
        { role: "user", content: "Where?" },
        { role: "assistant", content: "Lisbon." },
      ],
      168,
      transport,
      now,
    );
    expect(opened).toHaveLength(1);
    expect(opened[0].expires_at).toBe("2026-10-15T10:00:00.000Z");
    const url = new URL(link.url);
    const parsed = readShareLink(url.pathname, url.hash);
    expect(parsed?.id).toBe(opened[0].id);
    const document = await decrypt<SharedDocument>(
      parsed?.key as Uint8Array<ArrayBuffer>,
      blobs.get(opened[0].blob_ids[0]) as string,
      `subrosa:share:v1:${opened[0].id}:0`,
    );
    expect(document).toMatchObject({ v: 1, kind: "conversation", title: "Trip", body: "" });
    expect(document.messages).toEqual([
      { role: "user", content: "Where?" },
      { role: "assistant", content: "Lisbon." },
    ]);
    // The vault key never seals a share: it opens nothing here.
    await expect(
      decrypt(
        key(),
        blobs.get(opened[0].blob_ids[0]) as string,
        `subrosa:share:v1:${opened[0].id}:0`,
      ),
    ).rejects.toThrow();
  });

  it("refuses an empty chat and a deadline the app does not offer", async () => {
    const transport = { origin: "", putBlob: vi.fn(), open: vi.fn(), revoke: vi.fn() };
    await expect(createConversationShare("x", [], 24, transport)).rejects.toBeInstanceOf(
      ShareError,
    );
    await expect(
      createConversationShare("x", [{ role: "user", content: "hi" }], 48, transport),
    ).rejects.toBeInstanceOf(ShareError);
    expect(transport.putBlob).not.toHaveBeenCalled();
  });
});

describe("the saved library (ADR-0088)", () => {
  it("derives an item's id from what was saved, as the app does", async () => {
    // uuid.uuid5(uuid.NAMESPACE_URL, "subrosa:saved-item:link:https://example.com/a")
    expect(await savedItemId("link:https://example.com/a")).toBe(
      "fd2cb2e0-d746-56b5-8350-fd099775fb55",
    );
  });

  it("saves once, travels as an artifact, and can be removed", async () => {
    const { journal, sync } = client();
    const request = linkSaveRequest({ url: "https://example.com/a", title: "A" }, "chat-1");
    await saveItem(sync, request);
    await saveItem(sync, request);
    await saveItem(
      sync,
      replySaveRequest({ text: "# Plan\nDo it", conversationId: "chat-1", messageId: "m1" }),
    );
    await sync.flush();
    expect(journal.pushes.map((push) => push.kind)).toEqual(["artifact", "artifact"]);
    const items = listSaved(sync);
    expect(items.map((item) => item.title).sort()).toEqual(["A", "Plan"]);
    expect(items.find((item) => item.kind === "link")?.payload).toEqual({
      url: "https://example.com/a",
      domain: "example.com",
    });
    expect(isSaved(sync, "link:https://example.com/a")).toBe(true);
    await removeSaved(sync, await savedItemId("link:https://example.com/a"));
    expect(isSaved(sync, "link:https://example.com/a")).toBe(false);
  });
});

function fakePublisher(overview: Record<string, unknown>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const transport: PublishTransport = {
    get: async <T>() => overview as T,
    send: async <T>(method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (path.includes("/catalog/"))
        return {
          id: "listing",
          name: "Coach",
          description: "Helps you run",
          instructions: "Be a running coach.",
          starter: "Ready?",
          permissions: ["web", "notes", "memory"],
          references: [{ name: "Plan", text: "Week one" }],
        } as T;
      const value = (body ?? {}) as Record<string, unknown>;
      return { ...value, id: path.split("/").pop(), slug: value.slug } as T;
    },
    sendBytes: async <T>() => ({}) as T,
  };
  return { calls, transport };
}

describe("publishing from the browser (ADR-0097)", () => {
  it("folds a title into the app's slug", () => {
    expect(slugFor("Réunion d'équipe : bilan", "a1b2c3")).toBe("reunion-d-equipe-bilan-a1b2c3");
    expect(slugFor("   ", "a1b2c3")).toBe("page-a1b2c3");
    expect(slugFor("東京", "a1b2c3")).toBe("page-a1b2c3");
    expect(slugFor("--Hello--World--", "a1b2c3")).toBe("hello-world-a1b2c3");
    expect(slugFor("word ".repeat(40), "a1b2c3").length).toBeLessThanOrEqual(64);
  });

  it("publishes a note as a new page, and republishes it under the same address", async () => {
    const fresh = fakePublisher({
      publication_url: "https://pages.test",
      pages: [],
      sites: [],
      assistants: [],
    });
    const first = await publishNote(
      { id: "note-1", title: "Plan", body: "Hello" },
      "note",
      fresh.transport,
    );
    expect(fresh.calls[0]).toMatchObject({
      method: "PUT",
      body: { title: "Plan", kind: "note", source_id: "note-1", markdown: "Hello" },
    });
    expect((fresh.calls[0].body as { slug: string }).slug).toMatch(/^plan-[0-9a-f]{6}$/);
    expect(first.url).toMatch(/^https:\/\/pages\.test\/p\/plan-/);
    const again = fakePublisher({
      publication_url: "https://pages.test",
      pages: [{ id: "page-1", slug: "plan-abcdef", source_id: "note-1" }],
      sites: [],
      assistants: [],
    });
    await publishNote(
      { id: "note-1", title: "Plan", body: "Hello again" },
      "note",
      again.transport,
    );
    expect(again.calls[0].path).toBe("/api/v1/publications/pages/page-1");
    expect((again.calls[0].body as { slug: string }).slug).toBe("plan-abcdef");
  });

  it("lists an assistant with only its catalog permissions and the ticked references", async () => {
    const { sync } = client();
    const id = await saveAssistant(sync, {
      name: "Coach",
      description: "Runs",
      instructions: "Coach me.",
      model: "",
      openingMessage: "Ready?",
      tools: ["web", "connector:x", "image"],
      allowNotes: true,
      allowMemory: false,
    });
    const definition = getAssistant(sync, id);
    expect(definition?.tools).toEqual(["image", "web"]);
    expect(listingPermissions(definition as NonNullable<typeof definition>)).toEqual([
      "image",
      "notes",
      "web",
    ]);
    const { calls, transport } = fakePublisher({
      publication_url: "",
      pages: [],
      sites: [],
      assistants: [],
    });
    await publishAssistant(
      definition as NonNullable<typeof definition>,
      {
        category: "productivity",
        description: "",
        references: [
          {
            id: "r",
            assistant_id: id,
            name: "Plan",
            format: "md",
            text: "x",
            status: "ready",
            error: null,
            note_id: null,
            file_name: null,
            created_at: "",
            updated_at: "",
          },
        ],
      },
      transport,
    );
    expect(calls[0].body).toMatchObject({
      source_id: id,
      description: "Runs",
      category: "productivity",
      starter: "Ready?",
      permissions: ["image", "notes", "web"],
      references: [{ name: "Plan", text: "x" }],
    });
  });

  it("adds a catalog assistant with only the permissions the person ticked", async () => {
    const { sync } = client();
    const { transport } = fakePublisher({});
    const id = await importListing(sync, "listing", ["web"], transport);
    const definition = getAssistant(sync, id);
    expect(definition).toMatchObject({
      name: "Coach",
      tools: ["web"],
      allow_notes: false,
      allow_memory: false,
      model: "",
    });
    expect(
      referencesOf(sync, id).map((reference) => [
        reference.name,
        reference.format,
        reference.status,
      ]),
    ).toEqual([["Plan", "md", "ready"]]);
  });
});
