import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { OFFLINE_PROBE_INTERVAL_MS } from "../components/notes-list/OfflineBanner";
import { isMacLikePlatform } from "../lib/platform";
import type { BootstrapResponse, NoteDto } from "../lib/tauri";

/**
 * Five journeys through the whole desktop shell over a fake Tauri bridge.
 *
 * Each one is a thing a person does on a normal day, driven from the
 * rendered App and asserted on what the bridge was asked and what the
 * screen says. They exist for the class of bug that unit tests do not see
 * and a release did ship once: every part works, the assembly does not.
 */

type TauriListener = (event: { payload: unknown }) => unknown;

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, TauriListener>(),
  listen: vi.fn((event: string, listener: TauriListener) => {
    mocks.listeners.set(event, listener);
    return Promise.resolve(vi.fn());
  }),
  getCurrentWindow: vi.fn(),
  bootstrapApp: vi.fn(),
  listNotes: vi.fn(),
  getNote: vi.fn(),
  searchEverything: vi.fn(),
  storageReport: vi.fn(),
  listNotesFailedInTransit: vi.fn(),
  carpeDiemProbeUpstream: vi.fn(),
  retryProcessing: vi.fn(),
  askNotes: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: mocks.getCurrentWindow }));
vi.mock("../lib/recording-sounds", () => ({
  playRecordingSound: vi.fn(),
  preloadRecordingSounds: vi.fn(),
}));
vi.mock("../lib/ask", () => ({
  ASK_EVENT: "june://ask",
  askNotes: mocks.askNotes,
  askCancel: vi.fn(async () => undefined),
}));

vi.mock("../lib/tauri", async () => {
  // Imported here rather than at the top: the factory is hoisted above every
  // import of this file, so a top-level binding is not initialised yet.
  const { fakeBridge } = await import("./helpers/fake-bridge");
  const actual = await vi.importActual<typeof import("../lib/tauri")>("../lib/tauri");
  return fakeBridge(actual, {
    bootstrapApp: mocks.bootstrapApp,
    listNotes: mocks.listNotes,
    getNote: mocks.getNote,
    searchEverything: mocks.searchEverything,
    storageReport: mocks.storageReport,
    listNotesFailedInTransit: mocks.listNotesFailedInTransit,
    carpeDiemProbeUpstream: mocks.carpeDiemProbeUpstream,
    retryProcessing: mocks.retryProcessing,
    // The shell gates on the sidecar; a ready one lets the journeys start.
    carpeDiemSidecarStatus: vi.fn(async () => ({ status: "ready", hasApiKey: true })),
    hermesBridgeStatus: vi.fn(async () => ({ running: false })),
    listAgentTasks: vi.fn(async () => ({ items: [] })),
    listFilms: vi.fn(async () => []),
    listActiveIngests: vi.fn(async () => []),
    previewIngestLink: vi.fn(async () => null),
    listSessionFolders: vi.fn(async () => []),
    listDictationHistory: vi.fn(async () => ({ items: [], retentionDays: 7 })),
    listDictionaryEntries: vi.fn(async () => []),
    juneVerifyUrl: vi.fn(async () => ""),
    providerModelSettings: vi.fn(async () => ({ settings: { generationModel: "" } })),
    listVeniceModels: vi.fn(async () => ({
      mode: "generation",
      modelType: "text",
      selectedModel: "",
      models: [],
    })),
    hermesAgentCliAccess: vi.fn(async () => ({ enabled: false })),
    checkRecordingSourceReadiness: vi.fn(async () => ({
      sourceMode: "microphonePlusSystem",
      sources: [
        { source: "microphone", ready: true },
        { source: "system", ready: true, permissionState: "granted" },
      ],
    })),
    getRecordingStatus: vi.fn(async () => null),
    dictationSettings: vi.fn(async () => ({
      settings: {
        pushToTalkShortcut: {
          code: "KeyD",
          label: "Ctrl+Opt+D",
          pressCount: 1,
          modifiers: { command: false, control: true, option: true, shift: false, function: false },
        },
        toggleShortcut: {
          code: "KeyT",
          label: "Ctrl+Opt+T",
          pressCount: 1,
          modifiers: { command: false, control: true, option: true, shift: false, function: false },
        },
        microphone: {},
        style: "standard",
      },
    })),
    platformCapabilities: vi.fn(async () => ({
      platform: "macos",
      systemAudio: true,
      hud: true,
      dictationHotkey: true,
      spotlight: true,
      calendar: true,
      meetingDetection: true,
      share: false,
      hermesAgent: true,
      updater: true,
    })),
  });
});

