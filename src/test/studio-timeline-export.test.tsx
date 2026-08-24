import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AssembleStudio } from "../components/studio/AssembleStudio";
import { chainCuts } from "../lib/studio/chain";
import type { StudioArtifact } from "../lib/studio/types";

function shot(id: string, overrides: Partial<StudioArtifact> = {}): StudioArtifact {
  return {
    id,
    kind: "video",
    path: `/gallery/${id}`,
    fileName: id,
    bytes: 1000,
    model: "seedance-2-0-image-to-video",
    prompt: `prompt for ${id}`,
    createdAt: 1,
    ...overrides,
  };
}

const A = shot("a.mp4");
const B = shot("b.mp4", { createdAt: 2, parentId: "a.mp4", parentHandoffSeconds: 9.5 });

const hoisted = vi.hoisted(() => ({
  list: vi.fn(),
  invoke: vi.fn(),
  openDialog: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: hoisted.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: hoisted.openDialog }));
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  artifactSrc: (artifact: { path: string }) => `asset://${artifact.path}`,
  listArtifacts: hoisted.list,
  deleteArtifact: vi.fn(),
  exportArtifact: vi.fn(),
  saveArtifactFromBase64: vi.fn(),
}));

// jsdom loads no media, so the metadata probe would never resolve and every
// clip would look unmeasured. Fake just what `probeClip` reads: the src setter
// announces itself asynchronously, because the probe attaches its listener
// after assigning src.
const mediaProto = window.HTMLMediaElement.prototype;
const videoProto = window.HTMLVideoElement.prototype;
Object.defineProperty(mediaProto, "src", {
  configurable: true,
  get: () => "",
  set(this: HTMLMediaElement) {
    setTimeout(() => this.dispatchEvent(new Event("loadedmetadata")), 0);
  },
});
Object.defineProperty(mediaProto, "duration", { configurable: true, get: () => 12 });
Object.defineProperty(videoProto, "videoWidth", { configurable: true, get: () => 1280 });
Object.defineProperty(videoProto, "videoHeight", { configurable: true, get: () => 720 });

afterAll(() => {
  for (const key of ["src", "duration"]) Reflect.deleteProperty(mediaProto, key);
  for (const key of ["videoWidth", "videoHeight"]) Reflect.deleteProperty(videoProto, key);
});

beforeEach(() => {
  hoisted.list.mockReset().mockResolvedValue([]);
  hoisted.invoke.mockReset().mockResolvedValue({
    directory: "/out/Neon alley.timeline",
    documentPath: "/out/Neon alley.timeline/Neon alley.fcpxml",
    mediaCount: 2,
  });
  hoisted.openDialog.mockReset().mockResolvedValue("/out");
});

describe("exporting a chain as a timeline", () => {
  it("writes a bundle whose document carries the chain's own trims", async () => {
    render(<AssembleStudio pendingCuts={chainCuts([A, B])} />);
    await waitFor(() => expect(screen.getByText("1. prompt for a.mp4")).toBeInTheDocument());

    const button = await screen.findByRole("button", { name: "Export timeline" });
    await waitFor(() => expect(button).toBeEnabled());

    fireEvent.change(screen.getByLabelText("Film name"), { target: { value: "Neon alley" } });
    fireEvent.click(button);

    await waitFor(() => expect(hoisted.invoke).toHaveBeenCalledTimes(1));
    const [command, payload] = hoisted.invoke.mock.calls[0] as [
      string,
      { request: Record<string, unknown> },
    ];
    expect(command).toBe("export_timeline_bundle");
    expect(payload.request).toMatchObject({
      directory: "/out",
      name: "Neon alley",
      extension: "fcpxml",
      media: ["/gallery/a.mp4", "/gallery/b.mp4"],
    });

    const doc = String(payload.request.document);
    // The chain trims the first shot where the second took over: 9.5 s at
    // 30 fps is 285 frames, and the second shot starts there on the spine.
    expect(doc).toContain('duration="285/30s"');
    expect(doc).toContain('offset="285/30s"');
    // The measured frame size travels, rather than a hardcoded 1080p guess.
    expect(doc).toContain('width="1280"');
    expect(doc).toContain('height="720"');
    // Relative hrefs: Rust picks the final folder, so nothing absolute can be
    // written into the document.
    expect(doc).toContain('src="media/a.mp4"');
    expect(doc).not.toContain("/gallery/");

    expect(await screen.findByText(/Wrote \/out\/Neon alley.timeline/)).toBeInTheDocument();
  });

  it("states a music track's real length, not the film's", async () => {
    // A track shorter than the film must not be declared film-length: the NLE
    // would show a clip with a dead tail the editor has to find and trim.
    hoisted.list.mockImplementation(async (kind?: string) =>
      kind === "video"
        ? []
        : [
            {
              id: "score.mp3",
              kind: "music",
              path: "/gallery/score.mp3",
              fileName: "score.mp3",
              bytes: 10,
              model: "lyria",
              prompt: "a score",
              createdAt: 3,
            },
          ],
    );
    render(<AssembleStudio pendingCuts={chainCuts([A, B])} />);
    await waitFor(() => expect(screen.getByText("1. prompt for a.mp4")).toBeInTheDocument());
    // The Select is a trigger plus a listbox popover, not a native <select>.
    fireEvent.click(await screen.findByRole("button", { name: /Audio track/ }));
    fireEvent.click(await screen.findByRole("option", { name: "a score" }));

    const button = screen.getByRole("button", { name: "Export timeline" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(hoisted.invoke).toHaveBeenCalledTimes(1));

    const [, payload] = hoisted.invoke.mock.calls[0] as [
      string,
      { request: Record<string, unknown> },
    ];
    const doc = String(payload.request.document);
    // The stubbed media is 12 s long; the cut runs 21.5 s. The asset states 12.
    expect(doc).toContain('name="a score"');
    expect(doc).toMatch(/<asset [^>]*name="a score"[^>]*duration="360\/30s"/);
    expect(payload.request.media).toContain("/gallery/score.mp3");
  });

  it("writes nothing when the user closes the folder picker", async () => {
    hoisted.openDialog.mockResolvedValue(null);
    render(<AssembleStudio pendingCuts={chainCuts([A, B])} />);
    const button = await screen.findByRole("button", { name: "Export timeline" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(hoisted.openDialog).toHaveBeenCalled());
    expect(hoisted.invoke).not.toHaveBeenCalled();
  });

  it("offers no timeline until there is something to put in it", async () => {
    render(<AssembleStudio />);
    await waitFor(() => expect(hoisted.list).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Export timeline" })).toBeDisabled();
  });
});
