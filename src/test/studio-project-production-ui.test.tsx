import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getProject: vi.fn(),
  listProjects: vi.fn(),
  save: vi.fn(),
  quote: vi.fn(),
  run: vi.fn(),
  resume: vi.fn(),
  budget: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("../lib/studio/projects", async (original) => ({
  ...(await original<typeof import("../lib/studio/projects")>()),
  getProject: mocks.getProject,
  listProjects: mocks.listProjects,
  importLegacyFilms: vi.fn(),
  saveProject: mocks.save,
  listArtifactMetadata: vi.fn(async () => []),
  saveArtifactMetadata: vi.fn(async () => {}),
  ProjectWriter: class {
    save = mocks.save;
    flush = async () => {};
  },
}));
vi.mock("../lib/studio/artifacts", () => ({
  listArtifacts: vi.fn(async () => []),
  artifactSrc: vi.fn(),
}));
vi.mock("../lib/studio/project-production", async (original) => ({
  ...(await original<typeof import("../lib/studio/project-production")>()),
  quoteProject: mocks.quote,
  productionBudget: mocks.budget,
}));
vi.mock("../lib/studio/workflow-run", () => ({
  activeWorkflowRuns: () => [],
  runAndSaveWorkflow: mocks.run,
  resumeWorkflowRun: mocks.resume,
}));
vi.mock("../components/ui/Dialog", () => ({
  Dialog: ({
    title,
    children,
    footer,
  }: {
    title: string;
    children: ReactNode;
    footer: ReactNode;
  }) => (
    <section role="dialog" aria-label={title}>
      {children}
      {footer}
    </section>
  ),
}));
vi.mock("../components/studio/NotePicker", () => ({ NotePicker: () => null }));
vi.mock("../components/studio/MediaModelPicker", () => ({
  MediaModelPicker: () => null,
  mediaModelOption: (value: unknown) => value,
}));
vi.mock("../components/studio/ProjectBible", () => ({ ProjectBible: () => null }));
vi.mock("../components/studio/ProjectMedia", () => ({ ProjectMedia: () => null }));
vi.mock("../components/studio/ProjectTimeline", () => ({ ProjectTimeline: () => null }));
vi.mock("../components/studio/ProjectShots", () => ({
  ProjectShots: ({ onGenerate }: { onGenerate: (id: string) => void }) => (
    <button type="button" onClick={() => onGenerate("s1")}>
      Generate shot
    </button>
  ),
}));

import { ProjectStudio } from "../components/studio/ProjectStudio";
import {
  newProject,
  newShot,
  listArtifactMetadata,
  saveArtifactMetadata,
  type StudioProject,
} from "../lib/studio/projects";
import type { MediaCatalog } from "../lib/studio/types";
import type { Workflow } from "../lib/studio/workflow/schema";
import type { NodeRunResult } from "../lib/studio/workflow/engine";
const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [
    {
      id: "test-text-to-video",
      name: "Test video",
      mediaType: "video",
      offline: false,
      costCredits: 10,
    },
  ],
};
let project: StudioProject;
beforeEach(() => {
  vi.clearAllMocks();
  project = newProject("Concert");
  project.id = "project-1";
  project.document.shots = [
    { ...newShot(0), id: "s1", action: "The pianist bows", modelId: "test-text-to-video" },
  ];
  localStorage.setItem("os-june:studio-project", project.id);
  mocks.getProject.mockImplementation(async () => project);
  mocks.listProjects.mockResolvedValue([project]);
  mocks.save.mockImplementation(async (value: StudioProject) => {
    project = value;
    return value;
  });
  mocks.budget.mockReturnValue(vi.fn());
  mocks.quote.mockImplementation(async (workflow: Workflow) => ({
    nodes: workflow.nodes
      .filter((node) => node.type === "video")
      .map((node) => ({
        nodeId: node.id,
        type: "video",
        label: node.label,
        kind: "flat",
        credits: 10,
        quotable: false,
      })),
    credits: 10,
    metered: 0,
    quotable: 0,
  }));
  mocks.invoke.mockResolvedValue(null);
  mocks.run.mockResolvedValue(new Map());
  mocks.resume.mockResolvedValue(new Map());
});
const mount = async () => {
  const result = render(<ProjectStudio catalog={catalog} />);
  await screen.findByRole("button", { name: "Generate shot" });
  return result;
};

