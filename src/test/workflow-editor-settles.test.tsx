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
    await screen.findByRole("button", { name: "Open Cover" }).then((card) => card.click());
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
    await screen.findByRole("button", { name: "Open Cover" }).then((card) => card.click());
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
    await screen.findByRole("button", { name: "Open Cover" }).then((card) => card.click());
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
    await screen.findByRole("button", { name: "Open Cover" }).then((card) => card.click());
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
    await screen.findByRole("button", { name: "Open Cover" });
  });

  it("makes a block with ⇧⌘E, sets its promoted text, and puts its steps back", async () => {
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    const { container } = render(
      <WorkflowStudio catalog={{ backend: "carpe-diem", models: [] }} />,
    );
    await screen.findByRole("button", { name: "Open Cover" }).then((card) => card.click());
    await waitFor(() => expect(screen.getByText("Opening")).toBeTruthy());
    const steps = () => container.querySelectorAll(".react-flow__node-studio").length;
    const before = steps();
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    await waitFor(() =>
      expect(container.querySelectorAll(".react-flow__node-studio.selected").length).toBe(before),
    );
    fireEvent.keyDown(window, { key: "e", metaKey: true, shiftKey: true });
    const block = await waitFor(() => {
      const found = container.querySelector(".studio-block");
      if (!found) throw new Error("no block yet");
      return found as HTMLElement;
    });
    expect(steps()).toBe(1);
    expect(within(block).getByText(`Block of ${before} steps`)).toBeTruthy();
    // The prompt's words show on the block, and this block's own value wins.
    const words = within(block).getByDisplayValue("a red car");
    fireEvent.change(words, { target: { value: "a blue bike" } });
    await waitFor(() => expect(within(block).getByDisplayValue("a blue bike")).toBeTruthy());
    // Steps are drawn hidden until measured, which jsdom never does.
    const ungroup = container.querySelector('.studio-block [aria-label="Ungroup"]');
    if (!ungroup) throw new Error("no ungroup button");
    fireEvent.click(ungroup);
    await waitFor(() => expect(steps()).toBe(before));
    expect(container.querySelector(".studio-block")).toBeNull();
    expect(screen.getByDisplayValue("a blue bike")).toBeTruthy();
  });

  it("opens a block to change it, and comes back to the workflow", async () => {
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    const { container } = render(
      <WorkflowStudio catalog={{ backend: "carpe-diem", models: [] }} />,
    );
    await screen.findByRole("button", { name: "Open Cover" }).then((card) => card.click());
    await waitFor(() => expect(screen.getByText("Opening")).toBeTruthy());
    const steps = () => container.querySelectorAll(".react-flow__node-studio").length;
    const before = steps();
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    await waitFor(() =>
      expect(container.querySelectorAll(".react-flow__node-studio.selected").length).toBe(before),
    );
    fireEvent.keyDown(window, { key: "e", metaKey: true, shiftKey: true });
    await waitFor(() => expect(container.querySelector(".studio-block")).not.toBeNull());
    // Steps are drawn hidden until measured, which jsdom never does.
    const open = await waitFor(() => {
      const found = container.querySelector('.studio-block [aria-label="Open block"]');
      if (!found) throw new Error("no open button yet");
      return found;
    });
    fireEvent.click(open);
    const crumbs = await screen.findByRole("navigation", { name: "Where you are in the workflow" });
    expect(within(crumbs).getByText("Cover")).toBeTruthy();
    await waitFor(() => expect(steps()).toBe(before));
    expect(container.querySelector(".studio-block")).toBeNull();
    // Its face: a new name, and its text no longer shown on the block.
    fireEvent.change(screen.getByLabelText("Block name"), { target: { value: "Opening shot" } });
    (container.querySelector(".studio-block-panel") as HTMLDetailsElement).open = true;
    fireEvent.click(screen.getByRole("checkbox", { name: "Prompt · Text" }));
    fireEvent.click(within(crumbs).getByRole("button", { name: "Cover" }));
    await waitFor(() => expect(steps()).toBe(1));
    expect(screen.queryByRole("navigation", { name: "Where you are in the workflow" })).toBeNull();
    const block = container.querySelector(".studio-block") as HTMLElement;
    expect((within(block).getByLabelText("Block name") as HTMLInputElement).placeholder).toBe(
      "Opening shot",
    );
    expect(within(block).queryByDisplayValue("a red car")).toBeNull();
  });

  it("keeps a block in the library and adds it to a workflow from the step search", async () => {
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    const { container } = render(
      <WorkflowStudio catalog={{ backend: "carpe-diem", models: [] }} />,
    );
    await screen.findByRole("button", { name: "Open Cover" }).then((card) => card.click());
    await waitFor(() => expect(screen.getByText("Opening")).toBeTruthy());
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    fireEvent.keyDown(window, { key: "e", metaKey: true, shiftKey: true });
    const open = await waitFor(() => {
      const found = container.querySelector('.studio-block [aria-label="Open block"]');
      if (!found) throw new Error("no open button yet");
      return found;
    });
    fireEvent.click(open);
    await screen.findByRole("navigation", { name: "Where you are in the workflow" });
    fireEvent.change(screen.getByLabelText("Block name"), { target: { value: "Poster maker" } });
    fireEvent.click(screen.getByRole("button", { name: "Save to the library", hidden: true }));
    expect(await screen.findByText("Saved in the library.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cover" }));
    await waitFor(() => expect(container.querySelectorAll(".studio-block").length).toBe(1));
    // From the step search: the saved block, as a new block step.
    fireEvent.keyDown(window, { key: "/" });
    const field = await screen.findByLabelText("Search steps");
    fireEvent.change(field, { target: { value: "poster" } });
    expect(screen.getByRole("option", { name: "Poster maker" })).toBeTruthy();
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(container.querySelectorAll(".studio-block").length).toBe(2));
  });

  it("acts on the selection from its bar, and on a frame's steps from the frame's", async () => {
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    const { container } = render(
      <WorkflowStudio catalog={{ backend: "carpe-diem", models: [] }} />,
    );
    await screen.findByRole("button", { name: "Open Cover" }).then((card) => card.click());
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
