// The durable workflow runner (ADR-0021): the run is rows, the long renders
// are Rust's media jobs, and the webview stitches. These tests stand in a
// fake command surface so the interesting cases are testable — a resume that
// must not re-buy a render, a dismiss that must not lose a delivered one.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  register: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: vi.fn(),
  mediaBinary: vi.fn(),
  mediaGet: vi.fn(),
  mediaRaw: vi.fn(),
}));
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  registerDownloadedArtifact: mocks.register,
  artifactSrc: (artifact: { path: string }) => `asset://${artifact.path}`,
  listArtifacts: vi.fn(async () => []),
}));
vi.mock("../lib/artifact-media", () => ({ artifactDataUrl: vi.fn() }));
vi.mock("../lib/mobile", () => ({ isMobilePlatform: () => false }));
vi.mock("../lib/notifications", () => ({
  ensureNotificationPermission: vi.fn().mockResolvedValue(false),
}));

import { mediaJson } from "../lib/studio/client";
import {
  approveRunGates,
  dismissWorkflowRun,
  listResumableRuns,
  resumeWorkflowRun,
  runAndSaveWorkflow,
} from "../lib/studio/workflow-run";
import {
  defaultParams,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from "../lib/studio/workflow/schema";

const mediaJsonMock = vi.mocked(mediaJson);

function node(
  id: string,
  type: WorkflowNodeType,
  params: Record<string, unknown> = {},
): WorkflowNode {
  return {
    id,
    type,
    label: id,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(type), ...params },
  };
}

function edge(source: string, target: string, targetPort?: string): WorkflowEdge {
  return {
    id: `${source}-${target}${targetPort ? `-${targetPort}` : ""}`,
    source,
    target,
    targetPort,
  };
}

function workflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return { id: "wf", name: "Test production", nodes, edges, createdAt: 0, updatedAt: 0 };
}

function invokeCalls(command: string): Record<string, unknown>[] {
  return mocks.invoke.mock.calls
    .filter((call) => call[0] === command)
    .map((call) => (call[1] ?? {}) as Record<string, unknown>);
}

const DELIVERED_JOB = {
  id: "q1",
  kind: "video",
  model: "m-t2v",
  prompt: "a shot",
  status: "completed",
  artifactPath: "/gallery/a.mp4",
  artifactFileName: "a.mp4",
  artifactBytes: 5,
  source: "workflow",
  createdAt: "2026-08-13T00:00:00Z",
  updatedAt: "2026-08-13T00:00:00Z",
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.register.mockReset();
  mediaJsonMock.mockReset();
  mocks.register.mockReturnValue({
    id: "a.mp4",
    kind: "video",
    path: "/gallery/a.mp4",
    fileName: "a.mp4",
    bytes: 5,
    model: "m-t2v",
    prompt: "a shot",
    createdAt: 1,
  });
});

describe("runAndSaveWorkflow (durable)", () => {
  it("records the run, rides a Rust job for the render, and files the delivery", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "media_job_list") return [DELIVERED_JOB];
      return null;
    });
    mediaJsonMock.mockImplementation(async (path: string) => {
      if (path === "/video/queue") return { id: "q1" };
      throw new Error(`Unexpected path: ${path}`);
    });

    const results = await runAndSaveWorkflow(
      workflow(
        [node("clip", "video", { model: "m-t2v", prompt: "a shot" }), node("out", "output")],
        [edge("clip", "out")],
      ),
    );

    // The run row exists before anything else.
    const created = invokeCalls("workflow_run_create");
    expect(created).toHaveLength(1);
    const createRequest = created[0].request as Record<string, unknown>;
    expect(createRequest.nodeIds).toEqual(["clip", "out"]);

    // The render was handed to Rust, tagged as the run's.
    const started = invokeCalls("media_job_start");
    expect(started).toHaveLength(1);
    const startRequest = started[0].request as Record<string, unknown>;
    expect(startRequest.queueId).toBe("q1");
    expect(startRequest.source).toBe("workflow");

    // The pending-job pointer went down before the wait, and the node
    // settled with a dehydrated artifact reference.
    const nodeWrites = invokeCalls("workflow_run_set_node").map(
      (call) => call.request as Record<string, unknown>,
    );
    expect(nodeWrites).toContainEqual(
      expect.objectContaining({
        nodeId: "clip",
        status: "running",
        output: { pendingJobId: "q1" },
      }),
    );
    expect(nodeWrites).toContainEqual(
      expect.objectContaining({
        nodeId: "clip",
        status: "done",
        output: expect.objectContaining({ kind: "video", artifactId: "a.mp4" }),
      }),
    );

    // Delivery filed and acknowledged; the run settled.
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(invokeCalls("media_job_dismiss")).toHaveLength(1);
    const finished = invokeCalls("workflow_run_finish");
    expect(finished).toHaveLength(1);
    expect((finished[0].request as Record<string, unknown>).status).toBe("completed");

    expect(results.get("out")?.output).toMatchObject({ kind: "video", artifactId: "a.mp4" });
  });

  it("falls back to an in-webview run when the run row cannot be recorded", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "workflow_run_create") throw new Error("unknown command");
      return null;
    });
    mediaJsonMock.mockImplementation(async (path: string) => {
      if (path === "/chat/completions") return { choices: [{ message: { content: "ok" } }] };
      throw new Error(`Unexpected path: ${path}`);
    });

    const results = await runAndSaveWorkflow(
      workflow(
        [node("in", "textInput", { text: "hello" }), node("llm", "chat", { model: "m" })],
        [edge("in", "llm")],
      ),
    );

    expect(results.get("llm")?.output).toEqual({ kind: "text", text: "ok" });
    // No durable machinery beyond the failed create.
    expect(invokeCalls("workflow_run_set_node")).toHaveLength(0);
    expect(invokeCalls("workflow_run_finish")).toHaveLength(0);
  });

  it("settles the run as failed when a node fails", async () => {
    mocks.invoke.mockImplementation(async () => null);
    mediaJsonMock.mockRejectedValue(new Error("boom"));

    await expect(
      runAndSaveWorkflow(
        workflow(
          [node("in", "textInput", { text: "hello" }), node("llm", "chat", { model: "m" })],
          [edge("in", "llm")],
        ),
      ),
    ).rejects.toThrow("boom");

    const finished = invokeCalls("workflow_run_finish");
    expect(finished).toHaveLength(1);
    expect(finished[0].request).toMatchObject({ status: "failed", error: "boom" });
  });
});

