/**
 * The video and audio desks (ADR-0110): each opens on its scene and dock,
 * puts the chips that matter on every render in the dock, says why it cannot
 * send yet, queues what is asked, and shows a render in flight on the scene
 * and in the filmstrip, a failure as a notice.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MusicStudio } from "../components/studio/MusicStudio";
import { SoundFxStudio } from "../components/studio/SoundFxStudio";
import { SpeechStudio } from "../components/studio/SpeechStudio";
import { VideoStudio } from "../components/studio/VideoStudio";
import type { MediaCatalog } from "../lib/studio/types";

const jobs = vi.hoisted(() => ({
  queueStart: vi.fn(),
  queueStop: vi.fn(),
  queueJobs: [] as unknown[],
  singleStart: vi.fn(),
  singleCancel: vi.fn(),
  singleState: { phase: "idle" } as Record<string, unknown>,
  speech: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
  convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock("../lib/studio/async-job", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/async-job")>()),
  useMediaJobQueue: () => ({
    jobs: jobs.queueJobs,
    start: jobs.queueStart,
    stop: jobs.queueStop,
    dismiss: vi.fn(),
    retry: vi.fn(),
  }),
  useMediaJob: () => ({
    state: jobs.singleState,
    start: jobs.singleStart,
    cancel: jobs.singleCancel,
    reset: vi.fn(),
    retry: vi.fn(),
    canRetry: false,
  }),
}));
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  listArtifacts: vi.fn().mockResolvedValue([]),
  saveArtifactFromBase64: jobs.save,
}));
vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: vi.fn().mockRejectedValue(new Error("offline")),
  mediaGet: vi.fn().mockRejectedValue(new Error("offline")),
}));
vi.mock("../lib/studio/speech", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/speech")>()),
  generateSpeech: jobs.speech,
}));
vi.mock("../lib/studio/use-cloned-voices", () => ({
  useClonedVoices: () => ({ voices: [], options: [], reload: vi.fn() }),
}));

function catalog(): MediaCatalog {
  return {
    backend: "carpe-diem",
    priceMultiplier: 1,
    models: [
      {
        id: "wave-text-to-video",
        name: "Wave",
        mediaType: "video",
        offline: false,
        constraints: { durations: ["5s", "10s"], aspect_ratios: ["16:9", "9:16"] },
      },
      { id: "tune", name: "Tune", mediaType: "music", offline: false, costCredits: 2 },
      { id: "boom-sound-effects", name: "Boom", mediaType: "music", offline: false },
      { id: "voice", name: "Voice", mediaType: "tts", offline: false, voices: ["ava", "bob"] },
    ],
  } as MediaCatalog;
}

beforeEach(() => {
  localStorage.clear();
  jobs.queueStart.mockReset().mockResolvedValue(undefined);
  jobs.queueStop.mockReset();
  jobs.queueJobs = [];
  jobs.singleStart.mockReset().mockResolvedValue(undefined);
  jobs.singleCancel.mockReset();
  jobs.singleState = { phase: "idle" };
  jobs.speech.mockReset().mockResolvedValue({ base64: "AAAA" });
  jobs.save.mockReset().mockResolvedValue({ id: "n.mp3", path: "/g/n.mp3" });
});

describe("the video desk", () => {
  it("queues a shot from the dock, with its length and shape as chips", async () => {
    render(<VideoStudio catalog={catalog()} />);
    expect(screen.getByText("Describe a shot. It will play here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Video model, Wave" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Duration, 5s" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aspect ratio, 16:9" })).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Prompt" }),
      "A slow travelling shot over the sea",
    );
    await userEvent.click(screen.getByRole("button", { name: "Generate video" }));
    await waitFor(() => expect(jobs.queueStart).toHaveBeenCalledTimes(1));
    expect(jobs.queueStart.mock.calls[0][0]).toMatchObject({
      kind: "video",
      model: "wave-text-to-video",
      prompt: "A slow travelling shot over the sea",
    });
  });

  it("puts a render in flight on the scene, with a way to stop waiting", async () => {
    jobs.queueJobs = [
      {
        job: { id: "j1", model: "wave-text-to-video", prompt: "sea", kind: "video" },
        phase: "processing",
        elapsedMs: 4000,
        canRetry: false,
      },
      {
        job: { id: "j2", model: "wave-text-to-video", prompt: "storm", kind: "video" },
        phase: "failed",
        elapsedMs: 0,
        message: "Video generation failed",
        canRetry: false,
      },
    ];
    render(<VideoStudio catalog={catalog()} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Stop waiting" })[0]);
    expect(jobs.queueStop).toHaveBeenCalledWith("j1");
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  });
});

describe("the video desk's inputs", () => {
  it("shows an opening frame in the dock and on the scene, and lets it go", async () => {
    const { container } = render(<VideoStudio catalog={catalog()} />);
    const input = container.querySelector(
      'input[type="file"][accept^="image"]',
    ) as HTMLInputElement;
    const file = new File([new Uint8Array([137, 80, 78, 71])], "frame.png", { type: "image/png" });
    await userEvent.upload(input, file);
    const inputs = await screen.findByRole("list", { name: "Inputs" });
    expect(inputs.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByPlaceholderText("Describe the motion")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove the opening frame" }));
    expect(screen.queryByRole("list", { name: "Inputs" })).toBeNull();
  });
});

describe("the video desk's other directions", () => {
  function withMoreVideo(): MediaCatalog {
    const base = catalog();
    return {
      ...base,
      models: [
        ...base.models,
        {
          id: "wave-reference-to-video",
          name: "Wave",
          mediaType: "referenceToVideo",
          offline: false,
          constraints: { durations: ["5s"], aspect_ratios: ["16:9"] },
        },
        {
          id: "clipper-video-to-video",
          name: "Clipper",
          mediaType: "video",
          offline: false,
        },
      ],
    } as MediaCatalog;
  }

  it("switches to transforming a clip", async () => {
    render(<VideoStudio catalog={withMoreVideo()} />);
    await userEvent.click(screen.getByRole("tab", { name: "From video" }));
    expect(
      screen.getByText("Pick a clip to transform. The result will play here."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Video model, Clipper" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Describe how to restyle the clip")).toBeInTheDocument();
  });
});

describe("the audio desks", () => {
  it("queues a track from the music dock", async () => {
    render(<MusicStudio catalog={catalog()} tools={<p>modes</p>} />);
    expect(screen.getByText("modes")).toBeInTheDocument();
    expect(screen.getByText("Describe a track. It will play here.")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "Calm piano, 70 bpm");
    await userEvent.click(screen.getByRole("button", { name: "Generate music" }));
    expect(jobs.singleStart).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "music", prompt: "Calm piano, 70 bpm" }),
    );
  });

  it("shows a track being composed, and stops waiting on request", async () => {
    jobs.singleState = { phase: "processing", startedAt: Date.now() - 2000, elapsedMs: 2000 };
    render(<MusicStudio catalog={catalog()} />);
    await userEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    expect(jobs.singleCancel).toHaveBeenCalled();
  });

  it("reports a failed track as a notice", () => {
    jobs.singleState = { phase: "failed", message: "Upstream timeout", status: 504 };
    render(<SoundFxStudio catalog={catalog()} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("queues an effect from a one-line description", async () => {
    render(<SoundFxStudio catalog={catalog()} />);
    await userEvent.type(
      screen.getByRole("textbox", { name: "Description" }),
      "A heavy door creaks open",
    );
    await userEvent.click(screen.getByRole("button", { name: "Generate effect" }));
    expect(jobs.singleStart).toHaveBeenCalledWith(expect.objectContaining({ kind: "sfx" }));
  });

  it("narrates a text with the chosen voice and lands it on the scene", async () => {
    render(<SpeechStudio catalog={catalog()} />);
    expect(screen.getByText("Type a text. Its voice-over will play here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Voice, / })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Text" }), "Bonjour à tous");
    await userEvent.click(screen.getByRole("button", { name: "Generate speech" }));
    await waitFor(() => expect(jobs.speech).toHaveBeenCalledTimes(1));
    expect(jobs.speech.mock.calls[0][0]).toMatchObject({ model: "voice", input: "Bonjour à tous" });
    await waitFor(() => expect(jobs.save).toHaveBeenCalled());
  });

  it("queues a narration on an engine that speaks through the queue", async () => {
    const queued = {
      backend: "carpe-diem",
      priceMultiplier: 1,
      models: [
        {
          id: "seed-voice",
          name: "Seed voice",
          mediaType: "music",
          offline: false,
          voices: ["nora"],
          constraints: { voices: ["nora"] },
        },
      ],
    } as unknown as MediaCatalog;
    render(<SpeechStudio catalog={queued} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Text" }), "Une minute de lecture");
    await userEvent.click(screen.getByRole("button", { name: "Generate speech" }));
    expect(jobs.singleStart).toHaveBeenCalledWith(expect.objectContaining({ kind: "speech" }));
    expect(jobs.speech).not.toHaveBeenCalled();
  });
});
