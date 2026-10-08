import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (value: string) => value }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { AssistantMediaCard } from "../components/chat-blocks/AssistantMediaCard";
import { RefinePanel } from "../components/chat-blocks/RefinePanel";
import { refinedVersions, runRefine } from "../lib/image-refine";
import { versionTitle } from "../lib/studio/retouch/labels";
import type { StudioArtifact } from "../lib/studio/types";

function artifact(id: string, extra: Partial<StudioArtifact> = {}): StudioArtifact {
  return {
    id,
    kind: "image",
    path: `/gallery/${id}`,
    fileName: id,
    bytes: 10,
    model: "m",
    prompt: "",
    createdAt: 1,
    ...extra,
  };
}

/** What the gallery says on disk and in its durable records. */
let gallery: StudioArtifact[] = [];

function galleryCommands(command: string) {
  if (command === "carpe_diem_media_list_artifacts")
    return gallery.map((entry) => ({
      path: entry.path,
      fileName: entry.fileName,
      bytes: entry.bytes,
      modifiedMs: entry.createdAt,
    }));
  if (command === "studio_artifact_list")
    return gallery.map(({ path: _path, ...generation }) => ({
      id: generation.id,
      title: "",
      projectIds: [],
      generation,
    }));
  if (command === "carpe_diem_media_read_artifact") return "aGk=";
  return undefined;
}

beforeEach(() => {
  invoke.mockReset();
  gallery = [];
  localStorage.clear();
});

describe("the refine loop", () => {
  it("runs each pass on the version the last one made, under the same root", async () => {
    invoke.mockImplementation(async (_command: string, args: { request: { n: number } }) =>
      args.request.n === 1
        ? {
            critique: { satisfied: false, issues: ["x"] },
            root: "a.png",
            n: 1,
            fileName: "b.png",
            pending: false,
          }
        : { critique: { satisfied: true, issues: [] }, root: "a.png", n: 2, pending: false },
    );
    const seen: number[] = [];
    const outcomes = await runRefine(
      { fileName: "a.png", prompt: "a red door", taskId: "task", passes: 2 },
      (outcome) => seen.push(outcome.n),
    );
    expect(outcomes).toHaveLength(2);
    expect(seen).toEqual([1, 2]);
    expect(invoke.mock.calls.map(([command, args]) => [command, args.request])).toEqual([
      [
        "image_refine_pass",
        {
          fileName: "a.png",
          prompt: "a red door",
          root: "a.png",
          n: 1,
          taskId: "task",
          model: undefined,
        },
      ],
      [
        "image_refine_pass",
        {
          fileName: "b.png",
          prompt: "a red door",
          root: "a.png",
          n: 2,
          taskId: "task",
          model: undefined,
        },
      ],
    ]);
  });

  it("stops at a satisfied check, a pending edit, and never runs more than two passes", async () => {
    invoke.mockResolvedValue({
      critique: { satisfied: false, issues: [] },
      root: "a.png",
      n: 1,
      jobId: "j",
      pending: true,
    });
    expect(await runRefine({ fileName: "a.png", prompt: "p", passes: 2 })).toHaveLength(1);
    invoke.mockReset();
    invoke.mockImplementation(async (_command: string, args: { request: { n: number } }) => ({
      critique: { satisfied: false, issues: [] },
      root: "a.png",
      n: args.request.n,
      fileName: `v${args.request.n}.png`,
      pending: false,
    }));
    expect(await runRefine({ fileName: "a.png", prompt: "p", passes: 9 })).toHaveLength(2);
  });

  it("reads the refined versions of a picture back from the gallery, in order", () => {
    const versions = refinedVersions(
      [
        artifact("v2.png", { edit: { of: "v1.png", root: "a.png", op: "refine", n: 2 } }),
        artifact("r.png", { edit: { of: "a.png", root: "a.png", op: "prompt", n: 1 } }),
        artifact("v1.png", { edit: { of: "a.png", root: "a.png", op: "refine", n: 1 } }),
        artifact("other.png", { edit: { of: "z.png", root: "z.png", op: "refine", n: 1 } }),
      ],
      "a.png",
    );
    expect(versions.map((entry) => entry.id)).toEqual(["v1.png", "v2.png"]);
    expect(versionTitle(versions[0])).toBe("Refinement 1");
    expect(
      versionTitle(artifact("r.png", { edit: { of: "a", root: "a", op: "prompt", n: 3 } })),
    ).toBe("Retouch 3");
  });
});

