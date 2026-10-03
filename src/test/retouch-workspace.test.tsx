import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaCatalog, StudioArtifact } from "../lib/studio/types";

const bridge = vi.hoisted(() => ({
  upscale: vi.fn(),
  save: vi.fn(),
  artifacts: [] as StudioArtifact[],
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: bridge.invoke,
  convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    bridge.listeners.set(event, handler);
    return () => bridge.listeners.delete(event);
  }),
}));
vi.mock("../lib/studio/artifacts", () => ({
  artifactSrc: (artifact: StudioArtifact) => `asset://${artifact.fileName}`,
  listArtifacts: vi.fn(async () => bridge.artifacts),
  readArtifactBase64: vi.fn(async () => "AAAA"),
  saveArtifactFromBase64: bridge.save,
  registerDownloadedArtifactDurably: vi.fn(),
  exportArtifact: vi.fn(),
}));
vi.mock("../lib/artifact-media", () => ({
  artifactDataUrl: vi.fn(async () => "data:image/png;base64,AAAA"),
  useArtifactDataUrl: () => null,
  useArtifactPreview: () => null,
}));
// No image decoding in jsdom: the canvas side is exercised in the lab and on
// device, its arithmetic in retouch-zone.test.ts.
vi.mock("../lib/studio/edit-image", () => ({
  upscaleImage: bridge.upscale,
}));
vi.mock("../lib/studio/retouch/canvas-io", () => ({
  prepareSource: vi.fn(async (uri: string) => uri),
  prepareForUpscale: vi.fn(async (uri: string) => uri),
  cropForSending: vi.fn(async () => "data:image/png;base64,CROP"),
  naturalSize: vi.fn(async () => ({ width: 1248, height: 832 })),
  rasterizeZone: vi.fn(() => "MASK"),
}));

import { RetouchWorkspace } from "../components/studio/retouch/RetouchWorkspace";
import { RETOUCH_VERSION_EVENT } from "../lib/studio/retouch/jobs";

const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [
    {
      id: "ideogram-v4-5-edit",
      name: "Ideogram V4.5 Edit",
      mediaType: "imageEdit",
      privacy: "anonymized",
      offline: false,
      costCredits: 10.76,
      constraints: {
        aspectRatios: ["auto", "1:1", "3:2", "16:9"],
        combineImages: true,
        maxInputImages: 5,
        resolutions: ["1K", "2K"],
        defaultResolution: "1K",
        qualities: ["low", "medium", "high"],
        defaultQuality: "high",
      },
    },
  ],
};

