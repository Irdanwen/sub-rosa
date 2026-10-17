// Workflows open as tabs, and a run goes on in its tab while another is on
// screen: the tab says it is running, then that it finished, and the other
// canvas never shows its steps.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunSessions } from "../lib/studio/workflow/run-sessions";
import { MAX_TABS, closeTab, openTab } from "../lib/studio/workflow/tabs";

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  release: undefined as (() => void) | undefined,
}));

function row(id: string, name: string, nodes: unknown[], edges: unknown[] = []) {
  return {
    id,
    name,
    definition: JSON.stringify({ nodes, edges }),
    formatVersion: 2,
    origin: "mine",
    createdAt: 1,
    updatedAt: id === "a" ? 2 : 1,
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "studio_workflow_list") return state.rows;
    if (command === "workflow_run_history" || command === "workflow_run_list") return [];
    if (command === "workflow_cache_known") return [];
    // The run starts and waits here until the test lets it go on.
    if (command === "workflow_run_create")
      return new Promise<void>((resolve) => {
        state.release = resolve;
      });
    return null;
  }),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  state.release = undefined;
  state.rows = [
    row(
      "a",
      "Cover",
      [
        {
          id: "p",
          type: "textInput",
          label: "Prompt",
          position: { x: 0, y: 0 },
          params: { text: "a red car" },
        },
        { id: "o", type: "output", label: "", position: { x: 400, y: 0 }, params: {} },
      ],
      [{ id: "e", source: "p", target: "o" }],
    ),
    row("b", "Trailer", [
      { id: "n", type: "note", label: "", position: { x: 0, y: 0 }, params: { text: "Cut" } },
    ]),
  ];
});

const tab = (label: string) => screen.getByRole("tab", { name: label });

describe("workflow tabs", () => {
  it("keeps a run going in its tab while another is on screen", async () => {
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    render(<WorkflowStudio catalog={{ backend: "carpe-diem", models: [] }} />);
    await screen.findByRole("button", { name: "Open Cover" }).then((card) => card.click());
    fireEvent.click(await screen.findByRole("button", { name: "Library" }));
    await screen.findByRole("button", { name: "Open Trailer" }).then((card) => card.click());
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(tab("Trailer").getAttribute("aria-selected")).toBe("true");

    fireEvent.click(tab("Cover"));
    await waitFor(() => expect(tab("Cover").getAttribute("aria-selected")).toBe("true"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    await waitFor(() => expect(state.release).toBeDefined());
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

    // The other tab: its canvas is idle, and the first tab says it runs.
    fireEvent.click(tab("Trailer"));
    await waitFor(() => expect(tab("Cover, Running")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Cover" })).toBeNull();

    await act(async () => {
      state.release?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await waitFor(() => expect(tab("Cover, Finished")).toBeTruthy());

    // Opening it is seeing it: the tab is plain again.
    fireEvent.click(tab("Cover, Finished"));
    await waitFor(() => expect(tab("Cover").getAttribute("aria-selected")).toBe("true"));

    // Closing the other leaves one workflow, which is nothing to switch between.
    fireEvent.click(screen.getByRole("button", { name: "Close Trailer" }));
    await waitFor(() => expect(screen.queryByRole("tablist")).toBeNull());
    expect(JSON.parse(window.localStorage.getItem("os-june:studio-workflow-tabs") ?? "[]")).toEqual(
      ["a"],
    );
  });
});

describe("which tabs are open", () => {
  it("adds a tab at the end and lets the oldest idle one go past the limit", () => {
    const full = Array.from({ length: MAX_TABS }, (_, index) => `w${index}`);
    expect(openTab(full, "w3", () => false)).toEqual(full);
    expect(openTab(full, "new", (id) => id === "w0")).toEqual(["w0", ...full.slice(2), "new"]);
  });

  it("shows the right neighbour after closing the tab on screen, else the left", () => {
    expect(closeTab(["a", "b", "c"], "b", "b")).toEqual({ tabs: ["a", "c"], next: "c" });
    expect(closeTab(["a", "b", "c"], "c", "c")).toEqual({ tabs: ["a", "b"], next: "b" });
    expect(closeTab(["a", "b"], "a", "b")).toEqual({ tabs: ["b"], next: "b" });
  });
});

describe("a run session", () => {
  const graph = { id: "a", name: "A", nodes: [], edges: [], createdAt: 1, updatedAt: 1 };

  it("keeps the steps a partial run leaves alone, and stops the run it replaces", () => {
    const sessions = new RunSessions();
    const first = sessions.begin("a", { graph, timed: true });
    sessions.record("a", { nodeId: "x", status: "done" });
    sessions.record("a", { nodeId: "y", status: "done" });
    sessions.begin("a", { graph, timed: true, keep: (id) => id === "x" });
    expect(first.signal.aborted).toBe(true);
    expect([...sessions.results("a").keys()]).toEqual(["x"]);
    expect(sessions.status("a")).toBe("running");
  });

  it("says a run held at a gate waits, one with a failed step failed, and forgets when seen", () => {
    const sessions = new RunSessions();
    sessions.begin("a", { graph, timed: false });
    sessions.record("a", { nodeId: "gate", status: "awaiting" });
    expect(sessions.status("a")).toBe("held");
    sessions.end("a", "done");
    expect(sessions.status("a")).toBe("held");

    sessions.begin("b", { graph, timed: false });
    sessions.record("b", { nodeId: "x", status: "error", error: "Refused" });
    sessions.end("b", "done");
    expect(sessions.status("b")).toBe("failed");
    sessions.seen("b");
    expect(sessions.status("b")).toBeUndefined();

    sessions.begin("c", { graph, timed: false });
    sessions.end("c", "cancelled");
    expect(sessions.status("c")).toBeUndefined();
    expect(sessions.live()).toEqual([]);
  });

  it("keeps what stopped a run for when its tab opens, and stops a forgotten one", () => {
    const sessions = new RunSessions();
    const controller = sessions.begin("a", { graph, timed: false });
    expect(sessions.live()).toEqual(["a"]);
    sessions.fail("a", "Out of credits");
    expect(sessions.get("a")?.error).toBe("Out of credits");
    sessions.forget("a");
    expect(controller.signal.aborted).toBe(true);
    expect(sessions.get("a")).toBeUndefined();
  });
});
