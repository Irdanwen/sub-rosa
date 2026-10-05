import { describe, expect, it } from "vitest";
import type { BibleEntry, BibleRef, BibleRole } from "../lib/studio/bible/types";
import type { FilmDirection } from "../lib/studio/direction/types";
import { entries, entry as vocabularyEntry } from "../lib/studio/direction/vocabulary";
import {
  type ComposeInput,
  composeShotPrompt,
  lockedStyle,
  resolveDialogue,
} from "../lib/studio/prompt/compose";
import { familyProfile } from "../lib/studio/prompt/profiles";
import { guessLanguage } from "../lib/studio/prompt/subject";
import { seedancePromptAdvice } from "../lib/studio/seedance";
import { type Shot, shotReferences } from "../lib/studio/workflow/compile";

function ref(entryId: string, artifactId: string, role: BibleRole, ordinal = 0): BibleRef {
  return { id: `${entryId}-${artifactId}`, entryId, artifactId, role, label: "", ordinal };
}

function bibleEntry(over: Partial<BibleEntry> & Pick<BibleEntry, "name">): BibleEntry {
  return {
    id: over.name,
    kind: "character",
    traits: "",
    note: "",
    refs: [],
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

// The prompt bible's own worked example.
const lea = bibleEntry({
  name: "Léa",
  traits:
    "a 30-year-old woman, slim build, oval face, green eyes, small scar above the left eyebrow, shoulder-length dark brown wavy hair worn loose, navy wool coat, mustard knitted scarf, silver ring on the right hand",
  refs: [ref("Léa", "lea.png", "portrait"), ref("Léa", "lea-outfit.png", "outfit", 1)],
});
const attic = bibleEntry({
  name: "the attic",
  kind: "location",
  traits:
    "a cramped wooden attic, 1960s, exposed beams, dusty trunks along the left wall, one small round window on the back wall letting in morning light",
  refs: [ref("the attic", "attic.png", "wide")],
});
const direction: FilmDirection = {
  genre: "intimate-drama",
  moods: ["melancholic", "intimate"],
  pacing: "slow",
  look: "film-35",
  palette: "teal-amber",
  light: { source: "window", direction: "left", quality: "soft", contrast: "low-key" },
  texture: "fine-grain",
  ambience: "old-house",
  music: "none",
};
const letterShot: Shot = {
  scene: "The attic",
  action:
    "Léa unfolds a yellowed handwritten letter; her eyes move slowly across the lines, her thumb presses the paper edge",
  camera: "",
  characters: ["Léa"],
  location: "",
  dialogue: "",
  speaker: "",
  motion: "low",
  continues: false,
  framing: { size: "medium-close-up", lens: "85mm", depth: "shallow", angle: "eye-level" },
  move: { kind: "push-in", amplitude: "small", speed: "very-slow" },
  effects: "paper rustling, a slow breath",
};
const h3 = { id: "minimax-h3-text-to-video", constraints: { audio: true } };

function compose(over: Partial<ComposeInput> = {}) {
  return composeShotPrompt({
    shot: letterShot,
    direction,
    bible: [lea, attic],
    model: h3,
    mode: "text",
    seconds: 5,
    ...over,
  });
}

describe("the composed prompt", () => {
  it("writes the bible's worked example, block by block, for a family that reads labels", () => {
    const composed = compose({
      shot: { ...letterShot, dialogue: "Il savait.", speaker: "Léa", tone: "calm", pace: "slow" },
    });
    expect(composed.text).toBe(
      [
        "[OVERALL] Intimate drama, melancholic and intimate. 5 seconds, slow, deliberate pacing. Single continuous shot.",
        "[SUBJECT] Léa, a 30-year-old woman, slim build, oval face, green eyes, small scar above the left eyebrow, shoulder-length dark brown wavy hair worn loose, navy wool coat, mustard knitted scarf, silver ring on the right hand. The attic.",
        "[SHOT 1 | 0-5s] Medium close-up, 85mm portrait lens, shallow depth of field, eye-level. Push-in, small amplitude, very slow speed. Léa unfolds a yellowed handwritten letter; her eyes move slowly across the lines, her thumb presses the paper edge.",
        "[DIALOGUE] Léa, calm, even tone, slow pace (S1), says: [French] Il savait. Léa's lips close.",
        "[SOUND] Effects: paper rustling, a slow breath. Ambience: old house creaks, muffled wind outside. No background music.",
        "[STYLE] 35mm film look, Kodak Vision3 500T, teal and amber palette, window light from camera left, soft diffused light, low-key, fine film grain.",
        "[NEGATIVE] No subtitles. No watermark. No cuts. No scene change. No extra characters. No duplicated people. No costume changes. No face distortion. No camera shake. No sudden camera movement. No background music, no score, no instrumental. No logo.",
      ].join("\n"),
    );
    expect(composed.dialogue.mode).toBe("native");
    expect(composed.overBy).toBe(0);
  });

  it("says there is no dialogue rather than letting the model decide", () => {
    expect(compose().text).toContain("[DIALOGUE] No dialogue.");
    // A silent shot with someone in it keeps their mouth shut on a sound model.
    expect(compose().text).toContain("Lips stay closed.");
  });

  it("opens a seedance reference prompt with the references, so the right workflow runs", () => {
    const model = { id: "seedance-2-0-reference-to-video-basic", constraints: { audio: true } };
    const shot = { ...letterShot, location: "the attic" };
    const composed = compose({
      model,
      mode: "reference",
      shot,
      references: shotReferences(shot, [lea, attic], model),
    });
    expect(
      composed.text.startsWith(
        "Refer to <Image 1> for Léa's face and hair, <Image 2> for Léa's outfit only and <Image 3> for the layout of the attic.",
      ),
    ).toBe(true);
    expect(seedancePromptAdvice(model, composed.text)).toBeUndefined();
    // Tight family: no labels, and the descriptors shrink to what the images cannot say.
    expect(composed.text).not.toContain("[OVERALL]");
    expect(composed.text).toContain("Léa, small scar above the left eyebrow, navy wool coat.");
  });

  it("gives a kling element one sentence, its roles merged", () => {
    const model = { id: "kling-o3-pro-reference-to-video", constraints: { audio: true } };
    const shot = { ...letterShot, location: "the attic" };
    const composed = compose({
      model,
      mode: "reference",
      shot,
      references: shotReferences(shot, [lea, attic], model),
    });
    expect(composed.text).toContain("@Element1 is Léa: face, hair and outfit.");
    expect(composed.text).toContain("@Image1 is the attic: keep the layout.");
    expect(composed.text.match(/@Element1 is/g)).toHaveLength(1);
  });

  it("never writes a time range for kling, whose notation cuts the shot", () => {
    const composed = compose({ model: { id: "kling-v3-pro-text-to-video" } });
    expect(composed.text).not.toMatch(/\d+\s*-\s*\d+s|\[\d\d:\d\d/);
  });

  it("puts wan's own first line first", () => {
    expect(compose({ model: { id: "wan-3-0-text-to-video" } }).text.split("\n")[0]).toBe(
      "Generate single shot.",
    );
  });

  it("speaks a French line natively only on a family that speaks French", () => {
    const shot = { ...letterShot, dialogue: "Il savait.", speaker: "Léa" };
    expect(resolveDialogue(shot, direction, h3).mode).toBe("native");
    const kling = { id: "kling-v3-pro-text-to-video", constraints: { audio: true } };
    expect(resolveDialogue(shot, direction, kling).mode).toBe("dubbed");
    expect(resolveDialogue({ ...shot, dialogue: "He knew." }, direction, kling).mode).toBe(
      "native",
    );
    // Asked for native where it cannot be: dubbed, and said so.
    expect(resolveDialogue({ ...shot, dialogueMode: "native" }, direction, kling)).toMatchObject({
      mode: "dubbed",
      downgraded: true,
    });
    expect(resolveDialogue({ ...shot, dialogueMode: "dubbed" }, direction, h3).mode).toBe("dubbed");
  });

  it("silences a dubbed render where the model has the switch, and mutes it in the montage otherwise", () => {
    const shot = { ...letterShot, dialogue: "Il savait.", speaker: "Léa" };
    const switchable = compose({
      shot,
      model: {
        id: "kling-v3-pro-text-to-video",
        constraints: { audio: true, audio_configurable: true },
      },
    });
    expect(switchable).toMatchObject({ silenceAudio: true, muteInMontage: false });
    expect(switchable.text).toContain("Léa speaks.");
    expect(switchable.text).not.toContain("Il savait");
    const fixed = compose({ shot: { ...shot, dialogueMode: "dubbed" } });
    expect(fixed).toMatchObject({ silenceAudio: false, muteInMontage: true });
  });

  it("keeps a voiceover's speaker off screen", () => {
    const composed = compose({
      shot: {
        ...letterShot,
        dialogue: "Il l'a écrite la veille.",
        speaker: "Inès",
        voiceover: true,
      },
    });
    expect(composed.text).toContain('Voiceover (Inès): "Il l\'a écrite la veille."');
    expect(composed.text).toContain("Lips stay closed.");
  });

  it("never forbids the shake of a camera asked to shake", () => {
    const composed = compose({ shot: { ...letterShot, move: { kind: "handheld" } } });
    expect(composed.text).toContain("Handheld, subtle shake.");
    expect(composed.text).not.toContain("No camera shake");
  });

  it("guards an animated film against turning photographic, and a period one against phones", () => {
    const composed = compose({
      direction: { ...direction, look: "animation-3d", era: "1960s Paris" },
    });
    expect(composed.text).toContain("No photorealistic live-action.");
    expect(composed.text).toContain("Set in 1960s Paris.");
    expect(composed.text).toContain("No modern objects.");
  });

  it("falls back to the free camera note for a shot read before the vocabulary", () => {
    const composed = compose({
      shot: {
        ...letterShot,
        framing: undefined,
        move: undefined,
        camera: "slow push in on her hands",
      },
    });
    expect(composed.text).toContain("Slow push in on her hands.");
  });

  it("frames a shot the script gave no camera with the film's defaults", () => {
    const composed = compose({
      shot: { ...letterShot, framing: undefined, move: undefined },
      direction: {
        ...direction,
        shotDefaults: { framing: { size: "wide" }, move: { kind: "static" } },
      },
    });
    expect(composed.text).toContain("Wide shot.");
    expect(composed.text).toContain("Static shot, locked-off camera.");
  });
});

/** A deterministic pseudo random sequence, so a failure reproduces. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("the composed prompt, over a thousand generated shots", () => {
  const families = [
    "seedance-2-0-reference-to-video-basic",
    "seedance-2-5-text-to-video-basic",
    "kling-o3-pro-reference-to-video",
    "kling-v3-pro-text-to-video",
    "veo3.1-full-text-to-video",
    "minimax-h3-text-to-video",
    "wan-3-0-text-to-video",
    "wan-2-7-text-to-video",
    "ltx-2-5-pro-text-to-video",
    "someone-new-text-to-video",
  ];
  const pick = <T>(next: () => number, list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const ids = (category: Parameters<typeof entries>[0]) => entries(category).map((item) => item.id);

  const cases = Array.from({ length: 1000 }, (_, index) => {
    const next = random(index + 1);
    const modelId = pick(next, families);
    const model = { id: modelId, constraints: { audio: next() > 0.3 } };
    const mode: ComposeInput["mode"] = modelId.includes("reference") ? "reference" : "text";
    const shot: Shot = {
      ...letterShot,
      location: next() > 0.5 ? "the attic" : "",
      action: Array.from({ length: 5 + Math.floor(next() * 40) }, () => "moves").join(" "),
      dialogue: next() > 0.5 ? pick(next, ["Il savait.", "He knew it all along."]) : "",
      speaker: "Léa",
      framing: { size: pick(next, ids("shotSizes")), lens: pick(next, ids("lenses")) },
      move: { kind: pick(next, ids("movements")), amplitude: "small", speed: "slow" },
    };
    const film: FilmDirection = {
      genre: pick(next, ids("genres")),
      moods: [pick(next, ids("moods")), pick(next, ids("moods"))],
      look: pick(next, ids("looks")),
      palette: pick(next, ids("palettes")),
      texture: pick(next, ids("textures")),
    };
    const references = mode === "reference" ? shotReferences(shot, [lea, attic], model) : [];
    return {
      model,
      film,
      composed: composeShotPrompt({
        shot,
        direction: film,
        bible: [lea, attic],
        model,
        mode,
        seconds: 5,
        references,
      }),
    };
  });

  it("never loses the subject, the framing or the action, and reports any overflow", () => {
    for (const { composed } of cases) {
      expect(composed.text).toContain("Léa");
      expect(composed.text.toLowerCase()).toContain("moves moves moves moves moves");
      const size = composed.blocks.find((block) => block.id === "shot")?.parts[0]?.text ?? "";
      expect(size.length).toBeGreaterThan(0);
      expect(composed.overBy).toBe(Math.max(0, composed.words - composed.budget));
      if (composed.overBy === 0) expect(composed.words).toBeLessThanOrEqual(composed.budget);
    }
  });

  it("never forbids what the shot asks for", () => {
    for (const { composed } of cases) {
      if (/handheld|FPV/.test(composed.text))
        expect(composed.text).not.toContain("No camera shake");
    }
  });

  it("writes labels only for families that read them, and no time for the ones it would cut", () => {
    for (const { composed, model } of cases) {
      const profile = familyProfile(model);
      expect(composed.text.includes("[OVERALL]")).toBe(profile.labels);
      if (profile.timecodes === "words") expect(composed.text).not.toMatch(/\d+-\d+s\]/);
    }
  });

  it("keeps a seedance reference prompt routable", () => {
    for (const { composed, model } of cases) {
      if (model.id.startsWith("seedance") && model.id.includes("reference")) {
        expect(seedancePromptAdvice(model, composed.text)).toBeUndefined();
      }
    }
  });

  it("writes one [STYLE] per film and family, whatever each shot's budget pressure", () => {
    for (const { composed, model, film } of cases) {
      const style = lockedStyle(film, familyProfile(model));
      if (style) expect(composed.text).toContain(style);
    }
  });
});

describe("the vocabulary", () => {
  it("knows which movements shake and which looks are drawn", () => {
    expect(vocabularyEntry("movements", "handheld")?.shaky).toBe(true);
    expect(vocabularyEntry("looks", "animation-3d")?.animated).toBe(true);
  });
});

describe("the lines' language", () => {
  it("reads French from its typography and its common words, not only its accents", () => {
    expect(guessLanguage("Encore ?")).toBe("fr");
    expect(guessLanguage("Il y a quelqu'un ?")).toBe("fr");
    expect(guessLanguage("Où es-tu")).toBe("fr");
    expect(guessLanguage("Get in.")).toBe("en");
    expect(guessLanguage("Is anyone there?")).toBe("en");
  });
});