describe("listResumableRuns", () => {
  it("never offers to resume a run that is still executing in this webview", async () => {
    let releaseChat: ((value: unknown) => void) | undefined;
    let capturedRunId = "";
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "workflow_run_create") {
        capturedRunId = (args as { request: { id: string } }).request.id;
        return null;
      }
      if (command === "workflow_run_list") {
        return [
          {
            id: capturedRunId,
            workflowId: "wf",
            name: "Test production",
            definition: "{}",
            status: "running",
            createdAt: "",
            updatedAt: "",
          },
        ];
      }
      return null;
    });
    mediaJsonMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseChat = resolve;
        }),
    );

    const runPromise = runAndSaveWorkflow(
      workflow(
        [node("in", "textInput", { text: "hello" }), node("llm", "chat", { model: "m" })],
        [edge("in", "llm")],
      ),
    );
    // Let the run reach the pending chat call.
    await vi.waitFor(() => expect(mediaJsonMock).toHaveBeenCalled());

    // The rows say "running", but the run is live right here: not resumable.
    expect(await listResumableRuns()).toEqual([]);

    releaseChat?.({ choices: [{ message: { content: "ok" } }] });
    await runPromise;

    // Settled and out of the live registry: the (stale) row shows again.
    const after = await listResumableRuns();
    expect(after).toHaveLength(1);
  });

  it("offers a production that stopped on an error, and hides a finished one", async () => {
    // A run that failed used to show nothing at all after a reload, so a
    // production that was stuck looked exactly like one at rest. Resuming it
    // retries the step that failed and keeps everything already paid for.
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "workflow_run_list"
        ? [
            {
              id: "a",
              workflowId: "w",
              name: "Stopped",
              definition: "{}",
              status: "failed",
              error: "The rail said no.",
              createdAt: "",
              updatedAt: "",
            },
            {
              id: "b",
              workflowId: "w",
              name: "Waiting",
              definition: "{}",
              status: "awaitingGate",
              createdAt: "",
              updatedAt: "",
            },
            {
              id: "c",
              workflowId: "w",
              name: "Interrupted",
              definition: "{}",
              status: "running",
              createdAt: "",
              updatedAt: "",
            },
            {
              id: "d",
              workflowId: "w",
              name: "Done",
              definition: "{}",
              status: "completed",
              createdAt: "",
              updatedAt: "",
            },
            {
              id: "e",
              workflowId: "w",
              name: "Stopped by hand",
              definition: "{}",
              status: "cancelled",
              createdAt: "",
              updatedAt: "",
            },
          ]
        : null,
    );
    const offered = await listResumableRuns();
    expect(offered.map((run) => run.id)).toEqual(["a", "b", "c"]);
  });
});

