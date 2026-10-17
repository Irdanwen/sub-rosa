// The editor settles after it opens a workflow. Refreshing what the steps
// show (prices, issues, reuse) once fed itself: each refresh redrew the
// graph, which read as a new graph, which asked for another refresh.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
        params: { text: "a red car" },
      },
      { id: "n", type: "note", label: "", position: { x: 0, y: 200 }, params: { text: "Hi" } },
      { id: "o", type: "output", label: "", position: { x: 400, y: 0 }, params: {} },
    ],
    edges: [{ id: "e", source: "p", target: "o" }],
    frames: [{ id: "f", label: "Opening", x: -40, y: -60, width: 300, height: 400 }],
  }),
  formatVersion: 2,
  origin: "mine",
  createdAt: 1,
  updatedAt: 1,
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "studio_workflow_list") return [workflow];
    if (command === "workflow_run_history") return [];
    return null;
  }),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

/** Every time the editor judges the graph anew. */
const validations = vi.hoisted(() => ({ count: 0 }));
vi.mock("../lib/studio/workflow/validator", async (original) => {
  const actual = await original<typeof import("../lib/studio/workflow/validator")>();
  return {
    ...actual,
    validateWorkflow: (...args: Parameters<typeof actual.validateWorkflow>) => {
      validations.count += 1;
      return actual.validateWorkflow(...args);
    },
  };
});

afterEach(() => vi.restoreAllMocks());

describe("the workflow editor", () => {
  it("opens a workflow with a frame and a note, and settles", async () => {
    const errors = vi.spyOn(console, "error");
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    render(<WorkflowStudio catalog={{ backend: "carpe-diem", models: [] }} />);
    await screen.findByRole("button", { name: /Cover/ }).then((card) => card.click());
    await waitFor(() => expect(screen.getByText("Opening")).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Nothing changes from here on, so nothing is judged again.
    const settled = validations.count;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(validations.count).toBe(settled);
    expect(
      errors.mock.calls.filter((call) => String(call[0]).includes("Maximum update depth")),
    ).toEqual([]);
  });
});
