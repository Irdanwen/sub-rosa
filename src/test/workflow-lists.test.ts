// Lists (ADR-0117): put in place before the run like blocks. A step fed a
// list on an input that takes one thing runs once per item; an input that
// takes several gets every item, in order; a split text is put in place at
// its most lines, and a line that does not arrive is not made, nor what
// needed it, while a step taking several runs with the lines that came.

import { describe, expect, it } from "vitest";
import { estimateWorkflowCost } from "../lib/studio/workflow/cost";
import { runWorkflow } from "../lib/studio/workflow/engine";
import { liftResults, viewAt } from "../lib/studio/workflow/lift";
import { expandLists } from "../lib/studio/workflow/lists";
import {
  defaultParams,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from "../lib/studio/workflow/schema";
import { validateWorkflow } from "../lib/studio/workflow/validator";
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
  id: `${source}-${target}`,
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

describe("a list on an input that takes one thing", () => {
  const shots = graph(
    [
      step("ideas", "textList", { items: "a kite\n\n a boat \na lantern" }),
      step("pic", "image", { model: "cheap", prompt: "{{input}}, dawn" }),
      step("out", "output"),
    ],
    [wire("ideas", "pic", "prompt"), wire("pic", "out")],
  );

  it("runs what it feeds once per item, and so on down", () => {
    const flat = expandLists(shots);
    expect(flat.nodes.map((node) => node.id)).toEqual([
      "ideas#0",
      "ideas#1",
      "ideas#2",
      "pic#0",
      "pic#1",
      "pic#2",
      "out#0",
      "out#1",
      "out#2",
    ]);
    expect(flat.nodes.find((node) => node.id === "ideas#1")?.params.text).toBe("a boat");
    expect(flat.edges).toContainEqual(
      expect.objectContaining({ source: "ideas#2", target: "pic#2" }),
    );
    expect(flat.edges).toContainEqual(
      expect.objectContaining({ source: "pic#1", target: "out#1" }),
    );
    expect(validateWorkflow(flat).errors).toEqual([]);
  });

  it("is priced once per item", () => {
    const catalog: MediaCatalog = {
      backend: "carpe-diem",
      models: [{ id: "cheap", mediaType: "image", name: "Cheap", offline: false, costCredits: 4 }],
    };
    expect(estimateWorkflowCost(expandLists(shots), catalog).credits).toBe(12);
  });

  it("repeats a shorter list's last item, and drops a step fed an empty one", () => {
    const flat = expandLists(
      graph(
        [
          step("two", "textList", { items: "a\nb" }),
          step("three", "textList", { items: "x\ny\nz" }),
          step("none", "textList", { items: "" }),
          step("join", "chat", { model: "m", prompt: "{{input}}" }),
          step("lost", "chat", { model: "m", prompt: "{{input}}" }),
        ],
        [
          wire("two", "join", "prompt"),
          { ...wire("three", "join", "prompt"), id: "second" },
          wire("none", "lost", "prompt"),
        ],
      ),
    );
    const sources = (id: string) =>
      flat.edges.filter((edge) => edge.target === id).map((edge) => edge.source);
    expect(sources("join#2")).toEqual(["two#1", "three#2"]);
    expect(flat.nodes.some((node) => node.id.startsWith("lost"))).toBe(false);
  });
});

describe("a list on an input that takes several", () => {
  it("gives every item, in order, to one step", () => {
    const flat = expandLists(
      graph(
        [
          step("pics", "imageList", { artifactIds: ["p1", "p2"] }),
          step("mix", "imageEdit", { model: "m", prompt: "together" }),
        ],
        [wire("pics", "mix", "images")],
      ),
    );
    expect(flat.nodes.map((node) => node.id)).toEqual(["pics#0", "pics#1", "mix"]);
    expect(flat.edges.filter((edge) => edge.target === "mix").map((edge) => edge.source)).toEqual([
      "pics#0",
      "pics#1",
    ]);
    expect(flat.nodes[1].params).toMatchObject({ assetKind: "image", artifactId: "p2" });
  });
});

describe("a split text", () => {
  const split = graph(
    [
      step("text", "textInput", { text: "first line\nsecond line" }),
      step("lines", "splitText", { max: 3 }),
      step("each", "textTemplate", { template: "<{{1}}>" }),
      step("all", "textTemplate", { template: "{{1}} | {{2}} | {{3}}" }),
    ],
    [
      wire("text", "lines", "text"),
      wire("lines", "each", "values"),
      { ...wire("lines", "all", "values"), id: "gather" },
    ],
  );

  it("makes the lines that came, not the ones that did not, and gathers what came", async () => {
    // "values" takes several: each gets every line, "all" gets the ones that came.
    const flat = expandLists(split);
    const results = await runWorkflow(flat, { scheduling: "ready" });
    expect(results.get("lines#0")?.output).toEqual({ kind: "text", text: "first line" });
    expect(results.get("lines#2")).toMatchObject({
      status: "pending",
      note: expect.stringMatching(/had 2 items/),
    });
    expect(results.get("all")?.output).toEqual({
      kind: "text",
      text: "first line | second line | ",
    });
  });

  it("leaves unmade a step that needed a line that did not come, with either scheduler", async () => {
    const one = graph(
      [
        step("text", "textInput", { text: "only line" }),
        step("lines", "splitText", { max: 2 }),
        step("echo", "relay"),
      ],
      [wire("text", "lines", "text"), wire("lines", "echo", "in")],
    );
    const flat = expandLists(one);
    expect(flat.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["echo#0", "echo#1"]));
    for (const scheduling of ["levels", "ready"] as const) {
      const results = await runWorkflow(flat, { scheduling });
      expect(results.get("echo#0")?.output).toEqual({ kind: "text", text: "only line" });
      expect(results.get("echo#1")).toMatchObject({
        status: "pending",
        note: expect.stringMatching(/needed was not made/),
      });
    }
  });
});

describe("a list on the canvas", () => {
  it("shows each item's result on its step, in order", () => {
    const flat = expandLists(
      graph(
        [step("ideas", "textList", { items: "a\nb" }), step("out", "output")],
        [wire("ideas", "out")],
      ),
    );
    const results = new Map([
      [
        "ideas#1",
        {
          nodeId: "ideas#1",
          status: "done" as const,
          output: { kind: "text" as const, text: "b" },
        },
      ],
      [
        "ideas#0",
        {
          nodeId: "ideas#0",
          status: "done" as const,
          output: { kind: "text" as const, text: "a" },
        },
      ],
    ]);
    const shown = liftResults(results, viewAt({ workflow: flat, primary: new Map() }));
    expect(shown.get("ideas")?.items).toEqual([
      { kind: "text", text: "a" },
      { kind: "text", text: "b" },
    ]);
  });
});