describe("project production confirmation", () => {
  it("does not pay until the quoted production is confirmed and records its owner first", async () => {
    vi.mocked(listArtifactMetadata).mockResolvedValue([
      { id: "take.mp4", title: "Alternate view", projectIds: ["other-project"] },
    ]);
    mocks.run.mockImplementation(async (_workflow, options) => {
      await options.onRunRecorded("run-1");
      expect(project.document.runs[0].id).toBe("run-1");
      options.onUpdate({
        nodeId: "shot-s1",
        status: "done",
        output: { kind: "video", artifactId: "take.mp4" },
      });
      return new Map();
    });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Generate shot" }));
    await screen.findByRole("dialog", { name: "Review generation costs" });
    expect(mocks.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Generate · 10 credits/ }));
    await waitFor(() => expect(project.document.shots[0].takeIds).toContain("take.mp4"));
    expect(mocks.run.mock.calls[0][1]).toMatchObject({ requireDurable: true });
    await waitFor(() =>
      expect(saveArtifactMetadata).toHaveBeenCalledWith({
        id: "take.mp4",
        title: "Alternate view",
        projectIds: ["other-project", "project-1"],
      }),
    );
  });

  it("re-quotes only unpaid resume steps and waits for confirmation", async () => {
    project.document.runs = [{ id: "run-1", shotSignatures: {} }];
    project.document.settings.budget = 30;
    const definition: Workflow = {
      id: "graph",
      name: "Concert",
      createdAt: 0,
      updatedAt: 0,
      edges: [],
      nodes: ["finished", "pending", "s1"].map((id) => ({
        id: `shot-${id}`,
        type: "video",
        label: id,
        position: { x: 0, y: 0 },
        params: { model: "test-text-to-video", prompt: "A shot" },
      })),
    };
    mocks.invoke.mockImplementation(async (command) =>
      command === "workflow_run_get"
        ? {
            run: {
              status: "failed",
              definition: JSON.stringify(definition),
              nodeCosts: JSON.stringify({ "shot-finished": 8, "shot-pending": 8, "shot-s1": 8 }),
            },
            nodes: [
              {
                nodeId: "shot-finished",
                status: "done",
                output: JSON.stringify({ kind: "video", artifactId: "finished.mp4" }),
              },
              {
                nodeId: "shot-pending",
                status: "error",
                output: JSON.stringify({ pendingJobId: "paid-job" }),
              },
              { nodeId: "shot-s1", status: "pending" },
            ],
          }
        : null,
    );
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Resume production" }));
    await screen.findByRole("dialog", { name: "Review generation costs" });
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.quote.mock.calls.at(-1)?.[0].nodes.map((node: { id: string }) => node.id)).toEqual(
      ["shot-s1"],
    );
    fireEvent.click(screen.getByRole("button", { name: /Generate · 10 credits/ }));
    await waitFor(() =>
      expect(mocks.resume).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({
          requireExistingOutputs: true,
          nodeCosts: { "shot-finished": 8, "shot-pending": 8, "shot-s1": 10 },
        }),
      ),
    );
    expect(mocks.budget).toHaveBeenCalledWith(expect.anything(), 14);
  });

  it("requires a new quote after the draft changes", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Generate shot" }));
    await screen.findByRole("dialog");
    fireEvent.blur(screen.getByRole("textbox", { name: "Project name" }), {
      target: { value: "New title" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Generate · 10 credits/ }));
    await screen.findByText(
      "The project changed while quoting. Review its settings and quote again.",
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("keeps a recorded run when unmounted so paid work can be recovered", async () => {
    let publish: ((result: NodeRunResult) => void) | undefined;
    mocks.run.mockImplementation(async (_workflow, options) => {
      await options.onRunRecorded("run-1");
      publish = options.onUpdate;
      await new Promise<void>((_resolve, reject) =>
        options.signal.addEventListener("abort", () =>
          reject(new DOMException("Paused", "AbortError")),
        ),
      );
    });
    const mounted = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Generate shot" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: /Generate · 10 credits/ }));
    await waitFor(() => expect(project.document.runs[0]?.id).toBe("run-1"));
    await act(async () => mounted.unmount());
    expect(project.document.runs[0].id).toBe("run-1");
    // A delivery that wins the abort race still belongs to the originating project.
    await act(async () =>
      publish?.({
        nodeId: "shot-s1",
        status: "done",
        output: { kind: "video", artifactId: "late.mp4", src: "late.mp4" },
      }),
    );
    await waitFor(() => expect(project.document.artifactIds).toContain("late.mp4"));
  });
});
