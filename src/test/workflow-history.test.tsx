/**
 * A workflow's past runs: what a run left on its steps is read back from
 * gallery references, the history lists runs without their graphs, and the
 * panel shows how each ended and offers its results and its graph back.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (p: string) => p }));
vi.mock("../lib/artifact-media", () => ({
  artifactDataUrl: vi.fn(async () => "data:image/png;base64,AA"),
}));
vi.mock("../lib/mobile", () => ({ isMobilePlatform: () => false }));
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  listArtifacts: vi.fn(async () => [
    {
      id: "a.png",
      kind: "image",
      path: "/g/a.png",
      fileName: "a.png",
      bytes: 1,
      model: "m",
      prompt: "p",
      createdAt: 1,
    },
  ]),
}));

import { RunHistoryPanel } from "../components/studio/workflow/RunHistoryPanel";
import { runCredits, runResults, workflowRunHistory } from "../lib/studio/workflow-run";

beforeEach(() => mocks.invoke.mockReset());

describe("a past run's results", () => {
  it("reads outputs back, keeps errors, and leaves out what is gone", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "workflow_run_get")
        return {
          run: {
            id: "r",
            workflowId: "w",
            name: "w",
            definition: JSON.stringify({ nodes: [], edges: [] }),
            status: "failed",
            createdAt: "",
            updatedAt: "",
          },
          nodes: [
            {
              nodeId: "text",
              status: "done",
              output: JSON.stringify({ kind: "text", text: "Hello" }),
              updatedAt: "",
            },
            {
              nodeId: "pic",
              status: "done",
              output: JSON.stringify({ kind: "image", artifactId: "a.png", mimeType: "image/png" }),
              updatedAt: "",
            },
            {
              nodeId: "gone",
              status: "done",
              output: JSON.stringify({
                kind: "image",
                artifactId: "deleted.png",
                mimeType: "image/png",
              }),
              updatedAt: "",
            },
            { nodeId: "bad", status: "error", error: "The rail said no.", updatedAt: "" },
            {
              nodeId: "waiting",
              status: "running",
              output: JSON.stringify({ pendingJobId: "j" }),
              updatedAt: "",
            },
          ],
        };
      return null;
    });
    const { results, definition } = await runResults("r");
    expect(results.get("text")).toMatchObject({
      status: "done",
      output: { kind: "text", text: "Hello" },
    });
    expect(results.get("pic")).toMatchObject({
      status: "done",
      output: { kind: "image", artifactId: "a.png" },
    });
    expect(results.has("gone")).toBe(false);
    expect(results.get("bad")).toMatchObject({ status: "error", error: "The rail said no." });
    expect(results.has("waiting")).toBe(false);
    expect(definition?.nodes).toEqual([]);
  });

  it("adds up what a run was confirmed at, and reads nothing when there is nothing", () => {
    expect(runCredits({ nodeCosts: JSON.stringify({ a: 4, b: 6.5, c: "x" }) })).toBe(10.5);
    expect(runCredits({})).toBeUndefined();
    expect(runCredits({ nodeCosts: "not json" })).toBeUndefined();
  });

  it("lists nothing when the native side cannot answer", async () => {
    // Only the history command fails: other calls made in passing still answer.
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "workflow_run_history") throw new Error("no bridge");
      return null;
    });
    expect(await workflowRunHistory("w")).toEqual([]);
  });
});

describe("the history panel", () => {
  const entries = [
    {
      id: "new",
      status: "completed",
      done: 3,
      nodeCosts: JSON.stringify({ a: 12 }),
      createdAt: "2026-10-17T09:00:00Z",
      updatedAt: "",
    },
    {
      id: "old",
      status: "failed",
      done: 0,
      error: "No credits left.",
      createdAt: "2026-10-16T09:00:00Z",
      updatedAt: "",
    },
  ];

  it("says how each run ended, what it made and cost, and gives its results and graph back", async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "workflow_run_history" ? entries : null,
    );
    const onShow = vi.fn();
    const onRestore = vi.fn();
    render(
      <RunHistoryPanel
        workflowId="w"
        refreshKey={0}
        onShow={onShow}
        onRestore={onRestore}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("Finished")).toBeInTheDocument());
    expect(screen.getByText("Stopped on an error")).toBeInTheDocument();
    expect(screen.getByText("3 steps made")).toBeInTheDocument();
    expect(screen.getByText("No credits left.")).toBeInTheDocument();
    const shows = screen.getAllByRole("button", { name: "Show results" });
    // Nothing to show for a run that made nothing.
    expect(shows[1]).toBeDisabled();
    await userEvent.click(shows[0]);
    expect(onShow).toHaveBeenCalledWith("new");
    await userEvent.click(screen.getAllByRole("button", { name: "Restore this graph" })[1]);
    expect(onRestore).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(onRestore).toHaveBeenCalledWith("old");
  });

  it("says so when the workflow has never run", async () => {
    mocks.invoke.mockResolvedValue([]);
    render(
      <RunHistoryPanel
        workflowId="w"
        refreshKey={0}
        onShow={() => {}}
        onRestore={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("This workflow has not run yet.")).toBeInTheDocument(),
    );
  });
});
