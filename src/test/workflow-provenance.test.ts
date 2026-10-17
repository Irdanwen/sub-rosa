/**
 * Provenance: a file a workflow step makes is filed with the workflow, the
 * run and the step, through the run's storage and through a durable render's
 * job, so the gallery can lead back to it.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: vi.fn(async () => ({ images: ["AAAA"] })),
}));
vi.mock("../lib/studio/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/catalog")>()),
  fetchMediaCatalog: vi.fn(async () => ({ backend: "carpe-diem", models: [] })),
}));

import { runWorkflow, type WorkflowStorage } from "../lib/studio/workflow/engine";
import { OPEN_WORKFLOW_EVENT, requestOpenWorkflow } from "../lib/studio/workflow/open";
import { defaultParams } from "../lib/studio/workflow/schema";

describe("files a step makes", () => {
  it("carry the workflow, the run and the step", async () => {
    const save = vi.fn(
      async (_payload: unknown, _extension: string, _meta: Record<string, unknown>) => ({
        artifactId: "made.png",
        src: "blob:made",
      }),
    );
    const storage = {
      save,
      loadAsset: vi.fn(),
      loadNote: vi.fn(),
      readMedia: vi.fn(),
    } as unknown as WorkflowStorage;
    await runWorkflow(
      {
        id: "w",
        name: "w",
        createdAt: 0,
        updatedAt: 0,
        nodes: [
          {
            id: "pic",
            type: "image",
            label: "",
            position: { x: 0, y: 0 },
            params: { ...defaultParams("image"), model: "img", prompt: "A fox" },
          },
        ],
        edges: [],
      },
      { storage, origin: { workflowId: "w", runId: "r1" } },
    );
    expect(save).toHaveBeenCalled();
    expect(save.mock.calls[0][2]).toMatchObject({
      origin: { surface: "workflow", workflowId: "w", runId: "r1", nodeId: "pic" },
    });
  });

  it("are filed without an origin when the run gives none", async () => {
    const save = vi.fn(
      async (_payload: unknown, _extension: string, _meta: Record<string, unknown>) => ({
        artifactId: "made.png",
        src: "blob:made",
      }),
    );
    const storage = {
      save,
      loadAsset: vi.fn(),
      loadNote: vi.fn(),
      readMedia: vi.fn(),
    } as unknown as WorkflowStorage;
    await runWorkflow(
      {
        id: "w",
        name: "w",
        createdAt: 0,
        updatedAt: 0,
        nodes: [
          {
            id: "pic",
            type: "image",
            label: "",
            position: { x: 0, y: 0 },
            params: { ...defaultParams("image"), model: "img", prompt: "A fox" },
          },
        ],
        edges: [],
      },
      { storage },
    );
    expect(save.mock.calls[0][2]).not.toHaveProperty("origin");
  });
});

describe("leading back", () => {
  it("asks the Studio to open the workflow", () => {
    const heard = vi.fn();
    window.addEventListener(OPEN_WORKFLOW_EVENT, (event) => heard((event as CustomEvent).detail));
    requestOpenWorkflow("w");
    expect(heard).toHaveBeenCalledWith("w");
  });
});
