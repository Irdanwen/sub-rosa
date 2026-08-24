import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AssembleStudio } from "../components/studio/AssembleStudio";
import { chainCuts } from "../lib/studio/chain";
import type { MediaCatalog, StudioArtifact } from "../lib/studio/types";

function shot(id: string, overrides: Partial<StudioArtifact> = {}): StudioArtifact {
  return {
    id,
    kind: "video",
    path: `/gallery/${id}`,
    fileName: id,
    bytes: 1000,
    model: "seedance",
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
  mediaJson: vi.fn(),
  extractFrameAt: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: hoisted.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("../lib/studio/client", () => ({
  mediaJson: hoisted.mediaJson,
  mediaBinary: vi.fn(),
}));
vi.mock("../lib/studio/frames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/frames")>()),
  extractFrameAt: hoisted.extractFrameAt,
}));
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  artifactSrc: (artifact: { path: string }) => `asset://${artifact.path}`,
  listArtifacts: hoisted.list,
  deleteArtifact: vi.fn(),
  exportArtifact: vi.fn(),
  saveArtifactFromBase64: vi.fn(),
}));

const mediaProto = window.HTMLMediaElement.prototype;
Object.defineProperty(mediaProto, "src", {
  configurable: true,
  get: () => "",
  set(this: HTMLMediaElement) {
    setTimeout(() => this.dispatchEvent(new Event("loadedmetadata")), 0);
  },
});
Object.defineProperty(mediaProto, "duration", { configurable: true, get: () => 12 });
afterAll(() => {
  for (const key of ["src", "duration"]) Reflect.deleteProperty(mediaProto, key);
});

const catalog = {
  backend: "carpe-diem",
  models: [{ id: "kimi-k3", mediaType: "text", name: "Kimi", supportsVision: true }],
} as unknown as MediaCatalog;

beforeEach(() => {
  hoisted.list.mockReset().mockResolvedValue([]);
  hoisted.invoke.mockReset().mockResolvedValue(undefined);
  hoisted.mediaJson.mockReset();
  hoisted.extractFrameAt
    .mockReset()
    .mockResolvedValue({ dataUrl: "data:image/jpeg;base64,AA", timeSeconds: 1 });
});

