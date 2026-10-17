// What the canvas knows before a run, from the hook that works it out: a
// list's items and the steps it copies are seen as the steps drawn, so their
// results and prices show on them (ADR-0117).

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

import { useRunPicture } from "../components/studio/workflow/useRunPicture";
import { liftResults } from "../lib/studio/workflow/lift";
import { defaultParams, type Workflow } from "../lib/studio/workflow/schema";

const workflow: Workflow = {
  id: "w",
  name: "W",
  nodes: [
    {
      id: "lines",
      type: "textList",
      label: "",
      position: { x: 0, y: 0 },
      params: { ...defaultParams("textList"), items: "one\ntwo" },
    },
    {
      id: "voice",
      type: "tts",
      label: "",
      position: { x: 0, y: 0 },
      params: { ...defaultParams("tts"), model: "tts-kokoro" },
    },
  ],
  edges: [{ id: "e", source: "lines", target: "voice", targetPort: "text" }],
  createdAt: 0,
  updatedAt: 0,
};

describe("the run picture", () => {
  it("sees a list's items and copies as the steps drawn", () => {
    const { result } = renderHook(() =>
      useRunPicture(workflow, { backend: "carpe-diem", models: [] }, 0),
    );
    const view = result.current.stepView;
    if (!view) throw new Error("no view");
    expect(view.groups.get("voice")).toEqual(["voice#0", "voice#1"]);
    expect(view.groups.get("lines")).toEqual(["lines#0", "lines#1"]);
    const made = new Map([
      [
        "voice#0",
        {
          nodeId: "voice#0",
          status: "done" as const,
          output: { kind: "text" as const, text: "a" },
        },
      ],
      [
        "voice#1",
        {
          nodeId: "voice#1",
          status: "done" as const,
          output: { kind: "text" as const, text: "b" },
        },
      ],
    ]);
    expect(liftResults(made, view).get("voice")?.items).toHaveLength(2);
    // Both copies are priced, on the step drawn.
    expect(result.current.priceByNode.get("voice")?.kind).toBe("metered");
  });
});
