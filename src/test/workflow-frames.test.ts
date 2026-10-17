// Frames and notes (ComfyUI's groups and notes): drawn about the steps,
// kept by the store and the file, read from a Comfy file, and never run.

import { describe, expect, it } from "vitest";
import { readWorkflowFile, workflowFileText } from "../lib/studio/workflow/comfy/file";
import { tintOf, translateComfy } from "../lib/studio/workflow/comfy/translate";
import { cleanFrames, frameAround, stepsInFrame } from "../lib/studio/workflow/frames";
import { sameWorkflow } from "../lib/studio/workflow/library";
import { applyModes } from "../lib/studio/workflow/modes";
import type { Workflow } from "../lib/studio/workflow/schema";
import { validateWorkflow } from "../lib/studio/workflow/validator";
import type { MediaCatalog } from "../lib/studio/types";

const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [{ id: "gpt-image-2", mediaType: "image", name: "GPT Image 2", offline: false }],
};

const box = (id: string, x: number, y: number) => ({ id, x, y, width: 100, height: 50 });

describe("a frame", () => {
  it("is drawn about the steps with room for its title", () => {
    const frame = frameAround([box("a", 0, 0), box("b", 200, 100)], "Shots", () => "f");
    expect(frame).toEqual({
      id: "f",
      label: "Shots",
      x: -32,
      y: -68,
      width: 364,
      height: 250,
    });
    expect(frameAround([], "Empty")).toBeUndefined();
  });

  it("holds the steps whose centre is inside it, not those it only touches", () => {
    const frame = { id: "f", label: "", x: 0, y: 0, width: 300, height: 200 };
    expect(
      stepsInFrame(frame, [box("in", 10, 10), box("edge", 260, 10), box("out", 400, 0)]),
    ).toEqual(["in"]);
  });

  it("is left out when it is malformed", () => {
    expect(
      cleanFrames([
        { id: "ok", label: "A", x: 0, y: 0, width: 10, height: 10, color: "blue" },
        { id: "flat", x: 0, y: 0, width: 0, height: 10 },
        { id: "nan", x: "a", y: 0, width: 10, height: 10 },
        { label: "no id", x: 0, y: 0, width: 10, height: 10 },
        "nonsense",
      ]),
    ).toEqual([{ id: "ok", label: "A", x: 0, y: 0, width: 10, height: 10, color: "blue" }]);
    expect(cleanFrames(undefined)).toEqual([]);
  });
});

const workflow: Workflow = {
  id: "w",
  name: "Cover",
  nodes: [
    {
      id: "p",
      type: "textInput",
      label: "",
      position: { x: 0, y: 0 },
      params: { text: "a red car" },
      mode: "bypass",
      color: "rose",
      pinned: true,
      collapsed: true,
    },
    {
      id: "n",
      type: "note",
      label: "",
      position: { x: 0, y: 200 },
      params: { text: "Swap the prompt for each client." },
    },
  ],
  edges: [],
  frames: [{ id: "f", label: "Prompt", x: -40, y: -60, width: 400, height: 400, color: "amber" }],
  createdAt: 0,
  updatedAt: 0,
};

describe("a workflow file", () => {
  it("keeps frames, notes, modes and layout through being written and read back", () => {
    const read = readWorkflowFile(workflowFileText(workflow), catalog, "cover.json");
    if (read.kind !== "subrosa") throw new Error("not read as a Sub Rosa file");
    expect(read.workflow.frames).toEqual([{ ...workflow.frames?.[0], id: expect.any(String) }]);
    expect(read.workflow.nodes.map(({ id: _id, ...rest }) => rest)).toEqual(
      workflow.nodes.map(({ id: _id, ...rest }) => rest),
    );
  });

  it("counts a moved frame as an edit, so it is saved", () => {
    const [frame] = workflow.frames ?? [];
    const moved = { ...workflow, frames: [{ ...frame, x: 0 }] };
    expect(sameWorkflow(workflow, { ...workflow })).toBe(true);
    expect(sameWorkflow(workflow, moved)).toBe(false);
  });
});

describe("a note", () => {
  it("never runs, and never blocks a run", () => {
    const empty: Workflow = {
      ...workflow,
      nodes: [{ ...workflow.nodes[1], params: { text: "" } }],
    };
    expect(applyModes(empty).nodes).toEqual([]);
    expect(validateWorkflow(applyModes(empty)).errors).toEqual([]);
  });
});

describe("a Comfy file", () => {
  const file = {
    nodes: [
      {
        id: 1,
        type: "Note",
        pos: [10, 20],
        mode: 0,
        widgets_values: ["Read me first."],
        inputs: [],
      },
    ],
    links: [],
    groups: [
      { title: "Load", bounding: [0, 0, 400, 300], color: "#3f789e" },
      { title: "Broken", bounding: [0, 0, -1, 10] },
    ],
  };

  it("brings its groups as frames and its notes as notes, where they were", () => {
    const { workflow: imported } = translateComfy(file, catalog);
    expect(imported.frames).toEqual([
      { id: expect.any(String), label: "Load", x: 0, y: 0, width: 400, height: 300, color: "blue" },
    ]);
    expect(imported.nodes).toEqual([
      expect.objectContaining({
        type: "note",
        position: { x: 10, y: 20 },
        params: { text: "Read me first." },
      }),
    ]);
    // Also in the description, which the library shows before it is opened.
    expect(imported.description).toBe("Read me first.");
  });

  it("maps a group's colour to the nearest tint, and a grey to none", () => {
    expect(tintOf("#3f789e")).toBe("blue");
    expect(tintOf("#a1309b")).toBe("violet");
    expect(tintOf("#8a8")).toBe("green");
    expect(tintOf("#b06634")).toBe("amber");
    expect(tintOf("#444444")).toBeUndefined();
    expect(tintOf("teal")).toBeUndefined();
  });
});
