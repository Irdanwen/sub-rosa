// The phone's app form (ADR-0119): each kind of setting drawn with the
// phone's own control, and a run that asks before spending, says when the
// phone must stay open, and continues from a gate with the chosen take.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppField } from "../components/mobile/screens/studio/AppField";
import type { ShownField } from "../lib/studio/workflow/app";
import type { ParamSchema, Workflow, WorkflowNode } from "../lib/studio/workflow/schema";

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

  it("picks a picture from the gallery, and a track from its list", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: "Choose a picture" }));
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
    fireEvent.click(await screen.findByRole("button", { name: /^Your track/ }));
    const list = await screen.findByRole("dialog", { name: "Your track" });
    fireEvent.click(within(list).getByRole("button", { name: "theme.mp3" }));
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ artifactId: "theme.mp3" }));
  });
});

describe("running an app on the phone", () => {
  function film(): Workflow {
    return {
      id: "w",
      name: "Film",
      nodes: [
        {
          id: "a",
          type: "textInput",
          label: "Take A",
          position: { x: 0, y: 0 },
          params: { text: "A" },
        },
        {
          id: "b",
          type: "textInput",
          label: "Take B",
          position: { x: 0, y: 1 },
          params: { text: "B" },
        },
        {
          id: "g",
          type: "gate",
          label: "",
          position: { x: 1, y: 0 },
          params: { note: "Pick a take" },
        },
        {
          id: "p",
          type: "image",
          label: "Poster",
          position: { x: 2, y: 1 },
          params: { model: "big-image", prompt: "{{input}}" },
        },
        { id: "o", type: "output", label: "Out", position: { x: 3, y: 0 }, params: {} },
      ],
      edges: [
        { id: "1", source: "a", target: "g", targetPort: "in" },
        { id: "2", source: "b", target: "g", targetPort: "in" },
        { id: "3", source: "g", target: "o", targetPort: "in" },
        { id: "4", source: "a", target: "p", targetPort: "prompt" },
      ],
      app: { fields: [{ nodeId: "a", param: "text" }], outputs: ["o"] },
      createdAt: 1,
      updatedAt: 1,
    };
  }

  it("asks before spending past the threshold, and offers a held gate's takes", async () => {
    const { AppRunScreen } = await import("../components/mobile/screens/studio/AppRunScreen");
    const priced = {
      ...catalog,
      models: [
        ...catalog.models,
        {
          id: "big-image",
          mediaType: "image" as const,
          name: "Big",
          offline: false,
          costCredits: 25,
        },
      ],
    };
    render(<AppRunScreen workflow={film()} catalog={priced} />);
    fireEvent.click(screen.getByRole("button", { name: /^Run, / }));
    const sheet = await screen.findByRole("dialog", { name: "Run this app?" });
    expect(within(sheet).getByText(/25/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Run" }));
    });
    await waitFor(() => expect(state.calls).toContain("workflow_run_create"));
    const gate = await screen.findByRole("region", { name: "Waiting for your approval" });
    expect(within(gate).getByText("Pick a take")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(gate).getByRole("button", { name: "Continue with Take B" }));
    });
    await waitFor(() =>
      expect(state.calls.filter((call) => call === "workflow_run_get").length).toBeGreaterThan(0),
    );
  });
});
