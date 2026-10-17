// Another device's workflows reaching this one (ADR-0118): the library is
// read again on a sync event, a workflow this device is still writing keeps
// its place, and the open canvas follows what arrived unless it holds a
// newer edit or a run is live.

import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleArrival } from "../lib/studio/workflow/arrivals";
import type { Workflow } from "../lib/studio/workflow/schema";

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  saves: [] as Array<() => void>,
  holdSaves: false,
  handlers: new Map<string, (event: unknown) => void>(),
}));

function row(id: string, name: string, note: string, updatedAt = 1) {
  return {
    id,
    name,
    definition: JSON.stringify({
      nodes: [
        { id: "n", type: "note", label: "", position: { x: 0, y: 0 }, params: { text: note } },
      ],
      edges: [],
    }),
    formatVersion: 2,
    origin: "mine",
    createdAt: 1,
    updatedAt,
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "studio_workflow_list") return state.rows;
    if (command === "workflow_run_history") return [];
    if (command === "studio_workflow_save" && state.holdSaves)
      return new Promise<void>((resolve) => state.saves.push(resolve));
    return null;
  }),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: unknown) => void) => {
    state.handlers.set(name, handler);
    return () => state.handlers.delete(name);
  }),
}));

async function syncArrives() {
  await act(async () => {
    state.handlers.get("subrosa://sync-updated")?.({ payload: { applied: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(async () => {
  vi.resetModules();
  state.rows = [];
  state.saves = [];
  state.holdSaves = false;
  state.handlers.clear();
});

describe("a library that hears from other devices", () => {
  it("keeps a workflow this device is still writing, and takes the rest from the table", async () => {
    state.rows = [row("a", "First", "one"), row("b", "Second", "two")];
    const store = await import("../lib/studio/workflow/store");
    await store.loadWorkflowLibrary();
    state.holdSaves = true;
    const first = store.storedWorkflow("a") as Workflow;
    store.saveWorkflow({ ...first, name: "First, renamed here" });
    // Meanwhile the other device renamed the first, and deleted the second.
    state.rows = [row("a", "First, renamed there", "one", 99)];
    expect(await store.reloadWorkflowLibrary()).toBe(true);
    expect(store.listWorkflows().map((workflow) => workflow.name)).toEqual(["First, renamed here"]);
    // Its save landed: the table is the record again.
    for (const resolve of state.saves) resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await store.reloadWorkflowLibrary()).toBe(true);
    expect(store.listWorkflows().map((workflow) => workflow.name)).toEqual([
      "First, renamed there",
    ]);
    // Nothing new: nothing to redraw.
    expect(await store.reloadWorkflowLibrary()).toBe(false);
  });

  it("redraws the open workflow with what arrived, and opens the next when it is gone", async () => {
    state.rows = [row("a", "Cover", "Hi"), row("b", "Trailer", "Cut", 0)];
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    render(<WorkflowStudio catalog={{ backend: "carpe-diem", models: [] }} />);
    await screen.findByRole("button", { name: /Cover/ }).then((card) => card.click());
    await waitFor(() => expect(screen.getByDisplayValue("Hi")).toBeTruthy());

    state.rows = [row("a", "Cover", "Hi from the laptop", 5), row("b", "Trailer", "Cut", 0)];
    await syncArrives();
    await waitFor(() => expect(screen.getByDisplayValue("Hi from the laptop")).toBeTruthy());

    state.rows = [row("b", "Trailer", "Cut", 0)];
    await syncArrives();
    await waitFor(() => expect(screen.getByDisplayValue("Cut")).toBeTruthy());
  });
});

describe("what an arrival does to the canvas", () => {
  const graph = (note: string, name = "Cover"): Workflow => ({
    id: "a",
    name,
    nodes: [{ id: "n", type: "note", label: "", position: { x: 0, y: 0 }, params: { text: note } }],
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  });

  it("shows what arrived when the canvas held nothing newer", () => {
    expect(
      settleArrival({ base: graph("Hi"), fresh: graph("Hello"), canvas: graph("Hi") }),
    ).toEqual({ kind: "open", workflow: graph("Hello") });
  });

  it("keeps an edit made here since the last save, the newest thing anyone did", () => {
    expect(
      settleArrival({ base: graph("Hi"), fresh: graph("Hello"), canvas: graph("Hey") }),
    ).toEqual({ kind: "keep" });
  });

  it("keeps the canvas when it already says what arrived", () => {
    expect(settleArrival({ base: graph("Hi"), fresh: graph("Hey"), canvas: graph("Hey") })).toEqual(
      { kind: "keep" },
    );
  });

  it("moves on when the workflow was deleted elsewhere, and never for one never stored", () => {
    expect(settleArrival({ base: graph("Hi"), fresh: undefined, canvas: graph("Hi") })).toEqual({
      kind: "gone",
    });
    expect(settleArrival({ base: undefined, fresh: undefined, canvas: graph("Hi") })).toEqual({
      kind: "keep",
    });
  });

  it("counts a description changed elsewhere as a change", () => {
    expect(
      settleArrival({
        base: graph("Hi"),
        fresh: { ...graph("Hi"), description: "For the trailer" },
        canvas: graph("Hi"),
      }).kind,
    ).toBe("open");
  });
});
