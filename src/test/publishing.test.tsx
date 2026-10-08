// Publishing (ADR-0097): a note or a canvas as a public page, an assistant in
// the public catalog, and "Add to Sub Rosa" from a catalog link. The dialogs
// say what publishing means before the button, send only what was ticked,
// and add nothing without a tap.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  invoke: vi.fn(),
  writeText: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: calls.invoke }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: calls.writeText }));
vi.mock("../lib/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/account")>()),
  accountStatus: async () => ({
    account: { email: "you@example.test" },
    server_url: "https://account.example.test",
  }),
  onAccountStatus: () => () => undefined,
}));

import { parseDestination, destinationUrl } from "../lib/destinations";
import { isValidHandle, normalizeHandle } from "../lib/publishing";
import {
  AssistantImportHost,
  requestAssistantImport,
} from "../components/publishing/AssistantImportDialog";
import { PublishAssistantDialog } from "../components/publishing/PublishAssistantDialog";
import { PublishNoteDialog } from "../components/publishing/PublishNoteDialog";
import type { AssistantDefinition } from "../lib/assistants";

const LISTING = "7f3e2b0c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const PAGE = {
  id: "page-1",
  slug: "trip-notes-a1b2c3",
  title: "Trip notes",
  kind: "note",
  source_id: "note-1",
  source_digest: "x",
  site_id: null,
  bytes: 10,
  published_at: "2026-10-08T10:00:00Z",
  updated_at: "2026-10-08T10:00:00Z",
  taken_down: false,
};

function route(table: Record<string, (args: Record<string, unknown>) => unknown>) {
  calls.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    const handler = table[command];
    if (!handler) throw new Error(`unexpected command ${command}`);
    return handler(args ?? {});
  });
}

beforeEach(() => {
  calls.invoke.mockReset();
  calls.writeText.mockClear();
});

describe("the catalog link", () => {
  it("parses an import of one listing and refuses anything else", () => {
    expect(parseDestination(`subrosa://assistant/import?id=${LISTING}`)).toEqual({
      kind: "assistantImport",
      listingId: LISTING,
    });
    expect(parseDestination(`subrosa://assistant/import?id=${LISTING.toUpperCase()}`)).toEqual({
      kind: "assistantImport",
      listingId: LISTING,
    });
    for (const bad of [
      "subrosa://assistant/import",
      "subrosa://assistant/import?id=not-a-uuid",
      "subrosa://assistant/import?id=../../etc",
      `subrosa://assistant/import?id=${LISTING}x`,
      `subrosa://assistant/import/${LISTING}`,
    ]) {
      expect(parseDestination(bad)).toBeNull();
    }
    // The conversation address is unchanged.
    expect(parseDestination("subrosa://assistant/task-1")).toEqual({
      kind: "assistant",
      taskId: "task-1",
    });
    expect(destinationUrl({ kind: "assistantImport", listingId: LISTING })).toBe(
      `subrosa://assistant/import?id=${LISTING}`,
    );
  });

  it("normalizes a handle the way the service accepts it", () => {
    expect(normalizeHandle("  Alice Writes! ")).toBe("alice-writes");
    expect(isValidHandle("alice-writes")).toBe(true);
    for (const bad of ["ab", "a--b", "-ab", "ab-", "Alice", "a".repeat(33)]) {
      expect(isValidHandle(bad)).toBe(false);
    }
  });
});

