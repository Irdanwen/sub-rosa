import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  actionExecute,
  carpeDiemCacheStats,
  checkRecordingSourceReadiness,
  createAgentTask,
  ensureHermesBridgeGateway,
  finishRecording,
  forkAgentTask,
  getNote,
  juneOpenCommunityPage,
  noteSummary,
  recoverRecording,
  retryProcessing,
  setAgentTaskModel,
  stageImportedFile,
  startLinkIngest,
  startRecording,
  summarizeNoteLongform,
  updateNote,
} from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

describe("Tauri command contracts", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({});
  });

  it("wraps note retrieval and updates in request payloads", async () => {
    await getNote("note-1");
    await updateNote({
      noteId: "note-1",
      title: "Updated",
      editedContent: "Manual notes",
      activeTab: "transcription",
    });

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "get_note", {
      request: { noteId: "note-1" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "update_note", {
      request: {
        noteId: "note-1",
        title: "Updated",
        editedContent: "Manual notes",
        activeTab: "transcription",
      },
    });
  });

  /// A proposed action crosses the boundary as a serde-tagged enum, which
  /// Tauri does not rename for us: whatever this sends is exactly what
  /// `crate::actions::ProposedAction` has to read. The `note` kind shipped
  /// broken for precisely this reason, so the shape is pinned on both sides.
  it("sends a proposed action exactly as Rust deserializes it", async () => {
    await actionExecute("prop-1", {
      kind: "note",
      id: "a1",
      label: "Add a line",
      noteId: "note-1",
      text: "Ana owns it.",
    });
    await actionExecute("prop-1", {
      kind: "summarize",
      id: "a2",
      label: "Read it",
      noteId: "note-1",
    });

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "action_execute", {
      request: {
        proposalId: "prop-1",
        action: {
          kind: "note",
          id: "a1",
          label: "Add a line",
          noteId: "note-1",
          text: "Ana owns it.",
        },
      },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "action_execute", {
      request: {
        proposalId: "prop-1",
        action: { kind: "summarize", id: "a2", label: "Read it", noteId: "note-1" },
      },
    });
  });

  it("sends import and long-form commands with the argument names Rust expects", async () => {
    await stageImportedFile({
      uploadId: "upload-1",
      fileName: "talk.mp3",
      base64: "AA==",
      done: true,
    });
    await startLinkIngest("https://cdn.example.com/a.mp3", "folder-1");
    await noteSummary("note-1");
    await summarizeNoteLongform("note-1");

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "stage_imported_file", {
      request: { uploadId: "upload-1", fileName: "talk.mp3", base64: "AA==", done: true },
    });
    // Loose arguments, not a request wrapper: Tauri lowerCamelCases the Rust
    // parameter names, so `folder_id` is looked up as `folderId`.
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "start_link_ingest", {
      url: "https://cdn.example.com/a.mp3",
      folderId: "folder-1",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "note_summary", { noteId: "note-1" });
    expect(mocks.invoke).toHaveBeenNthCalledWith(4, "summarize_note_longform", {
      noteId: "note-1",
    });
  });

  it("sends recording lifecycle commands with stable request shapes", async () => {
    await checkRecordingSourceReadiness("microphonePlusSystem");
    await startRecording("note-1", "microphonePlusSystem");
    await finishRecording("session-1");

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "check_recording_source_readiness", {
      request: { sourceMode: "microphonePlusSystem" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "start_recording", {
      request: { noteId: "note-1", sourceMode: "microphonePlusSystem" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "finish_recording", {
      request: { sessionId: "session-1" },
    });
  });

  it("keeps retry and recovery commands authoritative", async () => {
    await retryProcessing("note-1");
    await recoverRecording("session-1", "validate");
    await recoverRecording("session-2", "discard");

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "retry_processing", {
      request: { noteId: "note-1", step: "all" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "recover_recording", {
      request: { sessionId: "session-1", action: "validate" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "recover_recording", {
      request: { sessionId: "session-2", action: "discard" },
    });
  });

  it("invokes the Hermes gateway ensure command for routines", async () => {
    await ensureHermesBridgeGateway();

    expect(mocks.invoke).toHaveBeenCalledWith("ensure_hermes_bridge_gateway");
  });

  it("opens the June community through a dedicated command", async () => {
    await juneOpenCommunityPage();

    expect(mocks.invoke).toHaveBeenCalledWith("june_open_community_page");
  });

  it("threads the chat model through create and remembers a switch per session", async () => {
    // A new mobile chat records the model it starts on.
    await createAgentTask({ prompt: "Draft a reply", runPlaceholder: false, model: "qwen3-4b" });
    // A mid-conversation switch is persisted on the session itself.
    await setAgentTaskModel({ taskId: "task-1", model: "venice-uncensored" });

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "create_agent_task", {
      request: { prompt: "Draft a reply", runPlaceholder: false, model: "qwen3-4b" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "set_agent_task_model", {
      request: { taskId: "task-1", model: "venice-uncensored" },
    });
  });

  it("forks a chat onto another model with a stable request shape", async () => {
    await forkAgentTask({ sourceTaskId: "task-1", model: "venice-uncensored" });

    expect(mocks.invoke).toHaveBeenCalledWith("fork_agent_task", {
      request: { sourceTaskId: "task-1", model: "venice-uncensored" },
    });
  });

  // The Rust side pins that this command is registered on BOTH shells; this
  // pins the name the webview actually sends. A drift between the two is a
  // runtime-only failure, so neither half is enough on its own.
  it("reads the prompt-cache ledger by its registered command name", async () => {
    await carpeDiemCacheStats();

    expect(mocks.invoke).toHaveBeenCalledWith("carpe_diem_cache_stats");
  });
});
