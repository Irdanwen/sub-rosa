// The frames of the open workflow: their state, the React Flow nodes drawn
// for them, and the canvas changes that concern them. A frame carries the
// steps inside it when its title is dragged; the steps it holds are decided
// when the drag starts, so passing over others picks nothing up.

import type { NodeChange } from "@xyflow/react";
import { type Dispatch, type SetStateAction, useCallback, useMemo, useRef, useState } from "react";
import { type FrameBox, frameAround, stepsInFrame } from "../../../lib/studio/workflow/frames";
import type { WorkflowFrame, WorkflowNode } from "../../../lib/studio/workflow/schema";
import { FRAME_MIN, type FrameFlowNode } from "./FrameNode";
import type { StudioFlowNode } from "./flow";

type Point = { x: number; y: number };

/** Where each step stands and how big it is drawn. */
export function stepBoxes(nodes: readonly StudioFlowNode[]): FrameBox[] {
  return nodes.map((node) => ({
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width: node.measured?.width ?? 280,
    height: node.measured?.height ?? 160,
  }));
}

export function useFrames(options: {
  readOnly: boolean;
  flowNodesRef: { current: StudioFlowNode[] };
  setFlowNodes: Dispatch<SetStateAction<StudioFlowNode[]>>;
  onModeChange: (nodeId: string, mode: WorkflowNode["mode"]) => void;
}) {
  const { readOnly, flowNodesRef, setFlowNodes, onModeChange } = options;
  const [frames, setFrames] = useState<WorkflowFrame[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const framesRef = useRef(frames);
  framesRef.current = frames;
  /** A frame being dragged: where it started, and the steps it carries. */
  const carrying = useRef(new Map<string, { from: Point; steps: Map<string, Point> }>());

  const patchFrame = useCallback((id: string, change: Partial<WorkflowFrame>) => {
    setFrames((list) => list.map((frame) => (frame.id === id ? { ...frame, ...change } : frame)));
  }, []);
  const contentsOf = useCallback(
    (id: string) => {
      const frame = framesRef.current.find((entry) => entry.id === id);
      return frame ? new Set(stepsInFrame(frame, stepBoxes(flowNodesRef.current))) : new Set();
    },
    [flowNodesRef],
  );
  const onSelectContents = useCallback(
    (id: string) => {
      const inside = contentsOf(id);
      setSelected(new Set());
      setFlowNodes((nodes) => nodes.map((node) => ({ ...node, selected: inside.has(node.id) })));
    },
    [contentsOf, setFlowNodes],
  );
  const onSkipContents = useCallback(
    (id: string, skip: boolean) => {
      for (const nodeId of contentsOf(id))
        onModeChange(nodeId as string, skip ? "bypass" : undefined);
    },
    [contentsOf, onModeChange],
  );
  const onRemoveFrame = useCallback((id: string) => {
    setFrames((list) => list.filter((frame) => frame.id !== id));
  }, []);

  /** A frame about the selected steps (⌘G). */
  const frameSelection = useCallback(() => {
    const chosen = flowNodesRef.current.filter((node) => node.selected);
    const frame = frameAround(stepBoxes(chosen), "");
    if (!frame) return;
    setFrames((list) => [...list, frame]);
    setFlowNodes((nodes) => nodes.map((node) => ({ ...node, selected: false })));
    setSelected(new Set([frame.id]));
  }, [flowNodesRef, setFlowNodes]);

  const stepsSkipped = useCallback(
    (frame: WorkflowFrame) => {
      const nodes = flowNodesRef.current;
      const inside = new Set(stepsInFrame(frame, stepBoxes(nodes)));
      return (
        inside.size > 0 &&
        nodes.every((node) => !inside.has(node.id) || node.data.wfNode.mode === "bypass")
      );
    },
    [flowNodesRef],
  );

  const frameNodes = useMemo<FrameFlowNode[]>(
    () =>
      frames.map((frame) => ({
        id: frame.id,
        type: "frame" as const,
        position: { x: frame.x, y: frame.y },
        width: frame.width,
        height: frame.height,
        // Known, so drawn at once: React Flow hides a node until measured.
        measured: { width: frame.width, height: frame.height },
        // Behind every step, and dragged by its title only.
        zIndex: -1,
        dragHandle: ".studio-frame-title",
        selectable: !readOnly,
        draggable: !readOnly,
        selected: selected.has(frame.id),
        data: {
          frame,
          readOnly,
          contentsSkipped: stepsSkipped(frame),
          onFrameChange: patchFrame,
          onSelectContents,
          onSkipContents,
          onRemoveFrame,
        },
      })),
    [
      frames,
      selected,
      readOnly,
      stepsSkipped,
      patchFrame,
      onSelectContents,
      onSkipContents,
      onRemoveFrame,
    ],
  );

  /** Take the changes that concern frames; hand back those for the steps. */
  const takeFrameChanges = useCallback(
    (changes: NodeChange<StudioFlowNode | FrameFlowNode>[]): NodeChange<StudioFlowNode>[] => {
      const ids = new Set(framesRef.current.map((frame) => frame.id));
      const rest: NodeChange<StudioFlowNode>[] = [];
      const moved = new Map<string, Point>();
      for (const change of changes) {
        const id = "id" in change ? change.id : change.item.id;
        if (!ids.has(id)) {
          rest.push(change as NodeChange<StudioFlowNode>);
          continue;
        }
        if (change.type === "select") {
          setSelected((now) => {
            const next = new Set(now);
            if (change.selected) next.add(id);
            else next.delete(id);
            return next;
          });
        } else if (change.type === "remove") {
          onRemoveFrame(id);
        } else if (change.type === "position" && change.position) {
          const position = change.position;
          patchFrame(id, { x: position.x, y: position.y });
          // A drag (not a resize from a corner) carries what is inside.
          if (change.dragging === undefined) continue;
          let carry = carrying.current.get(id);
          if (!carry) {
            const frame = framesRef.current.find((entry) => entry.id === id);
            const nodes = flowNodesRef.current;
            // Selected steps already move with a selected frame.
            const inside = frame
              ? stepsInFrame(
                  frame,
                  stepBoxes(nodes.filter((node) => !(node.selected && selected.has(id)))),
                )
              : [];
            const byId = new Map(nodes.map((node) => [node.id, node]));
            carry = {
              from: frame ? { x: frame.x, y: frame.y } : position,
              steps: new Map(
                inside.flatMap((stepId) => {
                  const node = byId.get(stepId);
                  return node && !node.data.wfNode.pinned
                    ? [[stepId, { ...node.position }] as const]
                    : [];
                }),
              ),
            };
            carrying.current.set(id, carry);
          }
          const dx = position.x - carry.from.x;
          const dy = position.y - carry.from.y;
          for (const [stepId, start] of carry.steps)
            moved.set(stepId, { x: start.x + dx, y: start.y + dy });
          if (change.dragging === false) carrying.current.delete(id);
        } else if (
          change.type === "dimensions" &&
          change.dimensions &&
          change.resizing !== undefined
        ) {
          patchFrame(id, {
            width: Math.max(FRAME_MIN.width, change.dimensions.width),
            height: Math.max(FRAME_MIN.height, change.dimensions.height),
          });
        }
      }
      if (moved.size > 0)
        setFlowNodes((nodes) =>
          nodes.map((node) => {
            const to = moved.get(node.id);
            return to
              ? {
                  ...node,
                  position: to,
                  data: { ...node.data, wfNode: { ...node.data.wfNode, position: to } },
                }
              : node;
          }),
        );
      return rest;
    },
    [flowNodesRef, setFlowNodes, patchFrame, onRemoveFrame, selected],
  );

  /** Clicking the canvas or a step leaves frames unselected. */
  const clearFrameSelection = useCallback(() => setSelected(new Set()), []);

  return {
    frames,
    setFrames,
    frameNodes,
    takeFrameChanges,
    frameSelection,
    clearFrameSelection,
  };
}
