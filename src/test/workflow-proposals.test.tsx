// A workflow the assistant proposed (ADR-0120): a draft of its own, apart
// from the person's workflows, shown and never saved over until it is kept,
// and gone when it is discarded. The library hears of it as it arrives.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  saved: [] as Array<Record<string, unknown>>,
  deleted: [] as string[],
  handlers: new Map<string, () => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(
    async (command: string, args?: { request?: Record<string, unknown>; id?: string }) => {
      if (command === "studio_workflow_list") return state.rows;
      if (command === "workflow_run_history") return [];
      if (command === "studio_workflow_save" && args?.request) state.saved.push(args.request);
      if (command === "studio_workflow_delete" && args?.id) state.deleted.push(args.id);
      return null;
    },
  ),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    state.handlers.set(name, handler);
    return () => state.handlers.delete(name);
  }),
}));

function row(id: string, name: string, origin: string) {
  return {
    id,
    name,
    definition: JSON.stringify({
      nodes: [
        { id: "t", type: "textInput", label: "", position: { x: 0, y: 0 }, params: { text: "Hi" } },
      ],
      edges: [],
    }),
    formatVersion: 2,
    origin,
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  vi.resetModules();
  state.rows = [row("mine", "Mine", "mine")];
  state.saved = [];
  state.deleted = [];
  state.handlers.clear();
  window.localStorage.clear();
});

describe("a proposal in the store", () => {
  it("waits apart, read-only, until it is kept", async () => {
    state.rows.push(row("p", "Proposed", "assistant"));
    const store = await import("../lib/studio/workflow/store");
    await store.loadWorkflowLibrary();
    expect(store.listWorkflows().map((workflow) => workflow.id)).toEqual(["mine"]);
    const [proposal] = store.listProposals();
    expect(proposal.readOnly).toBe(true);
    // Never saved over while it is a proposal.
    store.saveWorkflow({ ...proposal, name: "Changed" });
    expect(state.saved).toEqual([]);
    const kept = store.keepProposal("p");
    expect(kept?.origin).toBe("mine");
    expect(kept?.readOnly).toBeUndefined();
    await waitFor(() => expect(state.saved.at(-1)?.origin).toBe("mine"));
    expect(
      store
        .listWorkflows()
        .map((workflow) => workflow.id)
        .sort(),
    ).toEqual(["mine", "p"]);
    expect(store.listProposals()).toEqual([]);
  });
});

describe("a proposal in the Studio", () => {
  it("appears as it arrives, opens with its choice, and is kept from there", async () => {
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    render(<WorkflowStudio catalog={{ backend: "carpe-diem", models: [] }} />);
    await screen.findByRole("button", { name: "Open Mine" });
    expect(screen.queryByRole("region", { name: "Proposed by the assistant" })).toBeNull();
    state.rows = [...state.rows, row("p", "Album covers", "assistant")];
    await act(async () => {
      state.handlers.get("subrosa://workflow-proposed")?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const section = await screen.findByRole("region", { name: "Proposed by the assistant" });
    fireEvent.click(within(section).getByRole("button", { name: "Look at Album covers" }));
    expect(
      await screen.findByText(
        "The assistant proposed this workflow. Keep it to change and run it, or discard it.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    await waitFor(() =>
      expect(state.saved.some((request) => request.id === "p" && request.origin === "mine")).toBe(
        true,
      ),
    );
    expect(screen.queryByText(/The assistant proposed this workflow/)).toBeNull();
  });

  it("is discarded from its card", async () => {
    state.rows.push(row("p", "Album covers", "assistant"));
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    render(<WorkflowStudio catalog={{ backend: "carpe-diem", models: [] }} />);
    const section = await screen.findByRole("region", { name: "Proposed by the assistant" });
    fireEvent.click(within(section).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(state.deleted).toEqual(["p"]));
    expect(screen.queryByRole("region", { name: "Proposed by the assistant" })).toBeNull();
  });
});
