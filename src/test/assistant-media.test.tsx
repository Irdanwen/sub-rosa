import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatBlock } from "../lib/chat-blocks";
import {
  AssistantMediaCard,
  AssistantMediaList,
} from "../components/chat-blocks/AssistantMediaCard";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (value: string) => value }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const id = "00000000-0000-4000-8000-000000000001";
const proposal = {
  id,
  task_id: "task",
  kind: "image",
  model: "image-model",
  prompt: "A quiet garden",
  parameters: {},
  cost_credits: null,
  status: "proposed",
  artifact_file_name: null,
  error: null,
};
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(proposal);
});

describe("assistant media consent", () => {
  it("accepts only a versioned stable identifier, never inline spending arguments", () => {
    expect(
      parseChatBlock("subrosa:media", JSON.stringify({ v: 1, proposalId: id, model: "untrusted" })),
    ).toEqual({ kind: "media", proposalId: id });
    expect(parseChatBlock("subrosa:media", '{"v":1,"proposalId":"../../file"}')).toBeNull();
    expect(parseChatBlock("subrosa:media", JSON.stringify({ v: 2, proposalId: id }))).toBeNull();
  });
  it("rendering a proposal only reads state; clicking sends its ID once", async () => {
    render(<AssistantMediaCard id={id} />);
    const generate = await screen.findByRole("button", { name: "Generate" });
    expect(invoke).not.toHaveBeenCalledWith("assistant_media_execute", expect.anything());
    let finish: (value: unknown) => void = () => {};
    invoke.mockImplementation((command) =>
      command === "assistant_media_execute"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(proposal),
    );
    fireEvent.click(generate);
    fireEvent.click(generate);
    expect(invoke.mock.calls.filter(([command]) => command === "assistant_media_execute")).toEqual([
      ["assistant_media_execute", { id }],
    ]);
    await act(async () => {
      finish({ ...proposal, status: "queued" });
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Generate" })).toBeNull());
  });
  it("an uncertain submission offers no retry that could buy twice", async () => {
    invoke.mockResolvedValue({ ...proposal, status: "uncertain" });
    render(<AssistantMediaCard id={id} />);
    await screen.findByText("Submission uncertain");
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("changing a proposal cannot purchase a new ID under the old preview", async () => {
    const nextId = "00000000-0000-4000-8000-000000000002";
    const { rerender } = render(<AssistantMediaCard id={id} />);
    await screen.findByText(proposal.prompt);
    let finish: (value: unknown) => void = () => {};
    invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    rerender(<AssistantMediaCard id={nextId} />);
    expect(screen.queryByText(proposal.prompt)).toBeNull();
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    await act(async () => {
      finish({ ...proposal, id: nextId, prompt: "A different proposal" });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Generate" }));
    expect(invoke).toHaveBeenCalledWith("assistant_media_execute", { id: nextId });
    await act(async () => {
      finish({ ...proposal, id: nextId, status: "queued" });
    });
  });
  it("switching conversations discards a late response from the previous chat", async () => {
    let oldRead: (value: unknown) => void = () => {};
    invoke.mockImplementation((command, args) => {
      if (command === "assistant_media_list" && args.taskId === "old") {
        return new Promise((resolve) => {
          oldRead = resolve;
        });
      }
      if (command === "assistant_media_list") return Promise.resolve([]);
      return Promise.resolve(proposal);
    });
    const { rerender } = render(<AssistantMediaList taskId="old" />);
    rerender(<AssistantMediaList taskId="new" />);
    await act(async () => {
      oldRead([{ ...proposal, task_id: "old" }]);
    });
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("assistant_media_get", expect.anything());
  });
});