function image(id: string, extra: Partial<StudioArtifact> = {}): StudioArtifact {
  return {
    id,
    kind: "image",
    path: `/gallery/${id}`,
    fileName: id,
    bytes: 1,
    model: "ideogram-v4-5-edit",
    prompt: "",
    createdAt: 1,
    ...extra,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  bridge.listeners.clear();
  bridge.artifacts = [
    image("root.png", { prompt: "A living room", createdAt: 1 }),
    image("v1.png", {
      prompt: "Paint the wall green.",
      createdAt: 2,
      edit: { of: "root.png", root: "root.png", op: "prompt", n: 1, elapsedMs: 44700 },
    }),
  ];
  bridge.invoke.mockReset().mockImplementation(async (command: string, args: unknown) => {
    if (command === "media_job_list") return [];
    if (command === "mobile_dictation_stop") return { text: "Add a lamp", rawText: "add a lamp" };
    if (command === "media_job_queue") {
      const request = (args as { request: Record<string, unknown> }).request;
      return {
        id: request.jobId,
        kind: "image",
        model: request.model,
        prompt: request.prompt,
        extension: "png",
        status: "queued",
        source: request.source,
        clientContext: request.clientContext,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    return undefined;
  });
});

async function open(cursor?: string) {
  if (cursor)
    window.localStorage.setItem(
      "os-june:retouch-sessions",
      JSON.stringify({ "root.png": { cursor, at: 1 } }),
    );
  render(
    <RetouchWorkspace catalog={catalog} rootId="root.png" layout="desktop" onClose={vi.fn()} />,
  );
  await screen.findByRole("heading", { level: 2 });
}

describe("the retouch workspace", () => {
  it("opens where the session was left, with what it took", async () => {
    await open("v1.png");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Retouch 1");
    expect(screen.getByText(/Paint the wall green\. · 44\.7 s/)).toBeTruthy();
    expect(screen.getByText(/10\.8 credits/)).toBeTruthy();
  });

  it("sends an instruction as a durable multi-edit job carrying its lineage", async () => {
    await open("v1.png");
    const field = screen.getByRole("textbox", { name: "Retouch instruction" });
    fireEvent.change(field, { target: { value: "Add a lamp" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith("media_job_queue", expect.anything()),
    );
    const call = bridge.invoke.mock.calls.find(([command]) => command === "media_job_queue");
    if (!call) throw new Error("not queued");
    const request = (call[1] as { request: Record<string, unknown> }).request;
    expect(request).toMatchObject({
      queuePath: "/image/multi-edit/queue",
      source: "retouch:root.png",
      queueBody: {
        model: "ideogram-v4-5-edit",
        prompt: "Add a lamp",
        images: ["data:image/png;base64,AAAA"],
      },
      clientContext: { v: 1, edit: { of: "v1.png", root: "root.png", op: "prompt", n: 2 } },
    });
    // The field is ready for the next instruction.
    expect((field as HTMLTextAreaElement).value).toBe("");
  });

  it("queues what is typed while the version on screen renders, without paying for it", async () => {
    await open("v1.png");
    const field = screen.getByRole("textbox", { name: "Retouch instruction" });
    fireEvent.change(field, { target: { value: "Add a lamp" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/it will follow this one/)).toBeTruthy(),
    );
    fireEvent.change(field, { target: { value: "Warmer light" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(screen.getByText("Next: Warmer light")).toBeTruthy();
    const queued = bridge.invoke.mock.calls.filter(([command]) => command === "media_job_queue");
    expect(queued).toHaveLength(1);
  });

  it("moves between versions with the keyboard, for free", async () => {
    await open("v1.png");
    act(() => {
      fireEvent.keyDown(window, { key: "z", metaKey: true });
    });
    // Whichever modifier this platform uses, one of them reads as undo.
    if (screen.getByRole("heading", { level: 2 }).textContent !== "Original") {
      act(() => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      });
    }
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Original");
    expect(bridge.invoke).not.toHaveBeenCalledWith("media_job_queue", expect.anything());
  });

  it("does not take undo away from a field being typed in", async () => {
    await open("v1.png");
    const field = screen.getByRole("textbox", { name: "Retouch instruction" });
    act(() => {
      fireEvent.keyDown(field, { key: "z", metaKey: true });
      fireEvent.keyDown(field, { key: "z", ctrlKey: true });
    });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Retouch 1");
  });

  it("says so when its image has left the gallery", async () => {
    bridge.artifacts = [];
    render(
      <RetouchWorkspace catalog={catalog} rootId="root.png" layout="desktop" onClose={vi.fn()} />,
    );
    expect(await screen.findByText("This image is no longer in the gallery.")).toBeTruthy();
  });

  function queued() {
    return bridge.invoke.mock.calls
      .filter(([command]) => command === "media_job_queue")
      .map(([, args]) => (args as { request: Record<string, unknown> }).request);
  }

  async function type(text: string) {
    const field = screen.getByRole("textbox", { name: "Retouch instruction" });
    fireEvent.change(field, { target: { value: text } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
  }

  /** What recovery does when a job lands: the version joins the gallery and
   * the session hears about it. */
  async function land(request: Record<string, unknown>, id: string, createdAt: number) {
    const context = request.clientContext as { edit: Record<string, unknown> };
    bridge.artifacts = [
      ...bridge.artifacts,
      image(id, { createdAt, prompt: String(request.prompt), edit: context.edit as never }),
    ];
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(RETOUCH_VERSION_EVENT, {
          detail: {
            rootId: "root.png",
            artifactId: id,
            parentId: context.edit.of,
            jobId: request.jobId,
          },
        }),
      );
    });
  }

  it("sends the waiting instructions one at a time, each on the version before it", async () => {
    await open("v1.png");
    await type("Add a lamp");
    await waitFor(() => expect(queued()).toHaveLength(1));
    await type("Warmer light");
    await type("Add a plant");
    // Nothing more is paid for while the version on screen renders.
    expect(queued()).toHaveLength(1);
    // The wait is the stage's veil over the picture, named in retouch words.
    const veil = document.querySelector(".stage-veil");
    expect(veil).toBeTruthy();
    expect(veil?.textContent).toMatch(/Submitting|Queued|Retouching/);
    await land(queued()[0], "v2.png", 3);
    await waitFor(() => expect(queued()).toHaveLength(2));
    expect(queued()[1]).toMatchObject({
      prompt: "Warmer light",
      clientContext: { edit: { of: "v2.png", n: 3 } },
    });
    // The third waits for the second, even while the second loads.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queued()).toHaveLength(2);
    expect(screen.getByText("Next: Add a plant")).toBeTruthy();
  });

  it("sends tries in parallel and offers them on a sheet to continue from", async () => {
    await open("v1.png");
    fireEvent.click(screen.getByRole("button", { name: "x2" }));
    expect(screen.getByText(/21\.5 credits/)).toBeTruthy();
    await type("Add a lamp");
    await waitFor(() => expect(queued()).toHaveLength(2));
    const [first, second] = queued();
    const group = (first.clientContext as { edit: { variant: { group: string } } }).edit.variant
      .group;
    expect(second.clientContext).toMatchObject({
      edit: { op: "variant", n: 3, variant: { group, index: 1, of: 2 } },
    });
    await land(first, "try-a.png", 3);
    await land(second, "try-b.png", 4);
    expect(await screen.findByText("Pick a try to continue from")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue from Retouch 3" }));
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Retouch 3");
  });

  it("extends to a format as a version of its own", async () => {
    await open("v1.png");
    fireEvent.click(screen.getByRole("button", { name: "Finishes" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Extend to 16:9" }));
    });
    await waitFor(() => expect(queued()).toHaveLength(1));
    expect(queued()[0]).toMatchObject({
      queueBody: { aspect_ratio: "16:9" },
      clientContext: { edit: { op: "extend", of: "v1.png", n: 2 } },
    });
  });

  it("closes the finishes menu like a menu", async () => {
    await open("v1.png");
    fireEvent.click(screen.getByRole("button", { name: "Finishes" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Finishes" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("upscales into a version that remembers its scale", async () => {
    bridge.upscale.mockResolvedValue("BIG");
    bridge.save.mockImplementation(async (_b64: string, _ext: string, metadata: unknown) => {
      const version = image("big.png", { ...(metadata as Partial<StudioArtifact>), createdAt: 3 });
      bridge.artifacts = [...bridge.artifacts, version];
      return version;
    });
    await open("v1.png");
    fireEvent.click(screen.getByRole("button", { name: "Finishes" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Upscale x2" }));
    });
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    expect(bridge.upscale).toHaveBeenCalledWith("AAAA", 2);
    expect(bridge.save.mock.calls[0][2]).toMatchObject({
      model: "upscaler",
      edit: { op: "upscale", of: "v1.png", n: 2, settings: { scale: 2 } },
    });
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Retouch 2"),
    );
  });

  it("fills the field from a quick retouch, and opens the zone when one needs it", async () => {
    await open("v1.png");
    fireEvent.click(screen.getByRole("button", { name: "Change the text" }));
    const field = screen.getByRole("textbox", {
      name: "Retouch instruction",
    }) as HTMLTextAreaElement;
    expect(field.value).toBe("Replace the text in the image with “…”");
    expect(screen.queryByRole("toolbar", { name: "Zone tools" })).toBeNull();
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove something" }));
    expect(field.value).toMatch(/^Remove what is painted/);
    expect(screen.getByRole("toolbar", { name: "Zone tools" })).toBeTruthy();
  });

  it("undoes the last stroke of a zone", async () => {
    await open("v1.png");
    fireEvent.click(screen.getByRole("button", { name: "Retouch a zone only" }));
    expect(screen.getByRole("button", { name: "Undo the last stroke" })).toBeDisabled();
  });

  describe("on a phone", () => {
    async function openPhone() {
      window.localStorage.setItem(
        "os-june:retouch-sessions",
        JSON.stringify({ "root.png": { cursor: "v1.png", at: 1 } }),
      );
      render(
        <RetouchWorkspace catalog={catalog} rootId="root.png" layout="phone" onClose={vi.fn()} />,
      );
      await screen.findByRole("heading", { level: 2 });
    }

    it("takes the instruction by voice", async () => {
      await openPhone();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
      });
      expect(bridge.invoke).toHaveBeenCalledWith("mobile_dictation_start");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
      });
      const field = screen.getByRole("textbox", {
        name: "Retouch instruction",
      }) as HTMLTextAreaElement;
      expect(field.value).toBe("Add a lamp");
    });

    it("keeps the version in Photos and shares it as a file", async () => {
      await openPhone();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Save to Photos" }));
      });
      expect(bridge.invoke).toHaveBeenCalledWith("save_to_photos", {
        request: { path: "/gallery/v1.png", kind: "image" },
      });
      expect(screen.getByText("Saved to Photos.")).toBeTruthy();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Share" }));
      });
      expect(bridge.invoke).toHaveBeenCalledWith("share_file", {
        request: { path: "/gallery/v1.png" },
      });
    });

    it("keeps the model and the tries in the settings, out of the thumb's way", async () => {
      await openPhone();
      expect(screen.queryByRole("button", { name: "x2" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Retouch settings" }));
      const panel = screen.getByRole("dialog", { name: "Retouch settings" });
      expect(panel.textContent).toContain("Model");
      fireEvent.click(screen.getByRole("button", { name: "x2" }));
      expect(screen.getByText(/21\.5 credits/)).toBeTruthy();
    });
  });
});
