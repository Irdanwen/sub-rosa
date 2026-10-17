/**
 * Editing the canvas like a desktop editor: undo steps that skip repeats and
 * stop at fifty, copied steps that paste back with new ids beside the
 * originals (with their incoming connections on request), shortcuts that
 * leave fields alone, the clipboard through DOM events, and the canvas's
 * actions offered to the ⌘K palette while it is open.
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCanvasEditing } from "../components/studio/workflow/useCanvasEditing";
import { useContextualCommands } from "../lib/contextual-commands";
import { copySteps, pasteSteps, readClip } from "../lib/studio/workflow/clipboard";
import { GraphHistory, type GraphSnapshot } from "../lib/studio/workflow/history";
import type { WorkflowNode } from "../lib/studio/workflow/schema";

function step(id: string, x = 0): WorkflowNode {
  return { id, type: "textInput", label: "", position: { x, y: 0 }, params: { text: id } };
}

const graph = (...ids: string[]): GraphSnapshot => ({
  nodes: ids.map((id) => step(id)),
  edges: [],
});

describe("undo history", () => {
  it("steps back and forth, skips repeats, and forgets redo on a new change", () => {
    const history = new GraphHistory();
    history.reset(graph("a"));
    history.record(graph("a"));
    expect(history.canUndo()).toBe(false);
    history.record(graph("a", "b"));
    history.record(graph("a", "b", "c"));
    expect(history.undo()?.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(history.undo()?.nodes.map((node) => node.id)).toEqual(["a"]);
    expect(history.undo()).toBeUndefined();
    expect(history.redo()?.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    history.record(graph("a", "z"));
    expect(history.canRedo()).toBe(false);
  });

  it("keeps fifty steps", () => {
    const history = new GraphHistory();
    history.reset(graph("start"));
    for (let index = 0; index < 60; index += 1) history.record(graph(`n${index}`));
    let steps = 0;
    while (history.undo()) steps += 1;
    expect(steps).toBe(50);
  });
});

describe("copied steps", () => {
  const source: GraphSnapshot = {
    nodes: [step("a", 0), step("b", 100), step("outside", 200)],
    edges: [
      { id: "ab", source: "a", target: "b", targetPort: "prompt" },
      { id: "in", source: "outside", target: "a", targetPort: "prompt" },
    ],
  };

  it("paste back with new ids, beside the originals, wired among themselves", () => {
    const clip = readClip(copySteps(source, new Set(["a", "b"])));
    if (!clip) throw new Error("expected copied steps");
    expect(clip.nodes).toHaveLength(2);
    let next = 0;
    const pasted = pasteSteps(clip, new Set(["a", "b", "outside"]), false, () => {
      next += 1;
      return `new${next}`;
    });
    expect(pasted.nodes.map((node) => node.id)).toEqual(["new1", "new2"]);
    expect(pasted.nodes[0].position).toEqual({ x: 48, y: 48 });
    expect(pasted.edges).toEqual([
      { id: "new3", source: "new1", target: "new2", targetPort: "prompt" },
    ]);
  });

  it("keep their incoming connections when pasted with connections", () => {
    const clip = readClip(copySteps(source, new Set(["a"])));
    if (!clip) throw new Error("expected copied steps");
    const pasted = pasteSteps(clip, new Set(["outside"]), true);
    expect(pasted.edges).toHaveLength(1);
    expect(pasted.edges[0].source).toBe("outside");
    // Not when the step they came from is not on this canvas.
    expect(pasteSteps(clip, new Set(), true).edges).toEqual([]);
  });

  it("refuse text that is not copied steps", () => {
    expect(readClip("hello")).toBeUndefined();
    expect(readClip(JSON.stringify({ format: "other", version: 1 }))).toBeUndefined();
  });
});

describe("the canvas's keys and clipboard", () => {
  function setup(selected = new Set<string>(["a"])) {
    const applyGraph = vi.fn();
    const addSteps = vi.fn();
    const removeSteps = vi.fn();
    const run = vi.fn();
    const props = {
      active: true,
      workflowId: "w",
      graph: graph("a"),
      selectedIds: () => selected,
      applyGraph,
      addSteps,
      selectAll: vi.fn(),
      removeSteps,
      fitView: vi.fn(),
      run,
      toggleHistory: vi.fn(),
      frameSelection: vi.fn() as (() => void) | undefined,
    };
    const hook = renderHook((current) => useCanvasEditing(current), { initialProps: props });
    return { hook, props, applyGraph, addSteps, removeSteps, run };
  }

  it("undoes a settled change with ⌘Z, and leaves keys typed into a field alone", async () => {
    vi.useFakeTimers();
    const { hook, props, applyGraph } = setup();
    hook.rerender({ ...props, graph: graph("a", "b") });
    await act(async () => vi.advanceTimersByTime(400));
    const field = document.createElement("textarea");
    document.body.append(field);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
    expect(applyGraph).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true }));
    expect(applyGraph).toHaveBeenCalledWith(graph("a"));
    field.remove();
    vi.useRealTimers();
  });

  it("keeps a version on ⌘S", () => {
    const saveVersion = vi.fn();
    const { hook, props } = setup();
    hook.rerender({ ...props, saveVersion } as typeof props);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true }));
    expect(saveVersion).toHaveBeenCalledTimes(1);
  });

  it("frames the selection on ⌘G", () => {
    const frameSelection = vi.fn();
    const { hook, props } = setup();
    hook.rerender({ ...props, frameSelection });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", metaKey: true }));
    expect(frameSelection).toHaveBeenCalledTimes(1);
  });

  it("runs on ⌘↵ even from a prompt field", () => {
    const { run } = setup();
    const field = document.createElement("textarea");
    document.body.append(field);
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
    );
    expect(run).toHaveBeenCalledTimes(1);
    field.remove();
  });

  it("copies, cuts and pastes steps through the clipboard events", () => {
    const { addSteps, removeSteps } = setup();
    const data = new Map<string, string>();
    const clipboardEvent = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, "clipboardData", {
        value: {
          setData: (k: string, v: string) => data.set(k, v),
          getData: (k: string) => data.get(k) ?? "",
        },
      });
      return event;
    };
    document.dispatchEvent(clipboardEvent("copy"));
    expect(readClip(data.get("text/plain") ?? "")?.nodes.map((node) => node.id)).toEqual(["a"]);
    document.dispatchEvent(clipboardEvent("paste"));
    expect(addSteps).toHaveBeenCalledTimes(1);
    document.dispatchEvent(clipboardEvent("cut"));
    expect(removeSteps).toHaveBeenCalledWith(new Set(["a"]));
  });

  it("offers its actions to the palette while open, and withdraws them after", () => {
    const { hook } = setup();
    const palette = renderHook(() => useContextualCommands());
    expect(palette.result.current.map((command) => command.id)).toContain("workflow:undo");
    hook.unmount();
    palette.rerender();
    expect(palette.result.current).toEqual([]);
  });
});
