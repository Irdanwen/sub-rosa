import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/tauri", () => ({ carpeDiemGetCredits: vi.fn() }));
import { carpeDiemGetCredits } from "../lib/tauri";
import { compileProject, productionBudget } from "../lib/studio/project-production";
import { newProject, newShot } from "../lib/studio/projects";
import type { MediaCatalog } from "../lib/studio/types";
import type { WorkflowCostEstimate } from "../lib/studio/workflow/cost";
import type { WorkflowNode } from "../lib/studio/workflow/schema";

const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [
    { id: "test-text-to-video", name: "Test", mediaType: "video", offline: false, costCredits: 10 },
    {
      id: "test-image-to-video",
      name: "Test",
      mediaType: "imageToVideo",
      offline: false,
      costCredits: 10,
    },
  ],
};
const paidNode = (id: string): WorkflowNode => ({
  id,
  type: "video",
  label: id,
  position: { x: 0, y: 0 },
  params: {},
});
const estimate = (costs: number[]): WorkflowCostEstimate => ({
  credits: costs.reduce((a, b) => a + b, 0),
  metered: 0,
  quotable: 0,
  nodes: costs.map((credits, i) => ({
    nodeId: String(i),
    type: "video",
    label: String(i),
    kind: "flat",
    quotable: false,
    credits,
  })),
});

beforeEach(() => {
  vi.mocked(carpeDiemGetCredits).mockReset();
});

describe("isolated project takes", () => {
  it("chooses the cheapest compatible model when the project leaves model choices blank", () => {
    const project = newProject();
    project.document.shots = [{ ...newShot(0), id: "target", action: "A pianist bows" }];
    const graph = compileProject(
      project.name,
      project.document,
      {
        ...catalog,
        models: [
          {
            id: "premium-video",
            name: "Premium",
            mediaType: "video",
            offline: false,
            costCredits: 20,
          },
          {
            id: "simple-video",
            name: "Simple",
            mediaType: "video",
            offline: false,
            costCredits: 1,
          },
        ],
      },
      "target",
    );
    expect(graph.nodes.find((node) => node.type === "video")?.params.model).toBe("simple-video");
  });

  it("uses the selected project model when the shot override is blank", () => {
    const project = newProject();
    project.document.settings.videoModelId = "beta-text-to-video";
    project.document.shots = [
      { ...newShot(0), id: "target", action: "A pianist bows", modelId: "" },
    ];
    const graph = compileProject(
      project.name,
      project.document,
      {
        ...catalog,
        models: [
          {
            id: "alpha-text-to-video",
            name: "Alpha",
            mediaType: "video",
            offline: false,
            costCredits: 1,
          },
          {
            id: "beta-text-to-video",
            name: "Beta",
            mediaType: "video",
            offline: false,
            costCredits: 20,
          },
        ],
      },
      "target",
    );
    expect(graph.nodes.find((node) => node.type === "video")?.params.model).toBe(
      "beta-text-to-video",
    );
  });

  it("does not validate or price unrelated unfinished shots", () => {
    const project = newProject();
    const target = {
      ...newShot(0),
      id: "target",
      action: "A pianist takes a bow",
      modelId: "test-text-to-video",
    };
    project.document.shots = [target, newShot(1)];
    project.document.settings.budget = 1; // quotes enforce the budget after graph selection
    const graph = compileProject(project.name, project.document, catalog, target.id);
    expect(graph.nodes.filter((node) => node.type === "video").map((node) => node.id)).toEqual([
      "shot-target",
    ]);
  });

  it("continues from the selected previous take without generating that shot again", () => {
    const project = newProject();
    const previous = { ...newShot(0), id: "previous", activeTakeId: "paid.mp4" };
    const target = {
      ...newShot(1),
      id: "target",
      action: "The pianist exits",
      mode: "continuation" as const,
      modelId: "test-image-to-video",
    };
    project.document.shots = [previous, target, newShot(2)];
    const graph = compileProject(project.name, project.document, catalog, target.id);
    expect(graph.nodes.filter((node) => node.type === "video")).toHaveLength(1);
    expect(graph.nodes.find((node) => node.type === "asset")?.params.artifactId).toBe("paid.mp4");
    expect(graph.nodes.some((node) => node.type === "lastFrame")).toBe(true);
    expect(
      graph.edges.some(
        (edge) => edge.target === "shot-target" && edge.targetPort === "openingFrame",
      ),
    ).toBe(true);
  });
});

describe("production reservations", () => {
  it("allows only the parallel requests covered by the opening balance", async () => {
    vi.mocked(carpeDiemGetCredits).mockResolvedValue({ availableCredits: 15 } as Awaited<
      ReturnType<typeof carpeDiemGetCredits>
    >);
    const reserve = productionBudget(estimate([10, 10]), 100);
    const results = await Promise.allSettled([reserve(paidNode("0")), reserve(paidNode("1"))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("does not double-subtract a charge reflected by the current balance", async () => {
    vi.mocked(carpeDiemGetCredits)
      .mockResolvedValueOnce({ availableCredits: 20 } as Awaited<
        ReturnType<typeof carpeDiemGetCredits>
      >)
      .mockResolvedValueOnce({ availableCredits: 20 } as Awaited<
        ReturnType<typeof carpeDiemGetCredits>
      >)
      .mockResolvedValueOnce({ availableCredits: 10 } as Awaited<
        ReturnType<typeof carpeDiemGetCredits>
      >);
    const reserve = productionBudget(estimate([10, 10]), 20);
    await reserve(paidNode("0"));
    await expect(reserve(paidNode("1"))).resolves.toBeUndefined();
  });

  it("rejects a missing price and an invalid ceiling before reading the balance", async () => {
    await expect(productionBudget(estimate([]), 100)(paidNode("0"))).rejects.toThrow(
      "Price unavailable",
    );
    await expect(productionBudget(estimate([10]), Number.NaN)(paidNode("0"))).rejects.toThrow(
      "project budget",
    );
    expect(carpeDiemGetCredits).not.toHaveBeenCalled();
  });
});
