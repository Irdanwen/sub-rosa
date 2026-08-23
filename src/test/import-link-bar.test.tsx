import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestDto, LinkPreview } from "../lib/tauri";

const listeners: Array<(event: { payload: IngestDto }) => void> = [];

function emitIngest(payload: IngestDto) {
  for (const handler of listeners) {
    handler({ payload });
  }
}

const mocks = vi.hoisted(() => ({
  previewIngestLink: vi.fn(),
  startLinkIngest: vi.fn(),
  listActiveIngests: vi.fn(),
  discardIngest: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_event: string, handler: (event: { payload: IngestDto }) => void) => {
    listeners.push(handler);
    return Promise.resolve(() => {});
  },
}));

vi.mock("../lib/tauri", () => ({
  INGEST_EVENT: "june://ingest",
  previewIngestLink: (...args: unknown[]) => mocks.previewIngestLink(...args),
  startLinkIngest: (...args: unknown[]) => mocks.startLinkIngest(...args),
  listActiveIngests: (...args: unknown[]) => mocks.listActiveIngests(...args),
  discardIngest: (...args: unknown[]) => mocks.discardIngest(...args),
}));

import { ImportLinkBar } from "../components/notes-list/ImportLinkBar";

function preview(overrides: Partial<LinkPreview> = {}): LinkPreview {
  return {
    url: "https://cdn.example.com/ep/42.mp3",
    kind: "directMedia",
    host: "cdn.example.com",
    fetchable: true,
    reason: null,
    ...overrides,
  };
}

function ingest(overrides: Partial<IngestDto> = {}): IngestDto {
  return {
    id: "ingest-1",
    url: "https://cdn.example.com/ep/42.mp3",
    kind: "direct",
    status: "fetching",
    title: "Episode 42",
    mediaUrl: "https://cdn.example.com/ep/42.mp3",
    noteId: null,
    folderId: null,
    bytesDone: 5 * 1024 * 1024,
    bytesTotal: 20 * 1024 * 1024,
    attempts: 1,
    lastError: null,
    createdAt: "2026-08-23T09:00:00Z",
    updatedAt: "2026-08-23T09:00:10Z",
    ...overrides,
  };
}

beforeEach(() => {
  listeners.length = 0;
  mocks.previewIngestLink.mockReset().mockResolvedValue(preview());
  mocks.startLinkIngest.mockReset().mockResolvedValue(ingest());
  mocks.listActiveIngests.mockReset().mockResolvedValue([]);
  mocks.discardIngest.mockReset().mockResolvedValue(undefined);
});

describe("ImportLinkBar", () => {
  it("says what a link is before fetching anything", async () => {
    render(<ImportLinkBar />);

    await userEvent.type(
      screen.getByPlaceholderText(/paste a podcast or media link/i),
      "https://cdn.example.com/ep/42.mp3",
    );

    expect(await screen.findByText(/A media file on cdn.example.com/)).toBeTruthy();
    // Classification is offline: nothing was fetched to learn this.
    expect(mocks.startLinkIngest).not.toHaveBeenCalled();
  });

  it("states that the download leaves this machine, rather than burying it", async () => {
    render(<ImportLinkBar />);

    await userEvent.type(
      screen.getByPlaceholderText(/paste a podcast/i),
      "https://x.example/a.mp3",
    );

    // ADR-0028: a privacy-first product does not get to be quiet about the one
    // action that touches a third party.
    expect(
      await screen.findByText(/goes straight from this machine to cdn.example.com/),
    ).toBeTruthy();
  });

  it("refuses a platform page with the reason, and will not let it be sent", async () => {
    mocks.previewIngestLink.mockResolvedValue(
      preview({
        kind: "platformPage",
        host: "youtube.com",
        fetchable: false,
        reason: "youtube.com does not publish a file this app can fetch.",
      }),
    );

    render(<ImportLinkBar />);
    await userEvent.type(
      screen.getByPlaceholderText(/paste a podcast/i),
      "https://youtube.com/watch?v=a",
    );

    expect(
      await screen.findByText("youtube.com does not publish a file this app can fetch."),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /fetch/i })).toHaveProperty("disabled", true),
    );
  });

  it("shows a feed as a feed, since the newest episode is what gets fetched", async () => {
    mocks.previewIngestLink.mockResolvedValue(preview({ kind: "feed", host: "feeds.example.com" }));

    render(<ImportLinkBar />);
    await userEvent.type(
      screen.getByPlaceholderText(/paste a podcast/i),
      "https://feeds.example.com/show",
    );

    expect(await screen.findByText(/newest episode will be fetched/)).toBeTruthy();
  });

  it("follows a download through the event and clears the field", async () => {
    render(<ImportLinkBar />);
    const field = screen.getByPlaceholderText(/paste a podcast/i);
    await userEvent.type(field, "https://cdn.example.com/ep/42.mp3");
    await userEvent.click(await screen.findByRole("button", { name: /fetch/i }));

    expect(await screen.findByText("Episode 42")).toBeTruthy();
    expect(await screen.findByText("25% of 20 MB")).toBeTruthy();
    expect(field).toHaveProperty("value", "");

    emitIngest(ingest({ bytesDone: 20 * 1024 * 1024 }));
    expect(await screen.findByText("100% of 20 MB")).toBeTruthy();
  });

  it("drops a finished download from the bar and tells the shell about the note", async () => {
    // The note is created by a task that outlives the click, and the notes
    // list only reloads on an explicit action. Without this the download
    // finishes and nothing appears.
    const completed: string[] = [];
    mocks.listActiveIngests.mockResolvedValue([ingest()]);
    render(<ImportLinkBar onCompleted={(noteId) => completed.push(noteId)} />);
    expect(await screen.findByText("Episode 42")).toBeTruthy();

    emitIngest(ingest({ status: "done", noteId: "note-9" }));

    await waitFor(() => expect(screen.queryByText("Episode 42")).toBeNull());
    expect(completed).toEqual(["note-9"]);
  });

  it("does not announce a note for a download that failed", async () => {
    const completed: string[] = [];
    mocks.listActiveIngests.mockResolvedValue([ingest()]);
    render(<ImportLinkBar onCompleted={(noteId) => completed.push(noteId)} />);
    await screen.findByText("Episode 42");

    emitIngest(ingest({ status: "failed", lastError: "404" }));

    await waitFor(() => expect(screen.getByText("404")).toBeTruthy());
    expect(completed).toEqual([]);
  });

  it("keeps a failed download visible with what went wrong", async () => {
    mocks.listActiveIngests.mockResolvedValue([
      ingest({ status: "failed", lastError: "That link answered with 404 Not Found." }),
    ]);

    render(<ImportLinkBar />);

    expect(await screen.findByText("That link answered with 404 Not Found.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(mocks.discardIngest).toHaveBeenCalledWith("ingest-1");
  });

  it("stops an in-flight download by dropping its row", async () => {
    mocks.listActiveIngests.mockResolvedValue([ingest()]);
    render(<ImportLinkBar />);

    await userEvent.click(await screen.findByRole("button", { name: /stop fetching/i }));

    expect(mocks.discardIngest).toHaveBeenCalledWith("ingest-1");
  });
});