const now = "2026-09-04T09:00:00Z";

function note(overrides: Partial<NoteDto> = {}): NoteDto {
  return {
    id: "note-1",
    title: "Budget review",
    preview: "The budget holds",
    processingStatus: "ready",
    folderIds: [],
    createdAt: now,
    updatedAt: now,
    generatedContent: "The budget holds for the quarter.",
    activeTab: "notes",
    ...overrides,
  };
}

const budget = note();
const infra = note({
  id: "note-2",
  title: "Infra sync",
  preview: "Migration on Monday",
  generatedContent: "The migration is on Monday, after the freeze.",
});

/** The shell launches on the agent; the notes are one click away. */
async function goToNotes() {
  await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
}

async function openPalette() {
  // ⌘K on a Mac-like platform, Ctrl+K elsewhere: the same predicate the
  // sidebar uses decides, so the journey follows what jsdom reports.
  const mac = isMacLikePlatform();
  fireEvent.keyDown(window, { key: "k", metaKey: mac, ctrlKey: !mac });
  return await screen.findByRole("dialog", { name: "Search" });
}

describe("desktop journeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.getCurrentWindow.mockReturnValue({
      startDragging: vi.fn().mockResolvedValue(undefined),
    });
    const payload: BootstrapResponse = {
      folders: [],
      notes: [budget, infra],
      activeRecoveries: [],
      providerConfigured: true,
    };
    mocks.bootstrapApp.mockResolvedValue(payload);
    mocks.listNotes.mockResolvedValue({ items: [budget, infra] });
    mocks.getNote.mockImplementation(async (id: string) => (id === "note-2" ? infra : budget));
    mocks.searchEverything.mockResolvedValue([]);
    mocks.storageReport.mockResolvedValue({
      buckets: [
        {
          id: "database",
          label: "Database",
          note: "Notes, transcripts, memories.",
          bytes: 2_097_152,
          files: 1,
          purgeable: false,
        },
        {
          id: "recordings",
          label: "Recordings",
          note: "Audio kept after transcription.",
          bytes: 52_428_800,
          files: 12,
          purgeable: true,
        },
      ],
      totalBytes: 54_525_952,
      measuredAt: now,
    });
    mocks.listNotesFailedInTransit.mockResolvedValue([]);
    mocks.carpeDiemProbeUpstream.mockResolvedValue({ reachable: true, message: "" });
    mocks.retryProcessing.mockResolvedValue(undefined);
  });

  it("recovers when the initial notes read fails", async () => {
    mocks.bootstrapApp.mockRejectedValueOnce(new Error("Notes temporarily unavailable"));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Notes temporarily unavailable");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await goToNotes();
    expect(await screen.findByText("Budget review")).toBeInTheDocument();
    expect(mocks.bootstrapApp).toHaveBeenCalledTimes(2);
  });

  it("1. launches on the notes, and opens the one you click", async () => {
    render(<App />);
    await goToNotes();
    expect(await screen.findByText("Infra sync")).toBeInTheDocument();
    expect(screen.getByText("Budget review")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Infra sync"));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-2"));
    expect(await screen.findByText(/The migration is on Monday/)).toBeInTheDocument();
  });

  it("2. finds a note by a word inside it, from the palette", async () => {
    mocks.searchEverything.mockResolvedValue([
      {
        kind: "note",
        targetId: "note-2",
        title: "Infra sync",
        excerpt: `The migration is on Monday`,
        updatedAt: now,
        rank: -1,
      },
    ]);
    render(<App />);
    await goToNotes();
    await screen.findByText("Infra sync");
    const palette = await openPalette();
    await userEvent.type(within(palette).getByRole("searchbox"), "migration");
    await waitFor(() => expect(mocks.searchEverything).toHaveBeenCalledWith("migration", 12));
    // The palette lists the note once: a hit that is also a recent item
    // stays under Recents rather than appearing twice.
    const [hit] = await within(palette).findAllByRole("button", { name: /Infra sync/ });
    await userEvent.click(hit);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-2"));
    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument();
  });

  it("3. asks the notes a question and opens the note the answer cites", async () => {
    mocks.askNotes.mockResolvedValue({
      answer: "The migration is on Monday, after the freeze [1].",
      citations: [
        { index: 1, noteId: "note-2", title: "Infra sync", kind: "note", excerpt: "Monday" },
      ],
      sent: [{ index: 1, noteId: "note-2", title: "Infra sync", kind: "note", excerpt: "Monday" }],
      invented: [],
      promptVersion: 1,
    });
    render(<App />);
    await goToNotes();
    await screen.findByText("Infra sync");
    const palette = await openPalette();
    await userEvent.type(within(palette).getByRole("searchbox"), "When is the migration?");
    await userEvent.click(
      await within(palette).findByText("Ask your notes: When is the migration?"),
    );
    await waitFor(() =>
      expect(mocks.askNotes).toHaveBeenCalledWith(
        "When is the migration?",
        expect.any(String),
        undefined,
        [],
      ),
    );
    const answer = await screen.findByRole("dialog", { name: "Answer from your notes" });
    expect(within(answer).getByText(/after the freeze/)).toBeInTheDocument();
    await userEvent.click(within(answer).getByRole("button", { name: /Infra sync/ }));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-2"));
    expect(
      screen.queryByRole("dialog", { name: "Answer from your notes" }),
    ).not.toBeInTheDocument();
  });

  it("4. reaches Settings › Storage from the palette and reads the sizes", async () => {
    render(<App />);
    await goToNotes();
    await screen.findByText("Infra sync");
    const palette = await openPalette();
    await userEvent.type(within(palette).getByRole("searchbox"), "storage");
    await userEvent.click(await within(palette).findByRole("button", { name: /^Storage/ }));
    // Settings is loaded on demand (src/app/lazy-views.tsx); the heading
    // appearing is the proof that the split did not break the route.
    expect(
      await screen.findByRole("heading", { name: "Storage" }, { timeout: 4000 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(mocks.storageReport).toHaveBeenCalled());
    expect(await screen.findByText("Recordings")).toBeInTheDocument();
  });

  it("5. says when you are offline, and retries every waiting note in one gesture", async () => {
    const failed = note({
      id: "note-2",
      title: "Infra sync",
      processingStatus: "failed",
      generatedContent: undefined,
    });
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [budget, failed],
      activeRecoveries: [],
      providerConfigured: true,
    });
    mocks.listNotes.mockResolvedValue({ items: [budget, failed] });
    mocks.listNotesFailedInTransit.mockResolvedValue(["note-2"]);
    mocks.carpeDiemProbeUpstream.mockResolvedValue({ reachable: false, message: "Unreachable" });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<App />);
      await goToNotes();
      expect(
        await screen.findByText("You are offline. 1 note is waiting to be processed."),
      ).toBeInTheDocument();
      // Retrying while offline would only fail again; the button waits.
      expect(screen.getByRole("button", { name: "Retry all" })).toBeDisabled();
      // The endpoint comes back; the next probe (every thirty seconds) sees it.
      mocks.carpeDiemProbeUpstream.mockResolvedValue({ reachable: true, message: "" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OFFLINE_PROBE_INTERVAL_MS + 50);
      });
      expect(
        await screen.findByText("The connection is back. 1 note is waiting to be processed."),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Retry all" }));
      await waitFor(() => expect(mocks.retryProcessing).toHaveBeenCalledWith("note-2"));
    } finally {
      vi.useRealTimers();
    }
  });
});
