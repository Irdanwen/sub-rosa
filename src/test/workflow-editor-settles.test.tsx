// The editor settles after it opens a workflow. Refreshing what the steps
// show (prices, issues, reuse) once fed itself: each refresh redrew the
// graph, which read as a new graph, which asked for another refresh.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("frames the selection with ⌘G, takes it back with undo, and arranges", async () => {
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    const { container } = render(
      <WorkflowStudio catalog={{ backend: "carpe-diem", models: [] }} />,
    );
    await screen.findByRole("button", { name: /Cover/ }).then((card) => card.click());
    await waitFor(() => expect(screen.getByText("Opening")).toBeTruthy());
    const frames = () => container.querySelectorAll(".react-flow__node-frame").length;
    expect(frames()).toBe(1);
    // Let the opened graph settle into the undo history first.
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    await waitFor(() =>
      expect(container.querySelectorAll(".react-flow__node-studio.selected").length).toBe(3),
    );
    fireEvent.keyDown(window, { key: "g", metaKey: true });
    await waitFor(() => expect(frames()).toBe(2));
    expect(screen.getAllByText("Untitled frame")).toHaveLength(1);
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(frames()).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(frames()).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Arrange" }));
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  });

  it("adds a note from the step search", async () => {
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    const { container } = render(
      <WorkflowStudio catalog={{ backend: "carpe-diem", models: [] }} />,
    );
    await screen.findByRole("button", { name: /Cover/ }).then((card) => card.click());
    await waitFor(() => expect(screen.getByText("Opening")).toBeTruthy());
    const notes = () => container.querySelectorAll('.studio-node[data-type="note"]').length;
    const before = notes();
    fireEvent.keyDown(window, { key: "/" });
    const field = await screen.findByLabelText("Search steps");
    fireEvent.change(field, { target: { value: "note" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(notes()).toBe(before + 1));
  });

  it("renames, starts a new workflow, deletes it on confirm, and goes back to the library", async () => {
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    render(<WorkflowStudio catalog={{ backend: "carpe-diem", models: [] }} />);
    await screen.findByRole("button", { name: /Cover/ }).then((card) => card.click());
    await waitFor(() => expect(screen.getByText("Opening")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    const name = screen.getByLabelText("Workflow name") as HTMLInputElement;
    await waitFor(() => expect(name.value).not.toBe("Cover"));
    fireEvent.change(name, { target: { value: "Scratch" } });
    expect(name.value).toBe("Scratch");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    await screen.findByRole("button", { name: /Cover/ });
  });

  it("acts on the selection from its bar, and on a frame's steps from the frame's", async () => {
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    const { container } = render(
      <WorkflowStudio catalog={{ backend: "carpe-diem", models: [] }} />,
    );
    await screen.findByRole("button", { name: /Cover/ }).then((card) => card.click());
    await waitFor(() => expect(screen.getByText("Opening")).toBeTruthy());
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    const bar = await screen.findByRole("toolbar", { name: "Selected steps" });
    const press = (name: string) => fireEvent.click(within(bar).getByRole("button", { name }));
    press("Skip the selected steps");
    await waitFor(() =>
      expect(container.querySelectorAll('.studio-node[data-mode="bypass"]').length).toBe(3),
    );
    press("Pin in place");
    press("Colour");
    fireEvent.click(within(bar).getByRole("button", { name: "Blue" }));
    await waitFor(() =>
      expect(container.querySelectorAll('.studio-node[data-color="blue"]').length).toBe(3),
    );
    press("Align left");
    press("Align top");
    press("Spread evenly");
    press("Duplicate");
    await waitFor(() =>
      expect(container.querySelectorAll(".react-flow__node-studio").length).toBe(6),
    );
    // The copies come out selected: delete them from the same bar.
    fireEvent.click(
      within(await screen.findByRole("toolbar", { name: "Selected steps" })).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".react-flow__node-studio").length).toBe(3),
    );
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    fireEvent.click(
      within(await screen.findByRole("toolbar", { name: "Selected steps" })).getByRole("button", {
        name: "Collapse",
      }),
    );
    // The frame's own bar, once its title is clicked.
    const frameBar = async () => {
      fireEvent.click(container.querySelector(".studio-frame-title") as Element);
      return screen.findByRole("toolbar", { name: "Frame actions" });
    };
    let actions = await frameBar();
    fireEvent.click(within(actions).getByRole("button", { name: "Colour" }));
    fireEvent.click(within(actions).getByRole("button", { name: "Rose" }));
    await waitFor(() =>
      expect(container.querySelector('.studio-frame[data-color="rose"]')).not.toBeNull(),
    );
    actions = await frameBar();
    fireEvent.click(
      within(actions).getByRole("button", { name: "Select the steps in this frame" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("toolbar", { name: "Frame actions" })).toBeNull(),
    );
    actions = await frameBar();
    const before = container.querySelectorAll(".react-flow__node-frame").length;
    fireEvent.click(
      within(actions).getByRole("button", { name: "Remove the frame, keep its steps" }),
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".react-flow__node-frame").length).toBe(before - 1),
    );
    expect(container.querySelectorAll(".react-flow__node-studio").length).toBe(3);
  });
});