describe("refining a chat picture", () => {
  it("says the price before spending, and runs only after the second tap", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "image_refine_estimate")
        return {
          model: "seedream-v4-edit",
          modelName: "Seedream",
          passes: 2,
          perPassCredits: 4.5,
          totalCredits: 9,
        };
      if (command === "image_refine_pass") {
        gallery = [
          artifact("a.png"),
          artifact("b.png", {
            prompt: "Write OPEN on the sign.",
            edit: { of: "a.png", root: "a.png", op: "refine", n: 1 },
          }),
        ];
        return {
          critique: { satisfied: false, issues: ["blank sign"], instruction: "Write OPEN" },
          root: "a.png",
          n: 1,
          fileName: "b.png",
          pending: false,
        };
      }
      return galleryCommands(command);
    });
    render(<RefinePanel fileName="a.png" prompt="A shop with an OPEN sign" taskId="task" />);
    fireEvent.click(await screen.findByRole("button", { name: "Refine" }));
    expect(await screen.findByText(/At most 9.0 credits/)).toBeTruthy();
    expect(invoke.mock.calls.some(([command]) => command === "image_refine_pass")).toBe(false);

    // A refine that satisfies itself after one pass spends one edit.
    let passes = 0;
    const base = invoke.getMockImplementation();
    invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === "image_refine_pass") {
        passes += 1;
        if (passes === 2)
          return { critique: { satisfied: true, issues: [] }, root: "a.png", n: 2, pending: false };
      }
      return base?.(command, args);
    });
    fireEvent.click(screen.getByRole("button", { name: "Refine" }));
    await screen.findByText("Refined. Every version is kept in your Studio gallery.");
    expect(passes).toBe(2);
    expect(invoke).toHaveBeenCalledWith("image_refine_pass", {
      request: expect.objectContaining({
        fileName: "a.png",
        n: 1,
        taskId: "task",
        model: "seedream-v4-edit",
      }),
    });
    expect(await screen.findByText(/Refinement 1/)).toBeTruthy();
  });

  it("cancelling the price spends nothing", async () => {
    invoke.mockImplementation(async (command: string) =>
      command === "image_refine_estimate"
        ? { model: "m", modelName: "M", passes: 2 }
        : galleryCommands(command),
    );
    render(<RefinePanel fileName="a.png" prompt="p" />);
    fireEvent.click(await screen.findByRole("button", { name: "Refine" }));
    expect(await screen.findByText(/The price of an edit is not published/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
    expect(invoke.mock.calls.some(([command]) => command === "image_refine_pass")).toBe(false);
  });

  it("is offered on a finished image proposal, never on a video or before it lands", async () => {
    const proposal = {
      id: "00000000-0000-4000-8000-000000000001",
      task_id: "task",
      kind: "image",
      model: "m",
      prompt: "A quiet garden",
      parameters: {},
      cost_credits: 1,
      status: "completed",
      artifact_file_name: "a.png",
      error: null,
    };
    invoke.mockImplementation(async (command: string) =>
      command === "assistant_media_get" ? proposal : galleryCommands(command),
    );
    const { unmount } = render(<AssistantMediaCard id={proposal.id} />);
    expect(await screen.findByRole("button", { name: "Refine" })).toBeTruthy();
    unmount();
    invoke.mockImplementation(async (command: string) =>
      command === "assistant_media_get"
        ? { ...proposal, kind: "video", artifact_file_name: "a.mp4" }
        : galleryCommands(command),
    );
    render(<AssistantMediaCard id={proposal.id} />);
    await screen.findByText("A quiet garden");
    expect(screen.queryByRole("button", { name: "Refine" })).toBeNull();
  });
});
