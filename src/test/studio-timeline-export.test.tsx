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

/** The bundle write, found by name: other commands share this mock. */
function bundleCall() {
  const call = hoisted.invoke.mock.calls.find(([command]) => command === "export_timeline_bundle");
  return call?.[1] as { request: Record<string, unknown> } | undefined;
}

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

    await waitFor(() => expect(bundleCall()).toBeDefined());
    const payload = bundleCall() as { request: Record<string, unknown> };
    // No destination crosses IPC: Rust opens the folder picker, so the request
    // carries what to write and never where.
    expect(payload.request).not.toHaveProperty("directory");
    expect(payload.request).toMatchObject({
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

  it("states a sound's real length, not the film's, and lands it on its lane", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: /Add a sound/ }));
    fireEvent.click(await screen.findByRole("option", { name: "a score" }));

    const button = screen.getByRole("button", { name: "Export timeline" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(bundleCall()).toBeDefined());
    const payload = bundleCall() as { request: Record<string, unknown> };
    const doc = String(payload.request.document);
    // The stubbed media is 12 s long; the cut runs 21.5 s. The asset states 12.
    expect(doc).toContain('name="a score"');
    expect(doc).toMatch(/<asset [^>]*name="a score"[^>]*duration="360\/30s"/);
    expect(payload.request.media).toContain("/gallery/score.mp3");
  });

  it("puts a generated line on the dialogue lane, with its own subtitle", async () => {
    hoisted.list.mockResolvedValue([
      {
        id: "line.mp3",
        kind: "speech",
        path: "/gallery/line.mp3",
        fileName: "line.mp3",
        bytes: 10,
        model: "tts",
        prompt: "Get in the car.",
        createdAt: 3,
      },
    ]);
    render(<AssembleStudio pendingCuts={chainCuts([A, B])} />);
    await waitFor(() => expect(screen.getByText("1. prompt for a.mp4")).toBeInTheDocument());
    fireEvent.click(await screen.findByRole("button", { name: /Add a sound/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Get in the car." }));

    const button = screen.getByRole("button", { name: "Export timeline" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(bundleCall()).toBeDefined());
    const payload = bundleCall() as { request: Record<string, unknown> };
    const doc = String(payload.request.document);
    // A speech artifact lands on dialogue by what produced it, not by a
    // choice the user has to remember to make.
    expect(doc).toMatch(/lane="-1"[^>]*audioRole="dialogue"|audioRole="dialogue"/);
    expect(doc).toContain('lane="-1"');
    // And the prompt of a generated line is the line, so the subtitle is free.
    expect(String(payload.request.subtitles)).toContain("Get in the car.");
    expect(String(payload.request.subtitles)).toContain("00:00:00,000 --> 00:00:12,000");
  });

  it("lands a second line after the first instead of on top of it", async () => {
    hoisted.list.mockResolvedValue([
      {
        id: "one.mp3",
        kind: "speech",
        path: "/gallery/one.mp3",
        fileName: "one.mp3",
        bytes: 10,
        model: "tts",
        prompt: "Get in.",
        createdAt: 3,
      },
      {
        id: "two.mp3",
        kind: "speech",
        path: "/gallery/two.mp3",
        fileName: "two.mp3",
        bytes: 10,
        model: "tts",
        prompt: "Drive.",
        createdAt: 4,
      },
    ]);
    render(<AssembleStudio pendingCuts={chainCuts([A, B])} />);
    await waitFor(() => expect(screen.getByText("1. prompt for a.mp4")).toBeInTheDocument());

    fireEvent.click(await screen.findByRole("button", { name: /Add a sound/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Get in." }));
    await waitFor(() =>
      expect((screen.getByLabelText("Sound 1 start seconds") as HTMLInputElement).value).toBe("0"),
    );

    fireEvent.click(screen.getByRole("button", { name: /Add a sound/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Drive." }));

    // Two voices talking over each other is never what was meant. The stubbed
    // lines are 12 s long, and the gap is a quarter of a second.
    await waitFor(() =>
      expect((screen.getByLabelText("Sound 2 start seconds") as HTMLInputElement).value).toBe(
        "12.25",
      ),
    );
  });

  it("says nothing was written when the user closes the folder picker", async () => {
    // The picker lives in Rust now, so a cancel comes back as a reply rather
    // than as a dialog the webview never opened.
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "export_timeline_bundle") {
        return { directory: "", documentPath: "", mediaCount: 0, cancelled: true };
      }
      return undefined;
    });
    render(<AssembleStudio pendingCuts={chainCuts([A, B])} />);
    const button = await screen.findByRole("button", { name: "Export timeline" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    await waitFor(() => expect(bundleCall()).toBeDefined());
    // A cancelled export leaves no "wrote ..." notice behind.
    await waitFor(() => expect(screen.queryByText(/^Wrote /)).toBeNull());
  });

  it("offers no timeline until there is something to put in it", async () => {
    render(<AssembleStudio />);
    await waitFor(() => expect(hoisted.list).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Export timeline" })).toBeDisabled();
  });
});
