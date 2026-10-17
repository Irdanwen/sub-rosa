// The phone's Apps (ADR-0119): the workflows made apps, each used through its
// form and run through the same durable engine as the desktop, the shipped
// apps to start from, a held gate's candidates, and an unfinished run
// offered again rather than resumed on its own.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appGraph, heldGate, needsWindowOpen } from "../lib/studio/workflow/app-run";
import type { Workflow } from "../lib/studio/workflow/schema";

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  calls: [] as string[],
  saved: [] as string[],
  runs: [] as unknown[],
  hold: false,
  release: undefined as (() => void) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { request?: { definition?: string } }) => {
    state.calls.push(command);
    if (command === "studio_workflow_list") return state.rows;
    if (command === "workflow_run_list") return state.runs;
    if (command === "workflow_run_history") return [];
    if (command === "workflow_cache_known") return [];
    if (command === "workflow_run_create" && state.hold)
      return new Promise<void>((resolve) => {
        state.release = resolve;
      });
    if (command === "carpe_diem_media_list_artifacts") return [];
    if (command === "studio_workflow_save" && args?.request?.definition)
      state.saved.push(args.request.definition);
    return null;
  }),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const catalog = { backend: "carpe-diem" as const, models: [] };

function app(): Workflow {
  return {
    id: "w",
    name: "Echo",
    nodes: [
      {
        id: "t",
        type: "textInput",
        label: "Words",
        position: { x: 0, y: 0 },
        params: { text: "Hello" },
      },
      { id: "o", type: "output", label: "Said", position: { x: 300, y: 0 }, params: {} },
    ],
    edges: [{ id: "e", source: "t", target: "o", targetPort: "in" }],
    app: {
      fields: [{ nodeId: "t", param: "text", label: "What to say" }],
      outputs: ["o"],
      intro: "Says it back.",
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

const row = (workflow: Workflow) => ({
  id: workflow.id,
  name: workflow.name,
  definition: JSON.stringify({ nodes: workflow.nodes, edges: workflow.edges, app: workflow.app }),
  formatVersion: 2,
  origin: "mine",
  createdAt: 1,
  updatedAt: 1,
});

beforeEach(() => {
  vi.resetModules();
  state.rows = [row(app())];
  state.calls = [];
  state.saved = [];
  state.runs = [];
  state.hold = false;
  state.release = undefined;
  window.localStorage.clear();
});

describe("the phone's apps", () => {
  it("opens an app as its form, keeps what is typed, and runs it", async () => {
    const { StudioApps } = await import("../components/mobile/screens/studio/StudioApps");
    render(<StudioApps catalog={catalog} />);
    fireEvent.click(await screen.findByRole("button", { name: /Echo/ }));
    expect(screen.getByText("Says it back.")).toBeInTheDocument();
    const field = screen.getByRole("textbox", { name: "What to say" });
    fireEvent.change(field, { target: { value: "Bonsoir" } });
    await waitFor(() =>
      expect(state.saved.some((definition) => definition.includes("Bonsoir"))).toBe(true),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
    });
    await waitFor(() => expect(state.calls).toContain("workflow_run_create"));
    // The free run is made at once, with no sheet to confirm.
    expect(
      await screen.findByText("Bonsoir", { selector: ".mobile-app-text" }),
    ).toBeInTheDocument();
  });

  it("keeps a run going when the person goes back, and finds it again on reopening", async () => {
    state.hold = true;
    const { StudioApps } = await import("../components/mobile/screens/studio/StudioApps");
    render(<StudioApps catalog={catalog} />);
    fireEvent.click(await screen.findByRole("button", { name: /Echo/ }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Run" }));
    });
    await waitFor(() => expect(state.release).toBeDefined());
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    // Back to the list: the run is not killed, and not listed as unfinished.
    fireEvent.click(screen.getByRole("button", { name: "All apps" }));
    await screen.findByRole("button", { name: /Echo/ });
    expect(screen.queryByText(/stopped before it finished/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Echo/ }));
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    await act(async () => {
      state.release?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(await screen.findByText("Hello", { selector: ".mobile-app-text" })).toBeInTheDocument();
  });

  it("names a run held at a gate for what it is, and opens its app", async () => {
    state.runs = [
      {
        id: "run-2",
        workflowId: "w",
        name: "Echo",
        status: "awaitingGate",
        definition: JSON.stringify(app()),
        createdAt: "2026-10-17T10:00:00Z",
        updatedAt: "2026-10-17T10:00:00Z",
      },
    ];
    const { StudioApps } = await import("../components/mobile/screens/studio/StudioApps");
    render(<StudioApps catalog={catalog} />);
    expect(await screen.findByText("Echo waits for your approval.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("Says it back.")).toBeInTheDocument();
  });

  it("starts a new app from a shipped one", async () => {
    state.rows = [];
    const { StudioApps } = await import("../components/mobile/screens/studio/StudioApps");
    render(<StudioApps catalog={catalog} />);
    expect(await screen.findByText("No apps yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Album cover/ }));
    expect(await screen.findByRole("textbox", { name: "Describe the album" })).toBeInTheDocument();
    expect(
      state.saved.some((definition) => JSON.parse(definition).template === "template-album-cover"),
    ).toBe(true);
  });

  it("offers an unfinished run again, and lets it go when asked", async () => {
    state.runs = [
      {
        id: "run-1",
        workflowId: "w",
        name: "Echo",
        status: "running",
        definition: JSON.stringify(app()),
        createdAt: "2026-10-17T10:00:00Z",
        updatedAt: "2026-10-17T10:00:00Z",
      },
    ];
    const { StudioApps } = await import("../components/mobile/screens/studio/StudioApps");
    render(<StudioApps catalog={catalog} />);
    expect(await screen.findByText(/stopped before it finished/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Let it go" }));
    await waitFor(() => expect(state.calls).toContain("workflow_run_dismiss"));
  });
});

describe("running an app away from the canvas", () => {
  it("names a held gate's candidates, with what each made", () => {
    const workflow: Workflow = {
      ...app(),
      nodes: [
        {
          id: "a",
          type: "textInput",
          label: "First take",
          position: { x: 0, y: 0 },
          params: { text: "A" },
        },
        {
          id: "b",
          type: "textInput",
          label: "Second take",
          position: { x: 0, y: 1 },
          params: { text: "B" },
        },
        {
          id: "g",
          type: "gate",
          label: "",
          position: { x: 1, y: 0 },
          params: { note: "Pick one" },
        },
      ],
      edges: [
        { id: "1", source: "a", target: "g", targetPort: "in" },
        { id: "2", source: "b", target: "g", targetPort: "in" },
      ],
    };
    const results = new Map([
      ["a", { nodeId: "a", status: "done" as const, output: { kind: "text" as const, text: "A" } }],
      ["g", { nodeId: "g", status: "awaiting" as const }],
    ]);
    const gate = heldGate(results, appGraph(workflow));
    expect(gate?.note).toBe("Pick one");
    expect(
      gate?.candidates.map((candidate) => [candidate.label, candidate.result?.status]),
    ).toEqual([
      ["First take", "done"],
      ["Second take", undefined],
    ]);
    expect(heldGate(new Map(), appGraph(workflow))).toBeUndefined();
  });

  it("says when the phone must stay open to finish", () => {
    expect(needsWindowOpen(appGraph(app()))).toBe(false);
    const cut: Workflow = {
      ...app(),
      nodes: [
        ...app().nodes,
        { id: "c", type: "assemble", label: "", position: { x: 0, y: 0 }, params: {} },
      ],
    };
    expect(needsWindowOpen(appGraph(cut))).toBe(true);
  });
});
