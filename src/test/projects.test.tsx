// Projects (ADR-0085): the desktop's project context rides with a chat's
// first message and again only when it changes, a new chat started from a
// project is filed there, the settings surfaces save instructions and memory
// mode and add files, and the phone reads documents it attaches to a chat.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSettingsDialog } from "../components/folders/ProjectSettingsDialog";
import { ChatComposer } from "../components/mobile/ChatComposer";
import { ProjectSettingsScreen } from "../components/mobile/screens/ProjectSettingsScreen";
import {
  attachmentTextNote,
  isExtractableDocument,
  projectContextForSend,
  projectContextSent,
  withProjectContext,
} from "../lib/projects";
import type { AgentLiteAttachment, FolderDto } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  assignSessionToFolder: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("../lib/tauri", () => ({
  assignSessionToFolder: mocks.assignSessionToFolder,
  mobileDictationStart: vi.fn(),
  mobileDictationStop: vi.fn(),
}));

vi.mock("../lib/haptics", () => ({
  hapticImpact: vi.fn(),
  hapticNotify: vi.fn(),
  hapticSelection: vi.fn(),
}));

const FOLDER: FolderDto = {
  id: "f1",
  name: "Launch",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

const CONTEXT = {
  folderId: "f1",
  name: "Launch",
  block: "Project context: this conversation is part of the user's project",
  fingerprint: "abc",
};

function commands(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected command ${command}`);
    return handler(args);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.assignSessionToFolder.mockResolvedValue(undefined);
});

describe("desktop project context", () => {
  it("rides after Hermes' context marker, once per version, and files a new chat", async () => {
    commands({ project_context: () => CONTEXT });
    expect(await projectContextForSend(undefined, undefined)).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();

    const fresh = await projectContextForSend(undefined, "f1");
    expect(mocks.invoke).toHaveBeenCalledWith("project_context", {
      request: { folderId: "f1" },
    });
    expect(withProjectContext("Hello", fresh)).toBe(
      `Hello\n\n--- Attached Context ---\n\n${CONTEXT.block}`,
    );
    projectContextSent("session-1", fresh, true);
    expect(mocks.assignSessionToFolder).toHaveBeenCalledWith("session-1", "f1");

    // The same context is not sent twice to the same chat.
    expect(await projectContextForSend("session-1", "f1")).toBeNull();
    expect(mocks.invoke).toHaveBeenLastCalledWith("project_context", {
      request: { sessionId: "session-1" },
    });
    // A changed project is sent again.
    commands({ project_context: () => ({ ...CONTEXT, fingerprint: "def" }) });
    expect((await projectContextForSend("session-1", undefined))?.fingerprint).toBe("def");
    // An existing chat is never re-filed.
    projectContextSent("session-1", { ...CONTEXT, fingerprint: "def" }, false);
    expect(mocks.assignSessionToFolder).toHaveBeenCalledTimes(1);
  });

  it("never fails a send for its project, and leaves a chat outside one untouched", async () => {
    mocks.invoke.mockRejectedValue(new Error("offline"));
    expect(await projectContextForSend("s", undefined)).toBeNull();
    expect(withProjectContext("Hello", null)).toBe("Hello");
  });

  it("points the agent at a document's extracted text", () => {
    expect(attachmentTextNote({ textPath: "/h/workspace/uploads/plan.pptx.txt" })).toBe(
      " (its text, extracted: uploads/plan.pptx.txt)",
    );
    expect(attachmentTextNote({})).toBe("");
    expect(isExtractableDocument("Q3.PDF")).toBe(true);
    expect(isExtractableDocument("notes.md")).toBe(false);
  });
});

describe("project settings", () => {
  const project = {
    settings: { folderId: "f1", instructions: "Be brief.", memoryMode: "default" },
    files: [
      {
        id: "file-1",
        folderId: "f1",
        name: "brief.docx",
        format: "docx",
        status: "ready",
        chars: 1200,
        createdAt: "now",
        updatedAt: "now",
      },
    ],
  };

  it("saves the desktop dialog's instructions and memory mode, and adds files at once", async () => {
    const saved = vi.fn((args: Record<string, unknown>) => ({
      ...(args.request as object),
      updatedAt: "now",
    }));
    commands({
      project_get: () => project,
      project_save: saved,
      project_file_add: () => ({ ...project.files[0], id: "file-2", name: "deck.pptx" }),
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ProjectSettingsDialog open onClose={onClose} folder={FOLDER} />);
    const instructions = await screen.findByDisplayValue("Be brief.");
    expect(screen.getByText("brief.docx")).toBeTruthy();
    await user.clear(instructions);
    await user.type(instructions, "Answer in French.");
    await user.click(screen.getByLabelText(/Project only/));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["x"], "deck.pptx"));
    await screen.findByText("deck.pptx");
    expect(mocks.invoke).toHaveBeenCalledWith("project_file_add", {
      request: { folderId: "f1", name: "deck.pptx", data: expect.any(String) },
    });

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(saved).toHaveBeenCalledWith({
      request: { folderId: "f1", instructions: "Answer in French.", memoryMode: "project" },
    });
  });

  it("switches the phone's memory mode straight away", async () => {
    const saved = vi.fn((args: Record<string, unknown>) => ({
      ...(args.request as object),
      updatedAt: "now",
    }));
    commands({ project_get: () => project, project_save: saved });
    const user = userEvent.setup();
    render(<ProjectSettingsScreen folder={FOLDER} onBack={vi.fn()} />);
    await screen.findByDisplayValue("Be brief.");
    await user.click(screen.getByLabelText(/Project only/));
    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith({
        request: { folderId: "f1", instructions: "Be brief.", memoryMode: "project" },
      }),
    );
  });
});

describe("phone chat attachments", () => {
  function renderComposer(
    onAttachmentsChange: (
      update: AgentLiteAttachment[] | ((c: AgentLiteAttachment[]) => AgentLiteAttachment[]),
    ) => void,
    onError: (message: string) => void,
  ) {
    render(
      <ChatComposer
        draft=""
        onDraftChange={vi.fn()}
        attachments={[]}
        onAttachmentsChange={onAttachmentsChange}
        placeholder="Ask"
        canSend
        onSend={vi.fn()}
        onError={onError}
      />,
    );
    return document.querySelector('input[type="file"]') as HTMLInputElement;
  }

  it("reads a document on the device and attaches its text", async () => {
    commands({
      document_extract: () => ({
        name: "report.pdf",
        format: "pdf",
        text: "[Page 1]\nQuarterly figures",
        pages: 1,
        sheets: 0,
        slides: 0,
        truncated: false,
      }),
    });
    let attachments: AgentLiteAttachment[] = [];
    const onError = vi.fn();
    const user = userEvent.setup();
    const input = renderComposer((update) => {
      attachments = typeof update === "function" ? update(attachments) : update;
    }, onError);
    expect(input.accept).toContain(".docx");
    await user.upload(input, new File(["%PDF"], "report.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(attachments).toHaveLength(1));
    expect(attachments[0]).toEqual({
      kind: "text",
      name: "report.pdf",
      data: "[Page 1]\nQuarterly figures",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("says why a scanned PDF cannot be attached", async () => {
    mocks.invoke.mockRejectedValue({
      code: "document_needs_ocr",
      message:
        "This PDF has no readable text, so it is probably a scan. Export it with text recognition and attach it again.",
    });
    const onError = vi.fn();
    const user = userEvent.setup();
    const input = renderComposer(vi.fn(), onError);
    await user.upload(input, new File(["%PDF"], "scan.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toContain("probably a scan");
  });
});
