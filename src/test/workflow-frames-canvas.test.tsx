// The frames on the canvas: dragging one by its title carries the steps it
// held when the drag began (and only those), a corner resizes it, Delete
// removes it and keeps its steps, and its bar selects or skips what it holds.

import { ReactFlowProvider } from "@xyflow/react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FrameNode, type FrameNodeData } from "../components/studio/workflow/FrameNode";
import type { StudioFlowNode } from "../components/studio/workflow/flow";
import { useFrames } from "../components/studio/workflow/useFrames";
import type { WorkflowNode } from "../lib/studio/workflow/schema";

function step(id: string, x: number, y: number, extra: Partial<WorkflowNode> = {}): StudioFlowNode {
  const wfNode: WorkflowNode = {
    id,
    type: "textInput",
    label: "",
    position: { x, y },
    params: {},
    ...extra,
  };
  return {
    id,
    type: "studio",
    position: { x, y },
    measured: { width: 100, height: 50 },
    data: { wfNode } as StudioFlowNode["data"],
  };
}

function setup(initial: StudioFlowNode[]) {
  const onModeChange = vi.fn();
  const hook = renderHook(() => {
    const [nodes, setNodes] = useState(initial);
    const ref = { current: nodes };
    const frames = useFrames({
      readOnly: false,
      flowNodesRef: ref,
      setFlowNodes: setNodes,
      onModeChange,
    });
    return { nodes, frames };
  });
  return { hook, onModeChange };
}

const FRAME = { id: "f", label: "Opening", x: 0, y: 0, width: 400, height: 300 };

describe("a frame on the canvas", () => {
  it("carries the steps it held when its drag began, and only those", () => {
    const { hook } = setup([
      step("in", 50, 100),
      step("out", 600, 100),
      step("pinned", 200, 100, { pinned: true }),
    ]);
    act(() => hook.result.current.frames.setFrames([FRAME]));
    expect(hook.result.current.frames.frameNodes).toHaveLength(1);
    const drag = (x: number, y: number, dragging: boolean) =>
      act(() => {
        const rest = hook.result.current.frames.takeFrameChanges([
          { type: "position", id: "f", position: { x, y }, dragging },
        ]);
        expect(rest).toEqual([]);
      });
    drag(10, 20, true);
    drag(500, 20, true);
    drag(500, 20, false);
    const at = (id: string) => hook.result.current.nodes.find((node) => node.id === id)?.position;
    // The step inside moved with the frame; the one passed over did not
    // join, and a pinned one stays where it was put.
    expect(at("in")).toEqual({ x: 550, y: 120 });
    expect(at("out")).toEqual({ x: 600, y: 100 });
    expect(at("pinned")).toEqual({ x: 200, y: 100 });
    expect(hook.result.current.frames.frames[0]).toMatchObject({ x: 500, y: 20 });
  });

  it("resizes from a corner without carrying anything, never below its minimum", () => {
    const { hook } = setup([step("in", 50, 100)]);
    act(() => hook.result.current.frames.setFrames([FRAME]));
    act(() => {
      hook.result.current.frames.takeFrameChanges([
        { type: "position", id: "f", position: { x: -20, y: -20 } },
        { type: "dimensions", id: "f", resizing: true, dimensions: { width: 50, height: 600 } },
      ]);
    });
    expect(hook.result.current.frames.frames[0]).toMatchObject({
      x: -20,
      y: -20,
      width: 200,
      height: 600,
    });
    expect(hook.result.current.nodes[0].position).toEqual({ x: 50, y: 100 });
  });

  it("hands the steps' own changes back, and is removed alone on Delete", () => {
    const { hook } = setup([step("in", 50, 100)]);
    act(() => hook.result.current.frames.setFrames([FRAME]));
    let rest: unknown[] = [];
    act(() => {
      rest = hook.result.current.frames.takeFrameChanges([
        { type: "select", id: "f", selected: true },
        { type: "select", id: "in", selected: false },
        { type: "remove", id: "f" },
      ]);
    });
    expect(rest).toEqual([{ type: "select", id: "in", selected: false }]);
    expect(hook.result.current.frames.frames).toEqual([]);
    expect(hook.result.current.nodes).toHaveLength(1);
  });

  it("is drawn about the selection, which then gives way to it", () => {
    const { hook } = setup([
      { ...step("a", 0, 0), selected: true },
      { ...step("b", 300, 200), selected: true },
      step("c", 900, 900),
    ]);
    act(() => hook.result.current.frames.frameSelection());
    const [frame] = hook.result.current.frames.frames;
    expect(frame).toMatchObject({ x: -32, y: -68, width: 464, height: 350, label: "" });
    expect(hook.result.current.nodes.every((node) => !node.selected)).toBe(true);
    expect(hook.result.current.frames.frameNodes[0].selected).toBe(true);
  });

  it("selects or skips the steps it holds from its bar", () => {
    const { hook, onModeChange } = setup([step("in", 50, 100), step("out", 600, 100)]);
    act(() => hook.result.current.frames.setFrames([FRAME]));
    const data = hook.result.current.frames.frameNodes[0].data;
    act(() => data.onSelectContents("f"));
    expect(hook.result.current.nodes.map((node) => Boolean(node.selected))).toEqual([true, false]);
    act(() => data.onSkipContents("f", true));
    expect(onModeChange).toHaveBeenCalledWith("in", "bypass");
    expect(onModeChange).toHaveBeenCalledTimes(1);
    act(() => data.onFrameChange("f", { color: "blue", label: "Act one" }));
    expect(hook.result.current.frames.frames[0]).toMatchObject({ color: "blue", label: "Act one" });
  });
});

describe("a frame's title and bar", () => {
  function draw(overrides: Partial<FrameNodeData> = {}, selected = true) {
    const data: FrameNodeData = {
      frame: { ...FRAME, label: "" },
      readOnly: false,
      contentsSkipped: false,
      onFrameChange: vi.fn(),
      onSelectContents: vi.fn(),
      onSkipContents: vi.fn(),
      onRemoveFrame: vi.fn(),
      ...overrides,
    };
    render(
      <ReactFlowProvider>
        <FrameNode data={data} selected={selected} />
      </ReactFlowProvider>,
    );
    return data;
  }

  it("is renamed by a double-click, and tells an unnamed frame apart", () => {
    const data = draw();
    fireEvent.doubleClick(screen.getByText("Untitled frame"));
    const field = screen.getByLabelText("Frame name");
    fireEvent.change(field, { target: { value: "  Act one " } });
    fireEvent.blur(field);
    expect(data.onFrameChange).toHaveBeenCalledWith("f", { label: "Act one" });
  });

  it("is never renamed in a workflow shown read-only", () => {
    draw({ readOnly: true }, false);
    fireEvent.doubleClick(screen.getByText("Untitled frame"));
    expect(screen.queryByLabelText("Frame name")).toBeNull();
  });
});
