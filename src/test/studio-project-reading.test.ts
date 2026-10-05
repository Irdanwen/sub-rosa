import { describe, expect, it } from "vitest";
import type { BibleEntry } from "../lib/studio/bible/types";
import { cameraFromWords, landReading, rerouteImportedShots } from "../lib/studio/project-reading";
import { newProject, shotSignature } from "../lib/studio/projects";
import type { MediaCatalog, MediaModel } from "../lib/studio/types";

const model = (id: string, mediaType: MediaModel["mediaType"]): MediaModel =>
  ({ id, name: id, mediaType, offline: false, costCredits: 10 }) as MediaModel;
const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [
    model("seedance-2-0-text-to-video-basic", "video"),
    model("seedance-2-0-reference-to-video-basic", "referenceToVideo"),
  ],
};

describe("landing a reading", () => {
  it("turns the reader's flat ids into a framing and a move, and keeps a proposal apart", () => {
    const landed = landReading(
      JSON.stringify({
        language: "fr",
        direction: { genre: "noir", moods: ["mysterious", "tense", "epic"], pacing: "nope" },
        cast: [{ name: "Léa", kind: "character", traits: "a 30-year-old woman" }],
        shots: [
          {
            scene: "Grenier",
            action: "Léa unfolds the letter",
            size: "close-up",
            lens: "85mm",
            movement: "push-in",
            amplitude: "small",
            speed: "slow",
            tone: "calm",
            transition: "dissolve",
            voiceover: true,
            effects: "paper rustling",
            characters: ["Léa"],
            continues: false,
          },
        ],
      }),
    );
    const [shot] = landed.shots;
    expect(shot.framing).toEqual({ size: "close-up", lens: "85mm" });
    expect(shot.move).toEqual({ kind: "push-in", amplitude: "small", speed: "slow" });
    expect(shot).toMatchObject({
      tone: "calm",
      transition: "dissolve",
      voiceover: true,
      effects: "paper rustling",
      mode: "text",
      modeSource: "import",
      title: "Grenier",
    });
    expect(landed.language).toBe("fr");
    expect(landed.direction).toEqual({ genre: "noir", moods: ["mysterious", "tense"] });
    expect(landed.cast).toHaveLength(1);
  });

  it("still lands a reading made before the vocabulary, reading its camera words", () => {
    const landed = landReading(
      JSON.stringify([{ action: "Nera turns", camera: "slow push in, low angle close-up" }]),
    );
    expect(landed.shots[0].camera).toBe("slow push in, low angle close-up");
    expect(landed.shots[0].framing).toEqual({ size: "close-up", angle: "low" });
    expect(landed.shots[0].move).toEqual({ kind: "push-in", speed: "slow" });
    expect(landed.direction).toBeUndefined();
  });

  it("leaves a camera note it cannot read as words", () => {
    expect(cameraFromWords("as in the previous scene")).toEqual({});
  });
});

describe("imported shots following the bible", () => {
  const lea: BibleEntry = {
    id: "lea",
    kind: "character",
    name: "Léa",
    traits: "",
    note: "",
    createdAt: "",
    updatedAt: "",
    refs: [],
  };
  const document = () => {
    const project = newProject("Film");
    const [shot] = landReading(
      JSON.stringify([{ action: "Léa waits", characters: ["Léa"] }]),
    ).shots;
    return { ...project.document, shots: [shot], bible: [lea] };
  };

  it("moves to the reference models once somebody it shows has a picture", () => {
    const before = document();
    expect(rerouteImportedShots(before, catalog)).toBe(before);
    const withPortrait = {
      ...before,
      bible: [
        {
          ...lea,
          refs: [
            {
              id: "r",
              entryId: "lea",
              artifactId: "lea.png",
              role: "portrait" as const,
              label: "",
              ordinal: 0,
            },
          ],
        },
      ],
    };
    expect(rerouteImportedShots(withPortrait, catalog).shots[0].mode).toBe("reference");
  });

  it("never touches a mode somebody chose, nor a shot already rendered", () => {
    const chosen = document();
    chosen.shots[0] = { ...chosen.shots[0], modeSource: undefined };
    chosen.bible[0] = {
      ...lea,
      refs: [
        { id: "r", entryId: "lea", artifactId: "lea.png", role: "portrait", label: "", ordinal: 0 },
      ],
    };
    expect(rerouteImportedShots(chosen, catalog).shots[0].mode).toBe("text");
    chosen.shots[0] = { ...chosen.shots[0], modeSource: "import", takeIds: ["take.mp4"] };
    expect(rerouteImportedShots(chosen, catalog).shots[0].mode).toBe("text");
  });
});

describe("take signatures", () => {
  it("stay byte for byte what they were for a project with no direction", () => {
    const project = newProject("Film");
    const [shot] = landReading(JSON.stringify([{ action: "Nera turns" }])).shots;
    const document = { ...project.document, shots: [shot] };
    const before = shotSignature(shot, document);
    // Labels a rewrite leaves behind never make a take stale.
    expect(
      shotSignature(
        { ...shot, promptVersion: "studio-rewrite-v4", modeSource: undefined },
        document,
      ),
    ).toBe(before);
    expect(before).not.toContain("filmDirection");
    // A direction is an input: changing the look makes the takes stale.
    const directed = { ...document, filmDirection: { look: "film-35" } };
    expect(shotSignature(shot, directed)).not.toBe(before);
  });
});
