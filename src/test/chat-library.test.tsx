import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReplyLibraryActions, SaveToggle } from "../components/chat/LibraryActions";
import { LibraryView } from "../components/library/LibraryView";
import {
  linkSaveRequest,
  listChatImages,
  placeSaveRequest,
  replySaveRequest,
  replyTitle,
  resetLibraryStore,
  type SavedItem,
} from "../lib/chat-library";
import { markTemporaryChat, resetTemporaryChats } from "../lib/temporary-chat";

/**
 * The Library (ADR-0088): a reply, a link or a place kept from a chat, and
 * every picture a chat made, found in the gallery by its origin.
 */

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  convertFileSrc: (path: string) => `asset://${path}`,
}));

const studio = vi.hoisted(() => ({ artifacts: [] as unknown[] }));
vi.mock("../lib/studio/artifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/studio/artifacts")>();
  return { ...actual, listArtifacts: async () => studio.artifacts };
});

let stored: SavedItem[];

beforeEach(() => {
  resetLibraryStore();
  resetTemporaryChats();
  stored = [];
  studio.artifacts = [];
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "saved_items_list") return stored;
    if (command === "saved_item_save") {
      const request = args?.request as Omit<SavedItem, "id" | "createdAt">;
      const existing = stored.find((item) => item.sourceKey === request.sourceKey);
      if (existing) return existing;
      const row = { ...request, id: `s${stored.length + 1}`, createdAt: "2026-10-08T00:00:00Z" };
      stored = [row, ...stored];
      return row;
    }
    if (command === "saved_item_remove") {
      stored = stored.filter((item) => item.id !== args?.id);
      return null;
    }
    return null;
  });
});

describe("what a thing is saved as", () => {
  it("keys a stored reply by its chat and message, and titles it from its first line", () => {
    const request = replySaveRequest({
      text: "## Trip plan\n\n- Lisbon",
      conversationId: "chat",
      messageId: "m1",
    });
    expect(request).toMatchObject({
      kind: "reply",
      sourceKey: "reply:chat:m1",
      title: "Trip plan",
      conversationId: "chat",
    });
    // A card reads as its plain-text form: its title, not its JSON.
    const links = JSON.stringify({
      v: 1,
      title: "Sources",
      links: [{ title: "Docs", url: "https://example.com/a" }],
    });
    expect(replyTitle(`\`\`\`subrosa:links\n${links}\n\`\`\`\nPlain line`)).toBe("Sources");
  });

  it("keys a reply with no stored id by its text, so saving it twice is one row", () => {
    const one = replySaveRequest({ text: "Same text." });
    const two = replySaveRequest({ text: "Same text." });
    expect(one.sourceKey).toBe(two.sourceKey);
    expect(replySaveRequest({ text: "Other." }).sourceKey).not.toBe(one.sourceKey);
  });

  it("keys a link by its address and a place by its spot", () => {
    expect(
      linkSaveRequest({ title: "Docs", url: "https://example.com/a", domain: "example.com" }),
    ).toMatchObject({ kind: "link", sourceKey: "link:https://example.com/a", title: "Docs" });
    expect(
      placeSaveRequest({ name: "Café", lat: 46.2044, lng: 6.1432, address: "Rue 1" }),
    ).toMatchObject({
      kind: "place",
      sourceKey: "place:46.20440,6.14320:Café",
      payload: { lat: 46.2044, lng: 6.1432, address: "Rue 1" },
    });
  });
});

describe("saving from a chat", () => {
  it("saves a reply and takes it back out", async () => {
    render(
      <ReplyLibraryActions
        text="A useful answer."
        conversationId="chat"
        messageId="m1"
        className="a"
      />,
    );
    const save = screen.getByRole("button", { name: "Save to Library" });
    await userEvent.click(save);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove from Library" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "reply", payload: { text: "A useful answer." } });

    await userEvent.click(screen.getByRole("button", { name: "Remove from Library" }));
    await waitFor(() => expect(stored).toEqual([]));
  });

  it("offers neither Save nor Open in canvas in a temporary chat", () => {
    markTemporaryChat("temp");
    const { container } = render(
      <ReplyLibraryActions text="Secret." conversationId="temp" messageId="m1" className="a" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a card's Save as already saved when it is in the Library", async () => {
    const link = { title: "Docs", url: "https://example.com/a", domain: "example.com" };
    stored = [
      {
        ...linkSaveRequest(link),
        id: "s1",
        createdAt: "2026-10-08T00:00:00Z",
      } as SavedItem,
    ];
    render(<SaveToggle request={linkSaveRequest(link)} className="chat-block-save" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove from Library" })).toBeInTheDocument(),
    );
  });
});

describe("the Library view", () => {
  it("lists what was saved and removes an item", async () => {
    stored = [
      {
        id: "s1",
        kind: "link",
        sourceKey: "link:https://example.com/a",
        title: "The docs",
        payload: { url: "https://example.com/a", domain: "example.com" },
        createdAt: "2026-10-08T00:00:00Z",
      },
      {
        id: "s2",
        kind: "reply",
        sourceKey: "reply:chat:m1",
        title: "Trip plan",
        payload: { text: "## Trip plan\n\nLisbon in May." },
        conversationId: "chat",
        createdAt: "2026-10-07T00:00:00Z",
      },
    ];
    render(<LibraryView />);
    const docs = (await screen.findByText("The docs")).closest("li") as HTMLElement;
    expect(within(docs).getByText("example.com")).toBeInTheDocument();
    expect(screen.getByText("Trip plan")).toBeInTheDocument();

    await userEvent.click(within(docs).getByRole("button", { name: "Remove from Library" }));
    await waitFor(() => expect(screen.queryByText("The docs")).not.toBeInTheDocument());
    expect(stored.map((item) => item.id)).toEqual(["s2"]);
  });

  it("says so when nothing is saved yet", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Nothing saved yet")).toBeInTheDocument();
  });

  it("lists the pictures made in chats, and only those", async () => {
    studio.artifacts = [
      {
        id: "a.png",
        kind: "image",
        fileName: "a.png",
        path: "/g/a.png",
        prompt: "a cat",
        origin: { surface: "chat" },
      },
      { id: "b.png", kind: "image", fileName: "b.png", path: "/g/b.png", prompt: "studio work" },
    ];
    expect((await listChatImages()).map((image) => image.id)).toEqual(["a.png"]);

    render(<LibraryView />);
    await userEvent.click(screen.getByRole("button", { name: "Images" }));
    expect(await screen.findByRole("button", { name: "a cat" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "studio work" })).not.toBeInTheDocument();
  });
});
