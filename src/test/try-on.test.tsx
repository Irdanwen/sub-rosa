import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, composeImages } = vi.hoisted(() => ({
  invoke: vi.fn(),
  composeImages: vi.fn(async () => "aGk="),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (value: string) => value }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../lib/studio/edit-image", () => ({ composeImages, MAX_COMPOSE_IMAGES: 3 }));
// jsdom has no canvas: a picked photo is taken as it is.
vi.mock("../lib/studio/downscale", () => ({
  prepareEditReference: async (dataUrl: string) => dataUrl,
}));

import { ChatBlockView } from "../components/chat-blocks/ChatBlockView";
import { chatBlocksToClipboardText, parseChatBlock } from "../lib/chat-blocks";
import { resetMediaCatalogCache } from "../lib/studio/catalog";
import { tryOnModel, tryOnPrompt } from "../lib/studio/try-on";
import type { MediaCatalog, MediaModel } from "../lib/studio/types";
import { templateWorkflows } from "../lib/studio/workflow";

function edit(id: string, extra: Partial<MediaModel> = {}): MediaModel {
  return { id, name: id, mediaType: "imageEdit", offline: false, ...extra } as MediaModel;
}

function catalog(models: MediaModel[]): MediaCatalog {
  return { backend: "venice", models } as MediaCatalog;
}

beforeEach(() => {
  invoke.mockReset();
  composeImages.mockClear();
  resetMediaCatalogCache();
  localStorage.clear();
});

describe("the try-on prompt and model", () => {
  it("keeps the person and the room, and names the garment when it is known", () => {
    const prompt = tryOnPrompt("  a navy   linen blazer ");
    expect(prompt).toContain("Image 1 is the person. Image 2 is the garment.");
    expect(prompt).toContain("(a navy linen blazer)");
    expect(prompt).toContain("the same face, identity");
    expect(prompt).toContain("Keep the background");
    expect(tryOnPrompt()).not.toContain("(");
  });

  it("picks a preferred edit model that takes two photos", () => {
    const single = edit("nano-banana-2-edit", { constraints: { combineImages: false } });
    const pair = edit("seedream-v4-edit");
    expect(tryOnModel(catalog([single, pair, edit("zzz-edit")]))?.id).toBe("seedream-v4-edit");
    expect(tryOnModel(catalog([edit("zzz-edit")]))?.id).toBe("zzz-edit");
    expect(tryOnModel(catalog([single]))).toBeUndefined();
  });

  it("ships a Studio template wiring the person first and the garment second", () => {
    const template = templateWorkflows().find((entry) => entry.id === "template-try-it-on");
    expect(template?.name).toBe("Try it on");
    const fitting = template?.nodes.find((node) => node.type === "imageEdit");
    expect(fitting?.params.prompt).toBe(tryOnPrompt());
    expect(
      template?.edges.filter(
        (entry) => entry.target === fitting?.id && entry.targetPort === "images",
      ),
    ).toEqual([
      expect.objectContaining({ source: "person" }),
      expect.objectContaining({ source: "garment" }),
    ]);
  });
});

describe("the try-on chat block", () => {
  it("parses a proposal that carries no photo and no price", () => {
    expect(
      parseChatBlock(
        "subrosa:tryon",
        JSON.stringify({ v: 1, title: "Try it on", garment: "red dress", price: 0, image: "x" }),
      ),
    ).toEqual({ kind: "tryon", title: "Try it on", garment: "red dress" });
    expect(parseChatBlock("subrosa:tryon", JSON.stringify({ v: 2 }))).toBeNull();
    expect(chatBlocksToClipboardText('```subrosa:tryon\n{"v":1,"garment":"red dress"}\n```')).toBe(
      "Try it on\n- red dress",
    );
  });

  it("runs only once both photos are picked, and files the result as a chat picture", async () => {
    invoke.mockImplementation(async (command: string, args?: { request?: unknown }) => {
      if (command === "carpe_diem_media_catalog")
        return { backend: "venice", models: [edit("seedream-v4-edit", { costCredits: 3 })] };
      if (command === "carpe_diem_media_save_artifact")
        return { path: "/gallery/out.png", fileName: "out.png", bytes: 3 };
      if (command === "carpe_diem_media_read_artifact") return "aGk=";
      if (command === "studio_artifact_save") return args?.request;
      return undefined;
    });
    render(<ChatBlockView block={{ kind: "tryon", garment: "red dress" }} />);
    const run = await screen.findByRole("button", { name: "Try it on" });
    expect(screen.getByText(/Estimated price: 3.0 credits/)).toBeTruthy();
    expect((run as HTMLButtonElement).disabled).toBe(true);

    const pick = (label: string, name: string) =>
      fireEvent.change(screen.getByLabelText(label), {
        target: { files: [new File(["x"], name, { type: "image/png" })] },
      });
    pick("Choose your photo", "me.png");
    await waitFor(() => expect(screen.getByAltText("Your photo")).toBeTruthy());
    expect((run as HTMLButtonElement).disabled).toBe(true);
    pick("Choose the garment", "dress.png");
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(run);
    await screen.findByAltText("You, wearing the garment");
    expect(composeImages).toHaveBeenCalledTimes(1);
    const [model, prompt, images] = composeImages.mock.calls[0] as unknown as [
      string,
      string,
      string[],
    ];
    expect(model).toBe("seedream-v4-edit");
    expect(prompt).toContain("(red dress)");
    expect(images).toHaveLength(2);
    expect(images[0]).toMatch(/^data:image\/png;base64,/);
    expect(invoke).toHaveBeenCalledWith("studio_artifact_save", {
      request: expect.objectContaining({
        id: "out.png",
        generation: expect.objectContaining({ origin: { surface: "chat" }, costCredits: 3 }),
      }),
    });
  });
});
