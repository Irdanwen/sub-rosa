// Opening the editor must never write an empty workflow over a real one.
//
// The first render has `current` from the library and an empty canvas; the
// steps arrive with the first hydrate, one render later. The debounced save
// compared that first, empty graph with the stored one and, when the machine
// was slow enough for the debounce to fire before the hydrated render landed
// (the CI runner, a phone under load), saved it: the library then held a
// workflow with no steps, and opening it showed an empty canvas. Here the
// debounce fires at once, which is the slow machine made deterministic.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ saved: [] as string[] }));

const workflow = {
  id: "w",
  name: "Cover",
  definition: JSON.stringify({
    nodes: [
      {
        id: "p",
        type: "textInput",
        label: "Prompt",
        position: { x: 0, y: 0 },
        params: { text: "a car" },
      },
      { id: "n", type: "note", label: "", position: { x: 0, y: 200 }, params: { text: "Hi" } },
      { id: "o", type: "output", label: "", position: { x: 400, y: 0 }, params: {} },
    ],
    edges: [{ id: "e", source: "p", target: "o" }],
  }),
  formatVersion: 2,
  origin: "mine",
  createdAt: 1,
  updatedAt: 1,
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { request?: { definition?: string } }) => {
    if (command === "studio_workflow_list") return [workflow];
    if (command === "studio_workflow_save" && args?.request?.definition)
      state.saved.push(args.request.definition);
    if (command === "workflow_run_history") return [];
    return null;
  }),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const realSetTimeout = window.setTimeout;

beforeEach(() => {
  state.saved = [];
  // The save debounce (SAVE_DEBOUNCE_MS, 300 ms) fires the moment it is set:
  // what a slow machine does to it, without the slow machine.
  vi.spyOn(window, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    timeout?: number,
    ...rest: unknown[]
  ) => {
    if (timeout === 300 && typeof handler === "function") {
      handler();
      return 0;
    }
    return realSetTimeout(handler, timeout, ...rest);
  }) as typeof window.setTimeout);
});
afterEach(() => vi.restoreAllMocks());

describe("opening the editor", () => {
  it("never saves the empty canvas of a workflow whose steps have not been drawn yet", async () => {
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    render(<WorkflowStudio catalog={{ backend: "carpe-diem", models: [] }} />);
    await screen.findByRole("button", { name: "Open Cover" }).then((card) => card.click());
    await waitFor(() => expect(screen.getByDisplayValue("Hi")).toBeTruthy());
    const emptied = state.saved
      .map((definition) => JSON.parse(definition) as { nodes: unknown[] })
      .filter((definition) => definition.nodes.length === 0);
    expect(emptied).toEqual([]);
  });
});
