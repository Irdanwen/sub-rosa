/**
 * The stored workflow, version 2: what this version does not read is carried
 * back unchanged, a newer version's workflow is shown and never saved over,
 * and an older node is brought forward on open or import (never in a run).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readWorkflowFile, workflowFileText } from "../lib/studio/workflow/comfy/file";
import { migrateWorkflow, type MigrationRegistry } from "../lib/studio/workflow/migrate";
import { type Workflow, WORKFLOW_FILE_VERSION } from "../lib/studio/workflow/schema";
import {
  listWorkflows,
  loadWorkflowLibrary,
  resetWorkflowLibraryForTests,
  saveWorkflow,
} from "../lib/studio/workflow/store";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, convertFileSrc: (p: string) => p }));

const catalog = { backend: "venice" as const, models: [] };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "w",
    name: "W",
    definition: JSON.stringify({
      nodes: [{ id: "t", type: "textInput", label: "", position: { x: 0, y: 0 }, params: {} }],
      edges: [],
      blocks: [{ id: "b", label: "Act one" }],
    }),
    formatVersion: 2,
    origin: "mine",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("the stored graph", () => {
  let table: Array<Record<string, unknown>>;
  beforeEach(() => {
    window.localStorage.clear();
    tauri.invoke
      .mockReset()
      .mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        if (command === "studio_workflow_list") return table;
        if (command === "studio_workflow_save") {
          const request = (args as { request: Record<string, unknown> }).request;
          table = [request, ...table.filter((entry) => entry.id !== request.id)];
        }
        return undefined;
      });
  });

  it("carries back what this version does not read", async () => {
    table = [row()];
    resetWorkflowLibraryForTests();
    await loadWorkflowLibrary();
    const [loaded] = listWorkflows();
    expect(loaded.extra).toEqual({ blocks: [{ id: "b", label: "Act one" }] });
    saveWorkflow({ ...loaded, name: "Renamed" });
    await vi.waitFor(() => expect(table[0].name).toBe("Renamed"));
    const definition = JSON.parse(String(table[0].definition));
    expect(definition.blocks).toEqual([{ id: "b", label: "Act one" }]);
    expect(definition.nodes).toHaveLength(1);
    expect(table[0].formatVersion).toBe(WORKFLOW_FILE_VERSION);
  });

  it("reads frames as frames and writes them back", async () => {
    const frame = { id: "f", label: "Act one", x: 0, y: 0, width: 300, height: 200 };
    table = [
      row({
        definition: JSON.stringify({
          nodes: [{ id: "t", type: "textInput", label: "", position: { x: 0, y: 0 }, params: {} }],
          edges: [],
          frames: [frame],
        }),
      }),
    ];
    resetWorkflowLibraryForTests();
    await loadWorkflowLibrary();
    const [loaded] = listWorkflows();
    expect(loaded.frames).toEqual([frame]);
    expect(loaded.extra).toBeUndefined();
    saveWorkflow({ ...loaded, name: "Renamed" });
    await vi.waitFor(() => expect(table[0].name).toBe("Renamed"));
    expect(JSON.parse(String(table[0].definition)).frames).toEqual([frame]);
  });

  it("shows a newer version's workflow and never saves over it", async () => {
    table = [row({ formatVersion: WORKFLOW_FILE_VERSION + 1 })];
    resetWorkflowLibraryForTests();
    await loadWorkflowLibrary();
    const [loaded] = listWorkflows();
    expect(loaded.readOnly).toBe(true);
    tauri.invoke.mockClear();
    const kept = saveWorkflow({ ...loaded, name: "Cut down", nodes: [] });
    expect(kept.name).toBe("W");
    expect(tauri.invoke).not.toHaveBeenCalledWith("studio_workflow_save", expect.anything());
  });

  it("reads a version 1 row as it always did", async () => {
    table = [row({ formatVersion: 1, definition: JSON.stringify({ nodes: [], edges: [] }) })];
    resetWorkflowLibraryForTests();
    await loadWorkflowLibrary();
    const [loaded] = listWorkflows();
    expect(loaded.readOnly).toBeUndefined();
    expect(loaded.extra).toBeUndefined();
  });
});

describe("bringing a node forward", () => {
  const registry: MigrationRegistry = {
    replacements: [
      { from: "speech", to: "tts", params: ({ script, ...rest }) => ({ ...rest, text: script }) },
    ],
    migrations: [
      {
        type: "music",
        from: 1,
        params: ({ seconds, ...rest }) => ({ ...rest, durationSeconds: seconds }),
      },
    ],
  };

  it("renames a step and reshapes its settings", () => {
    const old = {
      nodes: [
        { id: "a", type: "speech", label: "", position: { x: 0, y: 0 }, params: { script: "Hi" } },
      ],
    } as unknown as Pick<Workflow, "nodes">;
    const migrated = migrateWorkflow(old, registry);
    expect(migrated.nodes[0]).toMatchObject({ type: "tts", params: { text: "Hi" } });
  });

  it("walks a node's settings up to its schema's version, one step at a time", () => {
    const steps: MigrationRegistry = {
      ...registry,
      versions: { music: 3 },
      migrations: [
        ...registry.migrations,
        { type: "music", from: 2, params: (params) => ({ ...params, loop: false }) },
      ],
    };
    const nodes = [
      { id: "m", type: "music", label: "", position: { x: 0, y: 0 }, params: { seconds: 30 } },
    ] as Workflow["nodes"];
    const migrated = migrateWorkflow({ nodes }, steps);
    expect(migrated.nodes[0]).toMatchObject({
      v: 3,
      params: { durationSeconds: 30, loop: false },
    });
    expect(migrated.nodes[0].params).not.toHaveProperty("seconds");
    // Already there: left alone.
    expect(migrateWorkflow(migrated, steps)).toBe(migrated);
    // A missing step stops the walk rather than guessing.
    const gap = migrateWorkflow({ nodes }, { ...steps, versions: { music: 4 } });
    expect(gap.nodes[0].v).toBe(3);
  });

  it("returns the very same workflow when nothing changes, so opening is not an edit", () => {
    const workflow = {
      nodes: [{ id: "t", type: "textInput", label: "", position: { x: 0, y: 0 }, params: {} }],
    } as Pick<Workflow, "nodes">;
    expect(migrateWorkflow(workflow)).toBe(workflow);
  });
});

describe("the exported file", () => {
  const workflow: Workflow = {
    id: "w",
    name: "Spot",
    nodes: [{ id: "t", type: "textInput", label: "", position: { x: 0, y: 0 }, params: {} }],
    edges: [],
    createdAt: 1,
    updatedAt: 1,
    extra: { blocks: [{ id: "b" }] },
  };

  it("writes version 2 with what it carries, and reads it back", () => {
    const text = workflowFileText(workflow);
    expect(JSON.parse(text).version).toBe(2);
    const read = readWorkflowFile(text, catalog);
    expect(read.kind).toBe("subrosa");
    if (read.kind === "subrosa") expect(read.workflow.extra).toEqual({ blocks: [{ id: "b" }] });
  });

  it("still reads a version 1 file", () => {
    const text = JSON.stringify({
      format: "subrosa-workflow",
      version: 1,
      workflow: { name: "Old", nodes: workflow.nodes, edges: [] },
    });
    const read = readWorkflowFile(text, catalog);
    expect(read.kind).toBe("subrosa");
  });

  it("refuses a file from a newer version rather than misreading it", () => {
    const text = JSON.stringify({
      format: "subrosa-workflow",
      version: WORKFLOW_FILE_VERSION + 1,
      workflow: { name: "New", nodes: [], edges: [] },
    });
    expect(() => readWorkflowFile(text, catalog)).toThrow("newer version");
  });
});
