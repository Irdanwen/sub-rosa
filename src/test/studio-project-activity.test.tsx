import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectShots } from "../components/studio/ProjectShots";
import { foldLiveRender, nodeTarget, targetKey } from "../lib/studio/project-activity";
import { newProject, newShot } from "../lib/studio/projects";
import type { MediaCatalog } from "../lib/studio/types";
import type { WorkflowNode } from "../lib/studio/workflow/schema";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../lib/studio/artifacts", () => ({ artifactSrc: () => "asset://file" }));

const uuid = "0b7c6a4e-1f2d-4c3b-9a8e-7d6c5b4a3f21";

describe("nodeTarget", () => {
  it("reads what a compiled step makes from its id", () => {
    expect(nodeTarget(`shot-${uuid}`)).toEqual({ kind: "take", shotId: uuid });
    expect(nodeTarget(`image-${uuid}`)).toEqual({ kind: "opening", shotId: uuid });
    expect(nodeTarget(`line-${uuid}`)).toEqual({ kind: "line", shotId: uuid });
    expect(nodeTarget(`bible-${uuid}-sheet`)).toEqual({
      kind: "bible",
      entryId: uuid,
      role: "sheet",
    });
    expect(nodeTarget(`score-${uuid}`)).toEqual({ kind: "cue", cueId: uuid });
  });

  it("has no place for plumbing", () => {
    expect(nodeTarget("score-prompt")).toBeUndefined();
    expect(nodeTarget(`bible-${uuid}-sheet-source`)).toBeUndefined();
    expect(nodeTarget(`selected-take-${uuid}`)).toBeUndefined();
    expect(nodeTarget("assemble")).toBeUndefined();
  });

  it("keys each place once", () => {
    expect(targetKey({ kind: "bible", entryId: "a", role: "portrait" })).toBe("bible:a:portrait");
    expect(targetKey({ kind: "take", shotId: "s" })).toBe("take:s");
  });
});

describe("foldLiveRender", () => {
  const node: WorkflowNode = {
    id: "shot-s",
    type: "video",
    label: "",
    position: { x: 0, y: 0 },
    params: { model: "kling-v3", aspect_ratio: "16:9" },
  };

  it("starts the clock once, marks a wait for a slot, and files the time it took", () => {
    let state = foldLiveRender({}, { nodeId: "shot-s", status: "running" }, node, 1_000).live;
    expect(state["shot-s"]).toMatchObject({
      phase: "processing",
      startedAt: 1_000,
      etaKey: "video:kling-v3",
      aspectRatio: "16:9",
    });
    state = foldLiveRender(
      state,
      { nodeId: "shot-s", status: "running", note: "busy" },
      node,
      5_000,
    ).live;
    expect(state["shot-s"]).toMatchObject({ phase: "queued", startedAt: 1_000 });
    const done = foldLiveRender(state, { nodeId: "shot-s", status: "done" }, node, 61_000);
    expect(done.live).toEqual({});
    expect(done.finished).toEqual({ etaKey: "video:kling-v3", elapsedMs: 60_000 });
  });

  it("forgets a failed step without teaching the estimate", () => {
    const state = foldLiveRender({}, { nodeId: "shot-s", status: "running" }, node, 0).live;
    const failed = foldLiveRender(state, { nodeId: "shot-s", status: "error" }, node, 9_000);
    expect(failed.live).toEqual({});
    expect(failed.finished).toBeUndefined();
  });

  it("ignores steps that have no place to show", () => {
    expect(
      foldLiveRender({}, { nodeId: "assemble", status: "running" }, undefined, 0).live,
    ).toEqual({});
  });
});

describe("the shot editor while a take is made", () => {
  const catalog: MediaCatalog = { backend: "carpe-diem", models: [] };

  it("shows the chamber in the monitor, the list and a pending take", () => {
    const document = newProject("Film").document;
    document.shots = [{ ...newShot(0), id: "s", title: "The hall", takeIds: [] }];
    render(
      <ProjectShots
        document={document}
        onChange={vi.fn()}
        artifacts={[]}
        catalog={catalog}
        onGenerate={vi.fn()}
        onImage={vi.fn()}
        onBible={vi.fn()}
        busy
        now={75_000}
        live={[
          {
            nodeId: "shot-s",
            target: { kind: "take", shotId: "s" },
            startedAt: 30_000,
            phase: "processing",
            etaKey: "video:none",
          },
        ]}
      />,
    );
    expect(screen.getByText("Rendering take 1")).toBeTruthy();
    expect(screen.getByText("Rendering · 45s")).toBeTruthy();
    expect(screen.getByText("Take 1").closest("[aria-busy='true']")).toBeTruthy();
    expect(screen.queryByText("Your shot starts here")).toBeNull();
  });
});
