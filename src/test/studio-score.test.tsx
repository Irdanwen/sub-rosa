import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectMusic } from "../components/studio/ProjectMusic";
import { compileCue, compileProjectWithNotes, scoreCues } from "../lib/studio/project-production";
import { newProject, newShot, type ProjectShot } from "../lib/studio/projects";
import {
  acceptProposal,
  CUE_TAIL_SECONDS,
  cueSeconds,
  cueShots,
  musicLength,
  newCue,
  projectScore,
} from "../lib/studio/score";
import type { MediaCatalog, MediaModel } from "../lib/studio/types";
import { pickMusicModel } from "../lib/studio/workflow/compile";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("../lib/studio/artifacts", () => ({ artifactSrc: () => "asset://file" }));

function model(id: string, mediaType: MediaModel["mediaType"], over: Partial<MediaModel> = {}) {
  return {
    id,
    name: id,
    mediaType,
    offline: false,
    costCredits: 2,
    constraints: { durations: ["5s", "10s"] },
    ...over,
  } as MediaModel;
}

const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [
    model("kling-v3-text-to-video", "video"),
    model("stable-audio-2-5", "music", { constraints: undefined }),
    model("elevenlabs-sound-effects", "music", { constraints: undefined }),
  ],
};

function shot(id: string, title = id): ProjectShot {
  return {
    ...newShot(0),
    id,
    title,
    action: `${title} happens.`,
    modelId: "kling-v3-text-to-video",
  };
}

function film() {
  const project = newProject("Museum");
  project.document.shots = [shot("a"), shot("b"), shot("c"), shot("d")];
  return project.document;
}

describe("a cue's shots and length", () => {
  it("covers its shots in the film's order and sums their seconds with a release", () => {
    const document = film();
    const cue = newCue("c", "b");
    expect(cueShots(document.shots, cue).map((item) => item.id)).toEqual(["b", "c"]);
    expect(cueSeconds(document.shots, cue, () => 5)).toBe(10 + CUE_TAIL_SECONDS);
    expect(cueShots(document.shots, newCue("gone", "c"))).toEqual([]);
  });

  it("asks a model with a duration range for the cue's length, snapped up to its step", () => {
    const stable = catalog.models[1];
    expect(musicLength(stable, 12)).toEqual({ seconds: 15, longer: true, shorter: false });
    expect(musicLength(stable, 400)).toMatchObject({ seconds: 180, shorter: true });
    expect(musicLength(model("lyria-2", "music"), 12)).toEqual({ longer: false, shorter: false });
  });
});

describe("the project's score", () => {
  it("repairs a single score to one piece over the whole film, with a stable id", () => {
    const document = film();
    document.score = { mode: "single", identity: "Solo cello.", cues: [] };
    const first = projectScore(document);
    expect(first?.cues).toHaveLength(1);
    expect(first?.cues[0]).toMatchObject({ id: "whole-film", fromShotId: "a", toShotId: "d" });
    expect(projectScore(document)?.cues[0].id).toBe("whole-film");
  });

  it("keeps a legacy project on its old single piece", () => {
    const document = film();
    document.settings.withScore = true;
    expect(scoreCues(document, catalog)).toBeUndefined();
  });

  it("accepts a proposal onto the shots it was read against, keeping takes whose span held", () => {
    const document = film();
    const kept = { ...newCue("a", "b"), takeIds: ["take-1"], activeTakeId: "take-1" };
    const score = acceptProposal(
      {
        identity: "Felt piano.",
        promptVersion: "score-v1",
        cues: [
          { title: "Opening", from: 0, to: 1, mood: "calm", intensity: "low", prompt: "Piano." },
          { title: "Lost", from: 2, to: 3, mood: "", intensity: "loud", prompt: "Strings." },
        ],
      },
      [document.shots[0], document.shots[1], undefined, document.shots[3]],
      "cues",
      { mode: "cues", identity: "", cues: [kept] },
    );
    expect(score.identity).toBe("Felt piano.");
    expect(score.cues).toHaveLength(1);
    expect(score.cues[0]).toMatchObject({
      title: "Opening",
      intensity: "low",
      takeIds: ["take-1"],
      activeTakeId: "take-1",
    });
  });
});

describe("compiling the score", () => {
  it("never picks a sound-effects engine for a score", () => {
    expect(pickMusicModel(catalog)?.id).toBe("stable-audio-2-5");
  });

  it("gives each cue its own timed music node in the production", () => {
    const document = film();
    document.settings.withScore = true;
    document.score = {
      mode: "cues",
      identity: "Solo cello.",
      cues: [
        { ...newCue("a", "b", "Opening"), id: "one", prompt: "Low drone." },
        { ...newCue("c", "d", "Chase"), id: "two", prompt: "Pulsing." },
      ],
    };
    const { workflow } = compileProjectWithNotes("Museum", document, catalog);
    const music = workflow.nodes.filter((node) => node.type === "music");
    expect(music.map((node) => node.id)).toEqual(["score-one", "score-two"]);
    expect(music[0].params).toMatchObject({
      model: "stable-audio-2-5",
      prompt: "Solo cello. Low drone.",
      durationSeconds: 15,
      instrumental: false,
    });
  });

  it("compiles one cue on its own", () => {
    const document = film();
    document.score = {
      mode: "cues",
      identity: "",
      cues: [{ ...newCue("b", "b", "Beat"), id: "beat", mood: "tense" }],
    };
    const workflow = compileCue("Museum", document, catalog, "beat");
    expect(workflow.nodes).toHaveLength(1);
    expect(workflow.nodes[0]).toMatchObject({
      id: "score-beat",
      params: { prompt: "tense", durationSeconds: 10 },
    });
    expect(() => compileCue("Museum", document, catalog, "gone")).toThrow();
  });
});

describe("the music tab", () => {
  it("shows the cues over the film, their length, and a proposal to accept", async () => {
    const document = film();
    document.score = {
      mode: "cues",
      identity: "Solo cello.",
      cues: [{ ...newCue("a", "c", "Opening"), id: "one", prompt: "Low drone." }],
    };
    const onAccept = vi.fn();
    const onGenerate = vi.fn();
    render(
      <ProjectMusic
        document={document}
        catalog={catalog}
        artifacts={[]}
        onScore={vi.fn()}
        onSettings={vi.fn()}
        onGenerate={onGenerate}
        onCompose={vi.fn()}
        proposing={false}
        proposal={{
          identity: "Brass.",
          promptVersion: "score-v1",
          cues: [
            { title: "Fanfare", from: 0, to: 1, mood: "", intensity: "high", prompt: "Horns." },
          ],
        }}
        onAcceptProposal={onAccept}
        onDiscardProposal={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getAllByText("Shots 1 to 3").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "About 17 s under its shots. This model writes at least 20 s; the montage trims what runs over.",
      ),
    ).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(onAccept).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Quote a new take" }));
    expect(onGenerate).toHaveBeenCalledWith("one");
  });
});
