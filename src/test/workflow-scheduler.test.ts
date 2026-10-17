/**
 * The ready queue and partial runs (ADR-0114 addendum): a step starts as
 * soon as what feeds it is done, a slow branch no longer holds back an
 * unrelated one, a failure stops only what it feeds when the caller isolates
 * failures, a held gate holds only its own branch, and running one step runs
 * exactly what it needs. Productions keep the level runner.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: vi.fn(),
}));
vi.mock("../lib/studio/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/catalog")>()),
  fetchMediaCatalog: vi.fn(async () => ({ backend: "carpe-diem", models: [] })),
}));

import { mediaJson } from "../lib/studio/client";
import { runWorkflow, WorkflowRunError } from "../lib/studio/workflow/engine";
import { pruneToTargets } from "../lib/studio/workflow/partial";
import { defaultParams, type Workflow, type WorkflowNode } from "../lib/studio/workflow/schema";
import { validateWorkflow } from "../lib/studio/workflow/validator";

const mediaJsonMock = vi.mocked(mediaJson);

function chat(id: string, prompt: string) {
  return {
    id,
    type: "chat" as const,
    label: "",
    position: { x: 0, y: 0 },
    params: { ...defaultParams("chat"), model: "m", prompt },
  } satisfies WorkflowNode;
}

/** Two branches: slow -> afterSlow, and quick -> afterQuick. */
function twoBranches(): Workflow {
  return {
    id: "w",
    name: "w",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      chat("slow", "SLOW"),
      chat("quick", "QUICK"),
      chat("afterSlow", "after {{input}}"),
      chat("afterQuick", "after {{input}}"),
    ],
    edges: [
      { id: "e1", source: "slow", target: "afterSlow", targetPort: "prompt" },
      { id: "e2", source: "quick", target: "afterQuick", targetPort: "prompt" },
    ],
  };
}

/** Answers each prompt; SLOW waits until released, FAIL throws. */
function scripted() {
  let release: () => void = () => {};
  const slowGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  mediaJsonMock.mockImplementation(async (_path: string, body?: unknown) => {
    const prompt =
      (body as { messages?: Array<{ content: string }> } | undefined)?.messages?.at(-1)?.content ??
      "";
    order.push(prompt);
    if (prompt.includes("SLOW")) await slowGate;
    if (prompt.includes("FAIL")) throw new Error("The model refused.");
    return { choices: [{ message: { content: `done: ${prompt}` } }] };
  });
  return { order, release: () => release() };
}

beforeEach(() => mediaJsonMock.mockReset());

describe("the ready queue", () => {
  it("lets an unrelated branch finish while a slow one is still working", async () => {
    const { order, release } = scripted();
    const run = runWorkflow(twoBranches(), { scheduling: "ready" });
    await vi.waitFor(() => expect(order).toContain("after done: QUICK"));
    expect(order).not.toContain("after done: SLOW");
    release();
    const results = await run;
    expect([...results.values()].every((result) => result.status === "done")).toBe(true);
  });

  it("keeps the level barrier for callers that do not ask for the queue", async () => {
    const { order, release } = scripted();
    const run = runWorkflow(twoBranches());
    await vi.waitFor(() => expect(order).toEqual(expect.arrayContaining(["SLOW", "QUICK"])));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).not.toContain("after done: QUICK");
    release();
    await run;
  });

  it("with isolated failures, stops only what the failed step feeds", async () => {
    scripted().release();
    const graph = twoBranches();
    graph.nodes[0] = chat("slow", "FAIL");
    const error = await runWorkflow(graph, { scheduling: "ready", isolateFailures: true }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WorkflowRunError);
    const results = (error as WorkflowRunError).results;
    expect(results.get("slow")?.status).toBe("error");
    expect(results.get("afterSlow")?.status).toBe("pending");
    expect(results.get("afterQuick")?.status).toBe("done");
  });

  it("without isolation, starts nothing new after the first failure", async () => {
    const { release } = scripted();
    const graph = twoBranches();
    graph.nodes[1] = chat("quick", "FAIL");
    const run = runWorkflow(graph, { scheduling: "ready" }).catch((caught: unknown) => caught);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const error = (await run) as WorkflowRunError;
    expect(error.results.get("quick")?.status).toBe("error");
    // The slow branch was already working and finished; nothing after it started.
    expect(error.results.get("slow")?.status).toBe("done");
    expect(error.results.get("afterSlow")?.status).toBe("pending");
  });

  it("holds only the gate's branch, and ends held when nothing failed", async () => {
    scripted().release();
    const graph = twoBranches();
    graph.nodes.push({ id: "g", type: "gate", label: "", position: { x: 0, y: 0 }, params: {} });
    graph.nodes.push(chat("afterGate", "after {{input}}"));
    graph.edges.push(
      { id: "e3", source: "afterSlow", target: "g", targetPort: "in" },
      { id: "e4", source: "g", target: "afterGate", targetPort: "prompt" },
    );
    const results = await runWorkflow(graph, { scheduling: "ready", isolateFailures: true });
    expect(results.get("g")?.status).toBe("awaiting");
    expect(results.get("afterGate")?.status).toBe("pending");
    expect(results.get("afterQuick")?.status).toBe("done");
  });

  it("stops starting anything once cancelled", async () => {
    const { release } = scripted();
    const controller = new AbortController();
    const run = runWorkflow(twoBranches(), { scheduling: "ready", signal: controller.signal });
    controller.abort();
    release();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("running part of a workflow", () => {
  it("keeps the step asked for and everything it needs, nothing else", () => {
    const graph = twoBranches();
    const part = pruneToTargets(graph, ["afterQuick"]);
    expect(part.nodes.map((node) => node.id).sort()).toEqual(["afterQuick", "quick"]);
    expect(part.edges.map((edge) => edge.id)).toEqual(["e2"]);
    expect(pruneToTargets(graph, ["gone"]).nodes).toEqual([]);
  });

  it("is judged on what will run: a broken step elsewhere does not block it", () => {
    const graph = twoBranches();
    graph.nodes[0] = { ...chat("slow", ""), params: { ...defaultParams("chat"), prompt: "" } };
    expect(validateWorkflow(graph).ok).toBe(false);
    expect(validateWorkflow(pruneToTargets(graph, ["afterQuick"])).ok).toBe(true);
  });

  it("names the step and the input a problem is about", () => {
    const graph: Workflow = {
      ...twoBranches(),
      nodes: [
        {
          id: "edit",
          type: "imageEdit",
          label: "",
          position: { x: 0, y: 0 },
          params: { ...defaultParams("imageEdit"), model: "m", prompt: "x" },
        },
      ],
      edges: [],
    };
    const issue = validateWorkflow(graph).errors.find((entry) => entry.code === "portRequired");
    expect(issue).toMatchObject({ nodeId: "edit", port: "images", severity: "error" });
  });
});
