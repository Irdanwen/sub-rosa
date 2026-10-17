// A ComfyUI file imported through the editor keeps what the importer made of
// its groups and subgraphs: the frames and the blocks reach the stored
// workflow, where they used to be dropped between the review and the save.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ definitions: [] as string[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { request?: { definition?: string } }) => {
    if (command === "studio_workflow_list") return [];
    if (command === "workflow_run_history") return [];
    if (command === "studio_workflow_save" && args?.request?.definition)
      saved.definitions.push(args.request.definition);
    return null;
  }),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const SUBGRAPH = "5c2b0f3e-1d2e-4c1b-9a7f-3e2d1c0b9a8f";
const comfyFile = {
  nodes: [
    {
      id: 1,
      type: "LoadImage",
      mode: 0,
      inputs: [],
      widgets_values: ["hero.png", "image"],
      pos: [0, 0],
    },
    {
      id: 2,
      type: SUBGRAPH,
      mode: 0,
      inputs: [{ name: "picture", link: 1, type: "IMAGE" }],
      widgets_values: [],
      pos: [300, 0],
    },
  ],
  links: [[1, 1, 0, 2, 0, "IMAGE"]],
  groups: [{ title: "Opening", bounding: [-20, -60, 700, 300], color: "#3f789e" }],
  definitions: {
    subgraphs: [
      {
        id: SUBGRAPH,
        name: "Animate",
        inputs: [{ name: "picture", type: "IMAGE" }],
        outputs: [{ name: "clip", type: "VIDEO" }],
        nodes: [
          {
            id: 1,
            type: "KlingImage2VideoNode",
            mode: 0,
            inputs: [{ name: "start_frame", link: 10, type: "IMAGE" }],
            widgets_values: ["Slow push in"],
            pos: [0, 0],
          },
        ],
        links: [
          [10, -10, 0, 1, 0, "IMAGE"],
          [11, 1, 0, -20, 0, "VIDEO"],
        ],
      },
    ],
  },
};

describe("importing a ComfyUI file in the editor", () => {
  it("keeps its groups as frames and its subgraphs as blocks", async () => {
    const { WorkflowStudio } = await import("../components/studio/WorkflowStudio");
    render(
      <WorkflowStudio
        catalog={{
          backend: "carpe-diem",
          models: [
            {
              id: "kling-2.5-turbo-pro-image-to-video",
              mediaType: "imageToVideo",
              name: "Kling 2.5 Turbo Pro (image)",
              offline: false,
            },
          ],
        }}
      />,
    );
    const input = await screen.findByLabelText("Workflow file");
    const file = new File([JSON.stringify(comfyFile)], "animate.json", {
      type: "application/json",
    });
    fireEvent.change(input, { target: { files: [file] } });
    const dialog = await screen.findByRole("dialog", { name: "Import a ComfyUI workflow" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(saved.definitions.some((definition) => definition.includes('"blocks"'))).toBe(true),
    );
    const stored = JSON.parse(
      saved.definitions.find((definition) => definition.includes('"blocks"')) as string,
    );
    expect(stored.blocks[0].name).toBe("Animate");
    expect(stored.frames[0].label).toBe("Opening");
    expect(stored.nodes.some((node: { type: string }) => node.type === "block")).toBe(true);
  });
});
