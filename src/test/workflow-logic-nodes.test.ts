// Logic steps: a text template fills its blanks in order; a preview never
// runs; a switch set by a setting is resolved before the run and what only
// its other side needed is not made; a switch decided by its condition
// starts neither side until it knows, then only the chosen one, and the
// bill counts the dearer side.

import { describe, expect, it } from "vitest";
import { estimateWorkflowCost } from "../lib/studio/workflow/cost";
import { runWorkflow } from "../lib/studio/workflow/engine";
import { applyModes } from "../lib/studio/workflow/modes";
import {
  defaultParams,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from "../lib/studio/workflow/schema";
import { decideSwitch } from "../lib/studio/workflow/switches";
import type { MediaCatalog } from "../lib/studio/types";

const step = (id: string, type: WorkflowNode["type"], params: Record<string, unknown> = {}) =>
  ({
    id,
    type,
    label: id,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(type), ...params },
  }) as WorkflowNode;
const wire = (source: string, target: string, targetPort?: string): WorkflowEdge => ({
  id: `${source}-${target}-${targetPort ?? ""}`,
  source,
  target,
  targetPort,
});
const graph = (nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow => ({
  id: "w",
  name: "W",
  nodes,
  edges,
  createdAt: 0,
  updatedAt: 0,
});

describe("a text template", () => {
  it("fills its blanks with the connected texts, in their order", async () => {
    const run = await runWorkflow(
      graph(
        [
          step("who", "textInput", { text: "a red kite" }),
          step("where", "textInput", { text: "over rooftops" }),
          step("line", "textTemplate", { template: "{{1}} {{2}}, {{3}}." }),
        ],
        [wire("who", "line", "values"), wire("where", "line", "values")],
      ),
    );
    expect(run.get("line")?.output).toEqual({ kind: "text", text: "a red kite over rooftops, ." });
  });
});

describe("a preview", () => {
  it("never runs", () => {
    const shown = applyModes(
      graph([step("t", "textInput", { text: "x" }), step("p", "preview")], [wire("t", "p", "in")]),
    );
    expect(shown.nodes.map((node) => node.id)).toEqual(["t"]);
  });
});

describe("a switch set by a setting", () => {
  it("passes on its side, and what only the other side needed is not made", () => {
    const shown = applyModes(
      graph(
        [
          step("shared", "textInput", { text: "a kite" }),
          step("onlyA", "chat", { model: "m", prompt: "{{input}} as a poem" }),
          step("onlyB", "chat", { model: "m", prompt: "{{input}} as a haiku" }),
          step("pick", "switch", { branch: "b" }),
          step("out", "output"),
        ],
        [
          wire("shared", "onlyA", "prompt"),
          wire("shared", "onlyB", "prompt"),
          wire("onlyA", "pick", "a"),
          wire("onlyB", "pick", "b"),
          wire("pick", "out"),
        ],
      ),
    );
    expect(shown.nodes.map((node) => node.id).sort()).toEqual(["onlyB", "out", "shared"]);
    expect(shown.edges).toContainEqual(expect.objectContaining({ source: "onlyB", target: "out" }));
  });
});

describe("a switch decided by its condition", () => {
  const live = (condition: string) =>
    graph(
      [
        step("cond", "textInput", { text: condition }),
        step("sideA", "textTemplate", { template: "made A" }),
        step("sideB", "textTemplate", { template: "made B" }),
        step("pick", "switch", { contains: "yes" }),
        step("out", "output"),
      ],
      [
        wire("cond", "pick", "when"),
        wire("sideA", "pick", "a"),
        wire("sideB", "pick", "b"),
        wire("pick", "out"),
      ],
    );

  it("makes only the side its condition picks, and says why the other was not made", async () => {
    const run = await runWorkflow(live("Yes, keep it."), { scheduling: "ready" });
    expect(run.get("sideA")?.status).toBe("done");
    expect(run.get("sideB")).toMatchObject({
      status: "pending",
      note: expect.stringMatching(/other side/),
    });
    expect(run.get("pick")?.output).toEqual({ kind: "text", text: "made A" });
    const other = await runWorkflow(live("No."), { scheduling: "ready" });
    expect(other.get("sideA")?.status).toBe("pending");
    expect(other.get("pick")?.output).toEqual({ kind: "text", text: "made B" });
  });

  it("is billed for its dearer side, since either may run", () => {
    const catalog: MediaCatalog = {
      backend: "carpe-diem",
      models: [
        { id: "cheap", mediaType: "image", name: "Cheap", offline: false, costCredits: 4 },
        { id: "dear", mediaType: "image", name: "Dear", offline: false, costCredits: 9 },
      ],
    };
    const estimate = estimateWorkflowCost(
      graph(
        [
          step("cond", "textInput", { text: "yes" }),
          step("a", "image", { model: "cheap", prompt: "x" }),
          step("b", "image", { model: "dear", prompt: "y" }),
          step("pick", "switch"),
        ],
        [wire("cond", "pick", "when"), wire("a", "pick", "a"), wire("b", "pick", "b")],
      ),
      catalog,
    );
    expect(estimate.credits).toBe(9);
  });
});

describe("a condition", () => {
  it("takes A when it says the words, in any case, else B", () => {
    expect(decideSwitch({ contains: "yes" }, "YES, keep it")).toBe("a");
    expect(decideSwitch({ contains: "yes" }, "no")).toBe("b");
    expect(decideSwitch({ contains: "" }, "anything")).toBe("a");
    expect(decideSwitch({ contains: "" }, "  ")).toBe("b");
  });
});

describe("a setting taken from a connection", () => {
  it("grows an input of its own, and is not missing while it waits for it", async () => {
    const { NODE_SCHEMAS, openInputPorts } = await import("../lib/studio/workflow/schema");
    const { validateWorkflow } = await import("../lib/studio/workflow/validator");
    const node = step("last", "lastFrame", { fedParams: ["position"] });
    expect(openInputPorts(NODE_SCHEMAS.lastFrame, node.params).map((port) => port.id)).toEqual([
      "video",
      "param:position",
    ]);
    const template = step("line", "textTemplate", { template: "", fedParams: ["template"] });
    expect(
      validateWorkflow(graph([template], [])).errors.filter(
        (issue) => issue.code === "missingSetting",
      ),
    ).toEqual([]);
  });

  it("takes what arrives, a closed choice only among its choices", async () => {
    const { withFedParams } = await import("../lib/studio/workflow/execute-node");
    const node = step("last", "lastFrame", { position: "end", fedParams: ["position"] });
    const text = (value: string) =>
      new Map([["param:position", [{ kind: "text" as const, text: value }]]]);
    expect(withFedParams(node, text("START")).params.position).toBe("start");
    expect(withFedParams(node, text("  ")).params.position).toBe("end");
    expect(() => withFedParams(node, text("middle"))).toThrow(/cannot be middle/);
  });

  it("is never the model, a prompt, or a choice the model's quote depends on", async () => {
    const { NODE_SCHEMAS, canFeedParam } = await import("../lib/studio/workflow/schema");
    const video = NODE_SCHEMAS.video.params;
    const feedable = video.filter(canFeedParam).map((param) => param.name);
    expect(feedable).not.toContain("model");
    expect(feedable).not.toContain("prompt");
    expect(feedable).not.toContain("duration");
  });
});
