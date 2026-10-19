// An asset step's setting on the desktop canvas takes a file from the
// computer, picked or dropped, and refuses one of another kind.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ParamControl } from "../components/studio/workflow/ParamField";
import type { ArtifactIndex } from "../components/studio/workflow/flow";
import type { ParamSchema, WorkflowNode } from "../lib/studio/workflow/schema";

const mocks = vi.hoisted(() => ({
  importAssetFile: vi.fn(),
}));

vi.mock("../lib/studio/import-asset", async (original) => {
  const actual = await original<typeof import("../lib/studio/import-asset")>();
  return { ...actual, importAssetFile: mocks.importAssetFile };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  convertFileSrc: (path: string) => path,
}));

const catalog = { backend: "carpe-diem" as const, models: [] };
const param: ParamSchema = { name: "artifactId", type: "artifact", label: "Gallery item" };

function node(assetKind: "image" | "video" | "audio"): WorkflowNode {
  return {
    id: "a",
    type: "asset",
    label: "",
    position: { x: 0, y: 0 },
    params: { assetKind, artifactId: "" },
  };
}

function index(): ArtifactIndex {
  return { byId: new Map(), loaded: true, remember: vi.fn() } as unknown as ArtifactIndex;
}

function clip(name: string) {
  return {
    id: name,
    kind: "video" as const,
    path: `/g/${name}`,
    fileName: name,
    bytes: 9,
    model: "",
    prompt: "",
    createdAt: 1,
  };
}

// Braces on purpose: `mockReset()` returns the mock, and a hook that returns
// a function hands vitest a cleanup to call.
beforeEach(() => {
  mocks.importAssetFile.mockReset();
});

describe("an asset setting on the canvas", () => {
  it("imports a file picked from the computer and keeps it as the pick", async () => {
    mocks.importAssetFile.mockImplementation(async (file: File) => clip(file.name));
    const onMerge = vi.fn();
    const artifacts = index();
    render(
      <ParamControl
        node={node("video")}
        param={param}
        catalog={catalog}
        artifacts={artifacts}
        textSources={[]}
        constraintEpoch={0}
        onMerge={onMerge}
      />,
    );
    const input = screen.getByLabelText("Import a file for Gallery item") as HTMLInputElement;
    expect(input.accept).toContain("video/*");
    expect(input.accept).toContain(".mov");
    const file = new File([new Uint8Array(4)], "clip.mov", { type: "video/quicktime" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(onMerge).toHaveBeenCalledWith({ artifactId: "clip.mov", assetLabel: "clip.mov" }),
    );
    expect(mocks.importAssetFile).toHaveBeenCalledWith(file, "video");
    expect(artifacts.remember).toHaveBeenCalledWith(clip("clip.mov"));
  });

  it("takes a file dropped on it", async () => {
    mocks.importAssetFile.mockImplementation(async (file: File) => clip(file.name));
    const onMerge = vi.fn();
    render(
      <ParamControl
        node={node("video")}
        param={param}
        catalog={catalog}
        artifacts={index()}
        textSources={[]}
        constraintEpoch={0}
        onMerge={onMerge}
      />,
    );
    const zone = screen.getByRole("region", { name: /Gallery item: pick from the gallery/ });
    const file = new File([new Uint8Array(4)], "drop.mp4", { type: "video/mp4" });
    fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });
    await waitFor(() =>
      expect(onMerge).toHaveBeenCalledWith({ artifactId: "drop.mp4", assetLabel: "drop.mp4" }),
    );
  });

  it("says so when the file is not what the setting takes, and picks nothing", async () => {
    mocks.importAssetFile.mockRejectedValue(new Error("This setting takes a clip, not this file."));
    const onMerge = vi.fn();
    render(
      <ParamControl
        node={node("video")}
        param={param}
        catalog={catalog}
        artifacts={index()}
        textSources={[]}
        constraintEpoch={0}
        onMerge={onMerge}
      />,
    );
    const input = screen.getByLabelText("Import a file for Gallery item");
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array(4)], "pic.png", { type: "image/png" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("This setting takes a clip");
    expect(onMerge).not.toHaveBeenCalled();
  });
});
