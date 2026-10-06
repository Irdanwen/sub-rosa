/**
 * The workflow library (ADR-0075): durable in SQLite, moved out of local
 * storage once, a card per workflow with its real result as picture, and a
 * ComfyUI file translated and reviewed before it is saved.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowLibrary } from "../components/studio/WorkflowLibrary";
import type { NodeRunResult } from "../lib/studio/workflow/engine";
import { coverArtifactOf, coverPrompt, workflowMakes } from "../lib/studio/workflow/library";
import type { Workflow } from "../lib/studio/workflow/schema";
import {
  listWorkflows,
  loadWorkflowLibrary,
  resetWorkflowLibraryForTests,
  saveWorkflow,
} from "../lib/studio/workflow/store";
import type { MediaCatalog } from "../lib/studio/types";
import geminiOmni from "./fixtures/comfy/gemini-omni-image-to-video.json";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, convertFileSrc: (p: string) => p }));

const catalog: MediaCatalog = {
  backend: "venice",
  models: [
    {
      id: "gemini-omni-flash-1-1-image-to-video",
      mediaType: "imageToVideo",
      name: "Gemini Omni Flash 1.1",
      offline: false,
    },
    { id: "gpt-image-2", mediaType: "image", name: "GPT Image 2", offline: false, costCredits: 4 },
  ],
};

function workflow(id: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name: `Workflow ${id}`,
    nodes: [
      { id: "v", type: "video", label: "", position: { x: 0, y: 0 }, params: { prompt: "A car" } },
      { id: "o", type: "output", label: "", position: { x: 1, y: 0 }, params: {} },
    ],
    edges: [{ id: "e", source: "v", target: "o", targetPort: "in" }],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("the library's store", () => {
  let table: Array<Record<string, unknown>>;
  beforeEach(() => {
    table = [];
    window.localStorage.clear();
    tauri.invoke
      .mockReset()
      .mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        if (command === "studio_workflow_list") return table;
        if (command === "studio_workflow_save") {
          const request = (args as { request: Record<string, unknown> }).request;
          table = [request, ...table.filter((row) => row.id !== request.id)];
        }
        return undefined;
      });
  });

  it("moves what local storage held into the table, once, and forgets local storage", async () => {
    window.localStorage.setItem("os-june:studio-workflows", JSON.stringify([workflow("a")]));
    resetWorkflowLibraryForTests();
    const loaded = await loadWorkflowLibrary();
    expect(loaded.map((entry) => entry.id)).toEqual(["a"]);
    expect(table.map((row) => row.id)).toEqual(["a"]);
    expect(JSON.parse(String(table[0].definition)).nodes).toHaveLength(2);
    expect(window.localStorage.getItem("os-june:studio-workflows")).toBeNull();
  });

  it("reads the table back, imports included, and keeps the thirty-first workflow", async () => {
    table = Array.from({ length: 31 }, (_, index) => ({
      id: `w${index}`,
      name: `W${index}`,
      definition: JSON.stringify({ nodes: [], edges: [] }),
      formatVersion: 1,
      origin: index === 0 ? "import" : "mine",
      coverArtifactId: index === 0 ? "cover.png" : null,
      createdAt: index,
      updatedAt: index,
    }));
    resetWorkflowLibraryForTests();
    await loadWorkflowLibrary();
    expect(listWorkflows()).toHaveLength(31);
    const imported = listWorkflows().find((entry) => entry.id === "w0");
    expect(imported).toMatchObject({ origin: "import", coverArtifactId: "cover.png" });
  });

  it("writes through to the table", async () => {
    resetWorkflowLibraryForTests();
    await loadWorkflowLibrary();
    saveWorkflow(workflow("b"));
    await waitFor(() => expect(table.map((row) => row.id)).toEqual(["b"]));
  });
});

describe("a card's picture and summary", () => {
  const done = (nodeId: string, kind: "image" | "video", artifactId: string): NodeRunResult => ({
    nodeId,
    status: "done",
    output:
      kind === "video"
        ? { kind: "video", artifactId, src: "" }
        : { kind: "image", artifactId, base64: "", mimeType: "image/png" },
  });

  it("is what reached the output, never a picture the run only read", () => {
    const graph = workflow("c");
    const results = new Map([["v", done("v", "video", "clip.mp4")]]);
    expect(coverArtifactOf(graph, results)).toBe("clip.mp4");
    const assetOnly = {
      nodes: [{ id: "a", type: "asset" as const, label: "", position: { x: 0, y: 0 }, params: {} }],
      edges: [],
    };
    expect(coverArtifactOf(assetOnly, new Map([["a", done("a", "image", "input.png")]]))).toBe(
      undefined,
    );
  });

  it("says what one run makes", () => {
    expect(workflowMakes(workflow("d"))).toBe("1 video");
  });

  it("asks for an illustration without text", () => {
    expect(coverPrompt(workflow("e"))).toMatch(/It makes: A car\..*no text/);
  });
});

describe("the library screen", () => {
  function renderLibrary(overrides: Partial<Parameters<typeof WorkflowLibrary>[0]> = {}) {
    const props = {
      catalog,
      workflows: [workflow("a", { origin: "import" as const })],
      templates: [workflow("template-x", { name: "Album cover" })],
      onOpen: vi.fn(),
      onUseTemplate: vi.fn(),
      onNew: vi.fn(),
      onImported: vi.fn(),
      onExport: vi.fn(async () => undefined),
      onDelete: vi.fn(),
      onMakeCover: vi.fn(async () => undefined),
      ...overrides,
    };
    tauri.invoke.mockReset().mockResolvedValue([]);
    render(<WorkflowLibrary {...props} />);
    return props;
  }

  it("shows each workflow as a card and opens it", async () => {
    const props = renderLibrary();
    const card = screen.getByRole("button", { name: "Open Workflow a" });
    expect(
      within(card.closest("article") as HTMLElement).getByText("Imported"),
    ).toBeInTheDocument();
    await userEvent.click(card);
    expect(props.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    await userEvent.click(screen.getByRole("button", { name: "Start from Album cover" }));
    expect(props.onUseTemplate).toHaveBeenCalledWith("template-x");
  });

  it("translates a ComfyUI file, shows the report, and imports only when asked", async () => {
    const props = renderLibrary();
    const file = new File([JSON.stringify(geminiOmni)], "omni.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("Workflow file"), { target: { files: [file] } });
    const dialog = await screen.findByRole("dialog", { name: "Import a ComfyUI workflow" });
    expect(within(dialog).getByText(/GeminiVideoOmniV2 → Video/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/blue_studio_car.png: pick it from the gallery/),
    ).toBeInTheDocument();
    expect(props.onImported).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(props.onImported).toHaveBeenCalledWith(
      expect.objectContaining({ name: "omni", nodes: expect.any(Array) }),
    );
  });

  it("says why a file is not a workflow", async () => {
    renderLibrary();
    const file = new File(["{"], "broken.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("Workflow file"), { target: { files: [file] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("This file is not valid JSON.");
  });
});
