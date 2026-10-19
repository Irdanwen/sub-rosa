// The phone's app form (ADR-0119): each kind of setting drawn with the
// phone's own control, and a run that asks before spending, says when the
// phone must stay open, and continues from a gate with the chosen take.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppField } from "../components/mobile/screens/studio/AppField";
import type { ShownField } from "../lib/studio/workflow/app";
import type { ParamSchema, WorkflowNode } from "../lib/studio/workflow/schema";

const state = vi.hoisted(() => ({ calls: [] as string[], args: [] as unknown[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => {
    state.calls.push(command);
    state.args.push(args);
    if (command === "carpe_diem_media_list_artifacts")
      return [
        { path: "/g/hero.png", fileName: "hero.png", bytes: 10, modifiedMs: 1 },
        { path: "/g/theme.mp3", fileName: "theme.mp3", bytes: 10, modifiedMs: 2 },
      ];
    if (command === "studio_artifact_save")
      return { id: (args as { request: { id: string } }).request.id };
    if (command === "studio_workflow_list" || command === "workflow_run_history") return [];
    if (command === "workflow_cache_known") return [];
    return null;
  }),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const imports = vi.hoisted(() => ({ importAssetFile: vi.fn() }));
vi.mock("../lib/studio/import-asset", async (original) => {
  const actual = await original<typeof import("../lib/studio/import-asset")>();
  return { ...actual, importAssetFile: imports.importAssetFile };
});

const catalog = {
  backend: "carpe-diem" as const,
  models: [
    {
      id: "seedream-v4",
      mediaType: "image" as const,
      name: "Seedream v4",
      offline: false,
      costCredits: 4,
    },
    {
      id: "flux-2-pro",
      mediaType: "image" as const,
      name: "Flux 2 Pro",
      offline: false,
      costCredits: 1,
    },
  ],
};

function shown(
  type: WorkflowNode["type"],
  param: ParamSchema,
  params: Record<string, unknown>,
  label?: string,
): ShownField {
  return {
    field: { nodeId: "n", param: param.name, ...(label ? { label } : {}) },
    node: { id: "n", type, label: "", position: { x: 0, y: 0 }, params },
    param,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  state.calls = [];
  state.args = [];
});

describe("a field of an app on the phone", () => {
  it("picks a choice from a sheet", () => {
    const merge = vi.fn();
    render(
      <AppField
        shown={shown(
          "upscale",
          { name: "scale", type: "enum", label: "Scale", enumValues: ["2", "4"] },
          { scale: "2" },
          "How large",
        )}
        catalog={catalog}
        onMerge={merge}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "How large, 2" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "How large" })).getByRole("button", { name: "4" }),
    );
    expect(merge).toHaveBeenCalledWith({ scale: "4" });
  });

  it("switches a yes or no setting", () => {
    const merge = vi.fn();
    render(
      <AppField
        shown={shown(
          "music",
          { name: "instrumental", type: "boolean", label: "Instrumental" },
          {},
          "No voice",
        )}
        catalog={catalog}
        onMerge={merge}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "No voice" }));
    expect(merge).toHaveBeenCalledWith({ instrumental: true });
  });

  it("changes the model with what goes with it", () => {
    const merge = vi.fn();
    render(
      <AppField
        shown={shown(
          "image",
          { name: "model", type: "model", label: "Model", mediaType: "image" },
          { model: "seedream-v4" },
          "Model",
        )}
        catalog={catalog}
        onMerge={merge}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model, Seedream v4" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Model" })).getByRole("button", {
        name: "Flux 2 Pro",
      }),
    );
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ model: "flux-2-pro" }));
  });

  it("takes a number and words", () => {
    const merge = vi.fn();
    const { unmount } = render(
      <AppField
        shown={shown(
          "music",
          { name: "durationSeconds", type: "number", label: "Duration" },
          { durationSeconds: 30 },
          "Seconds",
        )}
        catalog={catalog}
        onMerge={merge}
      />,
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "Seconds" }), {
      target: { value: "45" },
    });
    expect(merge).toHaveBeenCalledWith({ durationSeconds: 45 });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Seconds" }), {
      target: { value: "" },
    });
    expect(merge).toHaveBeenCalledWith({ durationSeconds: undefined });
    unmount();
    render(
      <AppField
        shown={shown("tts", { name: "voice", type: "string", label: "Voice" }, { voice: "" })}
        catalog={catalog}
        onMerge={merge}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "af_bella" } });
    expect(merge).toHaveBeenCalledWith({ voice: "af_bella" });
  });

  it("picks a picture from the Studio gallery, and a track from its clips and tracks", async () => {
    const merge = vi.fn();
    const { unmount } = render(
      <AppField
        shown={shown(
          "asset",
          { name: "artifactId", type: "artifact", label: "Gallery item" },
          { assetKind: "image", artifactId: "" },
          "Your photo",
        )}
        catalog={catalog}
        onMerge={merge}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Choose a picture/ }));
    const sources = await screen.findByRole("dialog", { name: "Your photo" });
    fireEvent.click(within(sources).getByRole("button", { name: "From the Studio gallery" }));
    const sheet = await screen.findByRole("dialog", { name: "Choose from the gallery" });
    const tile = await waitFor(() => {
      const found = within(sheet)
        .getAllByRole("button")
        .find(
          (button) =>
            !/Cancel|Close/.test(button.getAttribute("aria-label") ?? button.textContent ?? ""),
        );
      if (!found) throw new Error("no picture yet");
      return found;
    });
    fireEvent.click(tile);
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ artifactId: "hero.png" }));
    unmount();
    render(
      <AppField
        shown={shown(
          "asset",
          { name: "artifactId", type: "artifact", label: "Gallery item" },
          { assetKind: "audio", artifactId: "" },
          "Your track",
        )}
        catalog={catalog}
        onMerge={merge}
      />,
    );
    await waitFor(() => expect(state.calls).toContain("carpe_diem_media_list_artifacts"));
    fireEvent.click(await screen.findByRole("button", { name: /Choose a track/ }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Your track" })).getByRole("button", {
        name: "From the Studio gallery",
      }),
    );
    const list = await screen.findByRole("dialog", { name: "Your track" });
    fireEvent.click(await within(list).findByRole("button", { name: /theme\.mp3/ }));
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ artifactId: "theme.mp3" }));
  });

  it("imports a clip from the phone, keeps it as the pick, and shows it on the tile", async () => {
    imports.importAssetFile.mockResolvedValue({
      id: "clip.mov",
      kind: "video",
      path: "/g/clip.mov",
      fileName: "clip.mov",
      bytes: 9,
      model: "",
      prompt: "",
      createdAt: 1,
    });
    const merge = vi.fn();
    const imported = vi.fn();
    const { rerender } = render(
      <AppField
        shown={shown(
          "asset",
          { name: "artifactId", type: "artifact", label: "Gallery item" },
          { assetKind: "video", artifactId: "" },
          "Your clip",
        )}
        catalog={catalog}
        onMerge={merge}
        onImported={imported}
      />,
    );
    // Nothing in the gallery yet: the field says where a clip can come from.
    expect(await screen.findByText(/No clip yet/)).toBeInTheDocument();
    const input = screen.getByLabelText("Photo library or Files") as HTMLInputElement;
    expect(input.accept).toContain("video/*");
    const file = new File([new Uint8Array(4)], "clip.mov", { type: "video/quicktime" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(merge).toHaveBeenCalledWith({ artifactId: "clip.mov", assetLabel: "clip.mov" }),
    );
    expect(imports.importAssetFile).toHaveBeenCalledWith(file, "video");
    expect(imported).toHaveBeenCalled();
    rerender(
      <AppField
        shown={shown(
          "asset",
          { name: "artifactId", type: "artifact", label: "Gallery item" },
          { assetKind: "video", artifactId: "clip.mov" },
          "Your clip",
        )}
        catalog={catalog}
        onMerge={merge}
        onImported={imported}
      />,
    );
    expect(await screen.findByRole("button", { name: /clip\.mov/ })).toBeInTheDocument();
  });

  it("says when the picked file is not what the field takes", async () => {
    imports.importAssetFile.mockRejectedValue(
      new Error("This setting takes a clip, not this file."),
    );
    render(
      <AppField
        shown={shown(
          "asset",
          { name: "artifactId", type: "artifact", label: "Gallery item" },
          { assetKind: "video", artifactId: "" },
          "Your clip",
        )}
        catalog={catalog}
        onMerge={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Photo library or Files"), {
      target: { files: [new File([new Uint8Array(4)], "pic.png", { type: "image/png" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("This setting takes a clip");
  });
});
