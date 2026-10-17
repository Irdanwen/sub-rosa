// A workflow as an app (ADR-0119): a few fields and results over the same
// graph, kept with the workflow, carried by its file, copied with a
// template, and drawn by the editor in place of the canvas.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appWithIds,
  cleanApp,
  isApp,
  moveField,
  shownFields,
  suggestApp,
  toggleField,
  toggleOutput,
} from "../lib/studio/workflow/app";
import { readWorkflowFile, workflowFileText } from "../lib/studio/workflow/comfy/file";
import type { Workflow } from "../lib/studio/workflow/schema";
import { copyTemplate, templateWorkflows } from "../lib/studio/workflow/templates";

const state = vi.hoisted(() => ({ rows: [] as unknown[], saved: [] as string[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { request?: { definition?: string } }) => {
    if (command === "studio_workflow_list") return state.rows;
    if (command === "workflow_run_history") return [];
    if (command === "studio_workflow_save" && args?.request?.definition)
      state.saved.push(args.request.definition);
    return null;
  }),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const catalog = { backend: "carpe-diem" as const, models: [] };

function graph(): Workflow {
  return {
    id: "w",
    name: "Cover",
    nodes: [
      {
        id: "t",
        type: "textInput",
        label: "Album",
        position: { x: 0, y: 0 },
        params: { text: "Neon" },
      },
      {
        id: "a",
        type: "asset",
        label: "",
        position: { x: 0, y: 200 },
        params: { assetKind: "image", artifactId: "" },
      },
      { id: "o", type: "output", label: "Cover", position: { x: 300, y: 0 }, params: {} },
    ],
    edges: [{ id: "e", source: "t", target: "o", targetPort: "in" }],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("an app over a workflow", () => {
  it("starts from the workflow's words, pictures and outputs", () => {
    expect(suggestApp(graph())).toEqual({
      fields: [
        { nodeId: "t", param: "text" },
        { nodeId: "a", param: "artifactId" },
      ],
      outputs: ["o"],
    });
  });

  it("shows a field only while its step and setting exist, in the order kept", () => {
    let app = suggestApp(graph());
    app = moveField(app, 1, -1);
    expect(app.fields.map((field) => field.nodeId)).toEqual(["a", "t"]);
    app = toggleField(app, "gone", "text");
    expect(shownFields(app, graph(), catalog).map((shown) => shown.node.id)).toEqual(["a", "t"]);
    app = toggleField(toggleOutput(app, "o"), "a", "artifactId");
    expect(app.outputs).toEqual([]);
    expect(isApp({ app })).toBe(true);
    expect(isApp({})).toBe(false);
  });

  it("reads back only what makes sense, and follows steps given new ids", () => {
    expect(cleanApp({ id: "b" })).toBeUndefined();
    expect(
      cleanApp({
        fields: [{ nodeId: "t", param: "text", label: " " }, { nodeId: 1 }],
        outputs: ["o", 2],
      }),
    ).toEqual({
      fields: [{ nodeId: "t", param: "text" }],
      outputs: ["o"],
    });
    const app = suggestApp(graph());
    expect(
      appWithIds(
        app,
        new Map([
          ["t", "T"],
          ["o", "O"],
        ]),
      ),
    ).toEqual({
      fields: [{ nodeId: "T", param: "text" }],
      outputs: ["O"],
    });
  });

  it("travels in the workflow's file, pointing at the imported steps", () => {
    const workflow = { ...graph(), app: suggestApp(graph()) };
    const read = readWorkflowFile(workflowFileText(workflow), catalog);
    if (read.kind !== "subrosa") throw new Error(read.kind);
    const ids = new Set(read.workflow.nodes.map((node) => node.id));
    expect(read.workflow.app?.fields).toHaveLength(2);
    for (const field of read.workflow.app?.fields ?? []) expect(ids.has(field.nodeId)).toBe(true);
    expect(ids.has(read.workflow.app?.outputs[0] ?? "")).toBe(true);
  });

  it("is copied with a template, its fields on the copy's steps", () => {
    const template = templateWorkflows().find(
      (entry) => entry.id === "template-album-cover",
    ) as Workflow;
    const copy = copyTemplate(template, { ...graph(), nodes: [], edges: [] });
    const field = copy.app?.fields[0];
    expect(copy.nodes.find((node) => node.id === field?.nodeId)?.type).toBe("textInput");
    expect(copy.nodes.some((node) => node.id === copy.app?.outputs[0])).toBe(true);
  });
});

describe("the editor's app view", () => {
  beforeEach(() => {
    vi.resetModules();
    state.saved = [];
    window.localStorage.clear();
  });

  const row = (workflow: Workflow) => ({
    id: workflow.id,
    name: workflow.name,
    definition: JSON.stringify({
      nodes: workflow.nodes,
      edges: workflow.edges,
      ...(workflow.app ? { app: workflow.app } : {}),
    }),
    formatVersion: 2,
    origin: "mine",
    createdAt: 1,
    updatedAt: 1,
  });

  it("opens an app as one, edits the graph from its field, and goes back to the graph", async () => {
    const app = {
      fields: [{ nodeId: "t", param: "text", label: "Describe the album" }],
      outputs: ["o"],
      intro: "One cover.",
    };
    state.rows = [row({ ...graph(), app })];
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    render(<WorkflowStudio catalog={catalog} />);
    await screen.findByRole("button", { name: "Open Cover" }).then((card) => card.click());
    const form = await screen.findByRole("region", { name: "App" });
    expect(within(form).getByText("One cover.")).toBeInTheDocument();
    expect(within(form).getByText("Describe the album")).toBeInTheDocument();
    const field = within(form).getByDisplayValue("Neon");
    fireEvent.change(field, { target: { value: "Chrome" } });
    await waitFor(() =>
      expect(state.saved.some((definition) => definition.includes("Chrome"))).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.queryByRole("region", { name: "App" })).toBeNull();
  });

  it("makes a workflow an app from a suggestion, and keeps it with the workflow", async () => {
    state.rows = [row(graph())];
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    render(<WorkflowStudio catalog={catalog} />);
    await screen.findByRole("button", { name: "Open Cover" }).then((card) => card.click());
    fireEvent.click(await screen.findByRole("button", { name: "App" }));
    fireEvent.click(await screen.findByRole("button", { name: "Make it an app" }));
    const dialog = await screen.findByRole("dialog", { name: "Make this workflow an app" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name of Text" }), {
      target: { value: "Your album" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Keep this app" }));
    });
    expect(await screen.findByText("Your album")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        state.saved.some((definition) => JSON.parse(definition).app?.fields?.length === 2),
      ).toBe(true),
    );
  });
});