describe("resumeWorkflowRun", () => {
  it("re-attaches to a pending render instead of buying it twice", async () => {
    const definition = workflow(
      [node("clip", "video", { model: "m-t2v", prompt: "a shot" }), node("out", "output")],
      [edge("clip", "out")],
    );
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "workflow_run_get") {
        return {
          run: {
            id: "r1",
            workflowId: "wf",
            name: "Test production",
            definition: JSON.stringify(definition),
            status: "running",
            nodeCosts: JSON.stringify({ clip: 35 }),
            createdAt: "",
            updatedAt: "",
          },
          nodes: [
            {
              nodeId: "clip",
              status: "running",
              output: JSON.stringify({ pendingJobId: "q1" }),
              updatedAt: "",
            },
            { nodeId: "out", status: "pending", updatedAt: "" },
          ],
        };
      }
      if (command === "media_job_list") return [DELIVERED_JOB];
      return null;
    });

    const results = await resumeWorkflowRun("r1");

    // Nothing was re-queued upstream and no new job row was created.
    expect(mediaJsonMock).not.toHaveBeenCalled();
    expect(invokeCalls("media_job_start")).toHaveLength(0);
    // The delivered render was filed and the run completed.
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(results.get("clip")?.output).toMatchObject({ kind: "video", artifactId: "a.mp4" });
    const finished = invokeCalls("workflow_run_finish");
    expect((finished[0].request as Record<string, unknown>).status).toBe("completed");
  });

  it("replays finished nodes from their stored outputs", async () => {
    const definition = workflow(
      [node("in", "textInput", { text: "hello" }), node("llm", "chat", { model: "m" })],
      [edge("in", "llm")],
    );
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "workflow_run_get") {
        return {
          run: {
            id: "r1",
            workflowId: "wf",
            name: "Test production",
            definition: JSON.stringify(definition),
            status: "running",
            createdAt: "",
            updatedAt: "",
          },
          nodes: [
            {
              nodeId: "in",
              status: "done",
              output: JSON.stringify({ kind: "text", text: "from the last session" }),
              updatedAt: "",
            },
            { nodeId: "llm", status: "pending", updatedAt: "" },
          ],
        };
      }
      return null;
    });
    mediaJsonMock.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });

    const results = await resumeWorkflowRun("r1");

    // The cached text fed the chat node without re-running the input.
    const chatBody = mediaJsonMock.mock.calls[0][1] as Record<string, unknown>;
    expect(chatBody.messages).toEqual([{ role: "user", content: "from the last session" }]);
    expect(results.get("in")?.output).toEqual({ kind: "text", text: "from the last session" });
  });
});

describe("approval gates (durable)", () => {
  it("settles a gate-held run as awaitingGate, not completed", async () => {
    mocks.invoke.mockImplementation(async () => null);

    const results = await runAndSaveWorkflow(
      workflow([node("in", "textInput", { text: "hello" }), node("g", "gate")], [edge("in", "g")]),
    );

    expect(results.get("g")?.status).toBe("awaiting");
    const finished = invokeCalls("workflow_run_finish");
    expect(finished).toHaveLength(1);
    expect((finished[0].request as Record<string, unknown>).status).toBe("awaitingGate");
    // The gate's hold went down as a row a later approval can read.
    const nodeWrites = invokeCalls("workflow_run_set_node").map(
      (call) => call.request as Record<string, unknown>,
    );
    expect(nodeWrites).toContainEqual(expect.objectContaining({ nodeId: "g", status: "awaiting" }));
  });

  it("approves every held gate and finishes the production", async () => {
    const definition = workflow(
      [
        node("in", "textInput", { text: "hello" }),
        node("g", "gate"),
        node("llm", "chat", { model: "m", prompt: "{{input}}" }),
      ],
      [edge("in", "g"), edge("g", "llm")],
    );
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "workflow_run_get") {
        return {
          run: {
            id: "r1",
            workflowId: "wf",
            name: "Test production",
            definition: JSON.stringify(definition),
            status: "awaitingGate",
            createdAt: "",
            updatedAt: "",
          },
          nodes: [
            {
              nodeId: "in",
              status: "done",
              output: JSON.stringify({ kind: "text", text: "hello" }),
              updatedAt: "",
            },
            { nodeId: "g", status: "awaiting", updatedAt: "" },
            { nodeId: "llm", status: "pending", updatedAt: "" },
          ],
        };
      }
      return null;
    });
    mediaJsonMock.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });

    const results = await approveRunGates("r1");

    expect(results.get("g")?.output).toEqual({ kind: "text", text: "hello" });
    expect(results.get("llm")?.output).toEqual({ kind: "text", text: "ok" });
    const finished = invokeCalls("workflow_run_finish");
    expect((finished[0].request as Record<string, unknown>).status).toBe("completed");
  });
});

describe("dismissWorkflowRun", () => {
  it("files a delivered render before forgetting the run", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "workflow_run_get") {
        return {
          run: {
            id: "r1",
            workflowId: "wf",
            name: "Test production",
            definition: "{}",
            status: "running",
            createdAt: "",
            updatedAt: "",
          },
          nodes: [
            {
              nodeId: "clip",
              status: "running",
              output: JSON.stringify({ pendingJobId: "q1" }),
              updatedAt: "",
            },
          ],
        };
      }
      if (command === "media_job_list") return [DELIVERED_JOB];
      return null;
    });

    await dismissWorkflowRun("r1");

    expect(mocks.register).toHaveBeenCalledWith(
      { path: "/gallery/a.mp4", fileName: "a.mp4", bytes: 5 },
      expect.objectContaining({ kind: "video", model: "m-t2v", prompt: "a shot" }),
    );
    expect(invokeCalls("media_job_dismiss")).toHaveLength(1);
    expect(invokeCalls("workflow_run_dismiss")).toHaveLength(1);
  });
});