describe("publishing a note", () => {
  it("says what publishing means, publishes on a tap and shows the address", async () => {
    route({
      account_note_publication: () => ({
        publication_url: "https://pages.example.test",
        page: null,
        url: null,
        changed: false,
      }),
      account_publish_note: () => ({
        publication_url: "https://pages.example.test",
        page: PAGE,
        url: "https://pages.example.test/p/trip-notes-a1b2c3",
        changed: false,
      }),
    });
    render(<PublishNoteDialog noteId="note-1" open onClose={vi.fn()} />);
    expect(
      await screen.findByText("The text is sent and stored unencrypted, unlike your synced notes."),
    ).toBeInTheDocument();
    expect(calls.invoke).not.toHaveBeenCalledWith("account_publish_note", expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(calls.invoke).toHaveBeenCalledWith("account_publish_note", {
      noteId: "note-1",
      kind: "note",
    });
    expect(
      await screen.findByDisplayValue("https://pages.example.test/p/trip-notes-a1b2c3"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish changes" })).toBeDisabled();
  });

  it("offers the changes when the note moved on, and unpublishes in two taps", async () => {
    route({
      account_note_publication: () => ({
        publication_url: "https://pages.example.test",
        page: PAGE,
        url: "https://pages.example.test/p/trip-notes-a1b2c3",
        changed: true,
      }),
      account_unpublish_page: () => undefined,
    });
    render(<PublishNoteDialog noteId="note-1" kind="canvas" open onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Publish changes" })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Publish this canvas" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    expect(calls.invoke).not.toHaveBeenCalledWith("account_unpublish_page", expect.anything());
    expect(
      screen.getByText(
        "Unpublishing removes the page at once. It cannot erase a copy someone has already saved.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Unpublish now" }));
    expect(calls.invoke).toHaveBeenCalledWith("account_unpublish_page", { pageId: "page-1" });
  });

  it("names the rule that refused it", async () => {
    route({
      account_note_publication: () => ({
        publication_url: "https://pages.example.test",
        page: null,
        url: null,
        changed: false,
      }),
      account_publish_note: () => {
        throw {
          code: "publish_credential",
          message: "This looks like it contains a key or a password. Remove it before publishing.",
        };
      },
    });
    render(<PublishNoteDialog noteId="note-1" open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Publish" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This looks like it contains a key or a password.",
    );
  });
});

describe("publishing an assistant", () => {
  const assistant = {
    id: "assistant-1",
    name: "Plain editor",
    description: "Edits prose",
    instructions: "Be brief.",
    model: "",
    opening_message: "Paste a paragraph.",
    tools: ["web"],
    allow_notes: false,
    allow_memory: false,
    avatar_ref: null,
    cover_ref: null,
    revision: 1,
    created_at: "",
    updated_at: "",
  } as AssistantDefinition;

  it("sends only the references that were ticked", async () => {
    route({
      account_publications: () => ({
        publication_url: "https://pages.example.test",
        profile: null,
        pages: [],
        sites: [],
        assistants: [],
      }),
      assistant_reference_list: () => [
        { id: "ref-1", name: "Style guide", status: "ready", text: "Short sentences." },
        { id: "ref-2", name: "Private brief", status: "ready", text: "Do not share." },
        { id: "ref-3", name: "photo.png", status: "ready", text: "" },
      ],
      account_publish_assistant: () => ({ id: LISTING, name: "Plain editor", references: [] }),
    });
    render(<PublishAssistantDialog assistant={assistant} onClose={vi.fn()} />);
    const style = await screen.findByRole("checkbox", { name: "Style guide" });
    expect(screen.getByRole("checkbox", { name: "Private brief" })).not.toBeChecked();
    // An image's reference has no text and is not offered at all.
    expect(screen.queryByRole("checkbox", { name: "photo.png" })).toBeNull();
    await userEvent.click(style);
    await userEvent.selectOptions(screen.getByRole("combobox"), "writing");
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(calls.invoke).toHaveBeenCalledWith("account_publish_assistant", {
        request: {
          assistantId: "assistant-1",
          description: "Edits prose",
          category: "writing",
          referenceIds: ["ref-1"],
        },
      }),
    );
  });
});

describe("adding a catalog assistant", () => {
  it("shows the listing, keeps personal data unticked and adds only on a tap", async () => {
    route({
      catalog_assistant_listing: () => ({
        id: LISTING,
        name: "Plain editor",
        description: "Tightens prose.",
        category: "writing",
        instructions: "Edit for clarity.",
        starter: "Paste a paragraph.",
        permissions: ["notes", "web"],
        references: [{ name: "Style guide", text: "Short sentences." }],
        import_count: 3,
        author: { handle: "alice-writes", display_name: "Alice" },
      }),
      catalog_assistant_import: () => ({ id: "new-assistant" }),
    });
    const onImported = vi.fn();
    render(<AssistantImportHost onImported={onImported} />);
    act(() => requestAssistantImport(LISTING));
    expect(await screen.findByText("Edit for clarity.")).toBeInTheDocument();
    expect(screen.getByText("Style guide")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Search the web" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Read your notes" })).not.toBeChecked();
    expect(calls.invoke).not.toHaveBeenCalledWith("catalog_assistant_import", expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "Add to Sub Rosa" }));
    await waitFor(() =>
      expect(calls.invoke).toHaveBeenCalledWith("catalog_assistant_import", {
        listingId: LISTING,
        granted: ["web"],
      }),
    );
    expect(onImported).toHaveBeenCalledWith({ id: "new-assistant" });
  });
});