describe("reviewing the cut", () => {
  it("shows one frame per shot to a judge, and reports what is weak", async () => {
    // A contact sheet, not the film: it is what a supervisor actually looks
    // at, it costs a fraction of a video call, and the picture is what drifts.
    hoisted.mediaJson.mockResolvedValue({
      choices: [
        {
          message: {
            content:
              '{"score": 5, "summary": "The middle sags.", "weakest": [{"label": "Shot 2", "why": "the coat reads blue"}]}',
          },
        },
      ],
    });
    render(<AssembleStudio pendingCuts={chainCuts([A, B])} catalog={catalog} />);
    const button = await screen.findByRole("button", { name: "Review the cut" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    await waitFor(() => expect(hoisted.mediaJson).toHaveBeenCalledTimes(1));
    expect(hoisted.extractFrameAt).toHaveBeenCalledTimes(2);
    const [path, body] = hoisted.mediaJson.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/chat/completions");
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[1].content.filter((part) => part.type === "image_url").length).toBe(2);

    expect(await screen.findByText(/5\/10 The middle sags\./)).toBeInTheDocument();
    expect(screen.getByText("Shot 2")).toBeInTheDocument();
    expect(screen.getByText(/the coat reads blue/)).toBeInTheDocument();
  });

  it("reviews the shots whose frames decode, and skips the one that will not", async () => {
    hoisted.extractFrameAt
      .mockRejectedValueOnce(new Error("no picture"))
      .mockResolvedValue({ dataUrl: "data:image/jpeg;base64,AA", timeSeconds: 1 });
    hoisted.mediaJson.mockResolvedValue({
      choices: [{ message: { content: '{"score": 9, "summary": "Fine."}' } }],
    });
    render(<AssembleStudio pendingCuts={chainCuts([A, B])} catalog={catalog} />);
    const button = await screen.findByRole("button", { name: "Review the cut" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    await waitFor(() => expect(hoisted.mediaJson).toHaveBeenCalledTimes(1));
    const [, body] = hoisted.mediaJson.mock.calls[0] as [string, Record<string, unknown>];
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[1].content.filter((part) => part.type === "image_url").length).toBe(1);
  });

  it("says it has nothing to say rather than failing", async () => {
    // A quality tool that can stop a paid production from finishing is a
    // liability, so every failure is "no opinion".
    hoisted.mediaJson.mockRejectedValue(new Error("502"));
    render(<AssembleStudio pendingCuts={chainCuts([A, B])} catalog={catalog} />);
    const button = await screen.findByRole("button", { name: "Review the cut" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByText(/nothing to say/)).toBeInTheDocument();
    expect(screen.queryByText(/\/10/)).not.toBeInTheDocument();
  });

  it("says so when no model on the account can look at pictures", async () => {
    // A text model that cannot read images is not a judge: handing it pictures
    // costs a call and returns a confident opinion about nothing.
    render(
      <AssembleStudio
        pendingCuts={chainCuts([A, B])}
        catalog={
          {
            backend: "carpe-diem",
            models: [{ id: "blind", name: "Blind", mediaType: "text", offline: false }],
          } as unknown as MediaCatalog
        }
      />,
    );
    const button = await screen.findByRole("button", { name: "Review the cut" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByText(/No model on this account/)).toBeInTheDocument();
    expect(hoisted.mediaJson).not.toHaveBeenCalled();
  });
});

describe("reopening a finished production", () => {
  it("brings back its shots and its sound, so it can be finished properly", async () => {
    // A run hands back one flattened film: fine to watch, and the end of the
    // line if the user wants to grade it or move a line half a second.
    hoisted.list.mockResolvedValue([
      shot("a.mp4"),
      shot("b.mp4"),
      {
        id: "line.mp3",
        kind: "speech",
        path: "/gallery/line.mp3",
        fileName: "line.mp3",
        bytes: 5,
        model: "tts",
        prompt: "Get in.",
        createdAt: 3,
      },
    ]);
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "workflow_run_list") {
        return [
          {
            id: "run-1",
            workflowId: "w",
            name: "Neon alley",
            status: "completed",
            definition: JSON.stringify({
              nodes: [
                { id: "s1", type: "video", params: {} },
                { id: "s2", type: "video", params: {} },
                { id: "l1", type: "tts", params: {} },
                { id: "assemble", type: "assemble", params: {} },
              ],
              edges: [
                { id: "e1", source: "s1", target: "assemble", targetPort: "clips" },
                { id: "e2", source: "s2", target: "assemble", targetPort: "clips" },
                { id: "e3", source: "l1", target: "assemble", targetPort: "dialogue" },
              ],
            }),
            createdAt: "",
            updatedAt: "",
          },
        ];
      }
      if (command === "workflow_run_get") {
        return {
          run: {
            id: "run-1",
            name: "Neon alley",
            status: "completed",
            definition: JSON.stringify({
              nodes: [
                { id: "s1", type: "video", params: {} },
                { id: "s2", type: "video", params: {} },
                { id: "l1", type: "tts", params: {} },
                { id: "assemble", type: "assemble", params: {} },
              ],
              edges: [
                { id: "e1", source: "s1", target: "assemble", targetPort: "clips" },
                { id: "e2", source: "s2", target: "assemble", targetPort: "clips" },
                { id: "e3", source: "l1", target: "assemble", targetPort: "dialogue" },
              ],
            }),
          },
          nodes: [
            {
              nodeId: "s1",
              status: "done",
              output: JSON.stringify({
                kind: "video",
                artifactId: "a.mp4",
                parentHandoffSeconds: 4.5,
              }),
            },
            {
              nodeId: "s2",
              status: "done",
              output: JSON.stringify({ kind: "video", artifactId: "b.mp4" }),
            },
            {
              nodeId: "l1",
              status: "done",
              output: JSON.stringify({
                kind: "audio",
                artifactId: "line.mp3",
                mimeType: "audio/mpeg",
                atSeconds: 2.4,
              }),
            },
          ],
        };
      }
      return null;
    });

    render(<AssembleStudio catalog={catalog} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open a production" }));
    fireEvent.click(await screen.findByRole("option", { name: "Neon alley" }));

    // Both shots, in order, the first trimmed where its continuation took over.
    await waitFor(() => expect(screen.getByText("1. prompt for a.mp4")).toBeInTheDocument());
    expect(screen.getByText("2. prompt for b.mp4")).toBeInTheDocument();
    expect((screen.getByLabelText("Clip 1 end seconds") as HTMLInputElement).value).toBe("4.5");
    // And the line, on its lane, at the moment the production put it.
    expect((screen.getByLabelText("Sound 1 start seconds") as HTMLInputElement).value).toBe("2.4");
    expect((screen.getByLabelText("Film name") as HTMLInputElement).value).toBe("Neon alley");
  });

  it("says so when a production's files have been deleted since", async () => {
    hoisted.list.mockResolvedValue([]);
    hoisted.invoke.mockImplementation(async (command: string) => {
      if (command === "workflow_run_list") {
        return [
          {
            id: "run-1",
            workflowId: "w",
            name: "Gone",
            status: "completed",
            definition: JSON.stringify({
              nodes: [
                { id: "s1", type: "video", params: {} },
                { id: "assemble", type: "assemble", params: {} },
              ],
              edges: [{ id: "e1", source: "s1", target: "assemble", targetPort: "clips" }],
            }),
            createdAt: "",
            updatedAt: "",
          },
        ];
      }
      if (command === "workflow_run_get") {
        return {
          run: {
            id: "run-1",
            name: "Gone",
            status: "completed",
            definition: JSON.stringify({
              nodes: [
                { id: "s1", type: "video", params: {} },
                { id: "assemble", type: "assemble", params: {} },
              ],
              edges: [{ id: "e1", source: "s1", target: "assemble", targetPort: "clips" }],
            }),
          },
          nodes: [
            {
              nodeId: "s1",
              status: "done",
              output: JSON.stringify({ kind: "video", artifactId: "vanished.mp4" }),
            },
          ],
        };
      }
      return null;
    });
    render(<AssembleStudio catalog={catalog} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open a production" }));
    fireEvent.click(await screen.findByRole("option", { name: "Gone" }));
    expect(await screen.findByText(/still in your gallery/)).toBeInTheDocument();
  });
});
