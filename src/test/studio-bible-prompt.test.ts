import { describe, expect, it } from "vitest";
import {
  invariantLine,
  joinBeats,
  LENS_SWITCH,
  MAX_REFERENCE_IMAGES,
  referenceStack,
  SEEDANCE_WORD_LIMIT,
  shotPrompt,
  voiceReference,
  withInvariant,
} from "../lib/studio/bible/prompt";
import type { BibleEntry, BibleRef, BibleRole } from "../lib/studio/bible/types";

let nextRef = 0;
function ref(artifactId: string, role: BibleRole, ordinal = nextRef++): BibleRef {
  return { id: `r${artifactId}`, entryId: "e", artifactId, role, label: "", ordinal };
}

function entry(name: string, over: Partial<BibleEntry> = {}): BibleEntry {
  return {
    id: name,
    kind: "character",
    name,
    traits: "",
    note: "",
    refs: [],
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

describe("the reference stack", () => {
  it("puts the identity anchor first and the crowd last", () => {
    // The order is the contract: the model holds the first image's identity.
    // Getting it wrong silently swaps whose face the shot keeps.
    const nera = entry("Nera", {
      refs: [ref("nera-profile.png", "profile"), ref("nera.png", "portrait")],
    });
    const extra = entry("Extra", { refs: [ref("extra.png", "portrait")] });
    const alley = entry("The alley", {
      kind: "location",
      refs: [ref("alley-detail.png", "detail"), ref("alley-wide.png", "wide")],
    });

    const stack = referenceStack({
      characters: [nera, extra],
      location: alley,
      blockingPlateArtifactId: "plate.png",
    });
    expect(stack.map((item) => item.artifactId)).toEqual([
      "nera.png",
      "nera-profile.png",
      "plate.png",
      "alley-wide.png",
      "alley-detail.png",
      "extra.png",
    ]);
  });

  it("drops from the end when it overflows, so the lead survives", () => {
    const lead = entry("Lead", { refs: [ref("lead.png", "portrait")] });
    const crowd = Array.from({ length: 12 }, (_, index) =>
      entry(`Extra ${index}`, { refs: [ref(`extra-${index}.png`, "portrait")] }),
    );
    const stack = referenceStack({ characters: [lead, ...crowd] });
    expect(stack.length).toBe(MAX_REFERENCE_IMAGES);
    expect(stack[0]?.artifactId).toBe("lead.png");
  });

  it("never sends the same picture twice", () => {
    const shared = entry("Shared", {
      refs: [ref("same.png", "portrait", 0), ref("same.png", "profile", 1)],
    });
    expect(referenceStack({ characters: [shared] }).length).toBe(1);
  });

  it("ignores a voice donor when it is picking pictures", () => {
    const nera = entry("Nera", { refs: [ref("nera.png", "portrait"), ref("nera.mp3", "voice")] });
    expect(referenceStack({ characters: [nera] }).map((item) => item.artifactId)).toEqual([
      "nera.png",
    ]);
    expect(voiceReference(nera)?.artifactId).toBe("nera.mp3");
    expect(voiceReference(entry("Nobody"))).toBeUndefined();
  });
});

describe("invariant traits", () => {
  it("restates what must not drift, once, as a sentence", () => {
    expect(invariantLine(entry("Nera", { traits: "green coat, scar over the left brow" }))).toBe(
      "Nera: green coat, scar over the left brow.",
    );
    // Already punctuated is not punctuated twice.
    expect(invariantLine(entry("Nera", { traits: "green coat." }))).toBe("Nera: green coat.");
    expect(invariantLine(entry("Nera"))).toBe("");
  });
});

describe("carrying traits into a prompt", () => {
  it("adds them once, and leaves a prompt that already says it alone", () => {
    const nera = entry("Nera", { traits: "green coat" });
    const once = withInvariant("Nera walks away.", nera);
    expect(once).toBe("Nera walks away. Nera: green coat.");
    // Picking the same face again must not grow the prompt without adding
    // information - the budget is sixty words.
    expect(withInvariant(once, nera)).toBe(once);
  });

  it("adds nothing for an entry with no traits to hold", () => {
    expect(withInvariant("Nera walks away.", entry("Nera"))).toBe("Nera walks away.");
  });

  it("works on an empty prompt without leaving a leading space", () => {
    expect(withInvariant("", entry("Nera", { traits: "green coat" }))).toBe("Nera: green coat.");
  });
});

describe("the shot prompt", () => {
  const long = (word: string, count: number) => Array.from({ length: count }, () => word).join(" ");

  it("names the lead's image the way a seedance model reads it", () => {
    const built = shotPrompt({
      subject: "Nera alone in the alley.",
      action: "She turns towards the sound.",
      model: { id: "seedance-2-0-text-to-video-basic" },
      stack: [{ artifactId: "nera.png", entryName: "Nera", role: "portrait" }],
    });
    expect(built.prompt.startsWith("Refer to <Image 1> for Nera.")).toBe(true);
  });

  it("uses plain prose for a model with no documented mention syntax", () => {
    const built = shotPrompt({
      subject: "Nera.",
      action: "She turns.",
      model: { id: "wan-2-7-text-to-video" },
      stack: [{ artifactId: "nera.png", entryName: "Nera", role: "portrait" }],
    });
    expect(built.prompt.startsWith("Refer to image 1 for Nera.")).toBe(true);
  });

  it("drops in a stated order as the pressure rises, and says what went", () => {
    // Asserted as an order rather than against tuned numbers: what matters is
    // that constraints go before style, style before a secondary character's
    // traits, and those before the camera.
    const under = (actionWords: number) =>
      shotPrompt({
        subject: "Nera in the alley.",
        action: long("running", actionWords),
        camera: long("dolly", 6),
        style: long("noir", 6),
        constraints: long("nothing", 6),
        invariants: ["Nera: green coat.", "Extra: red hat."],
      });

    const gone = (words: number) => under(words).dropped.map((part) => part.split(" ")[0]);
    expect(gone(10)).toEqual([]);
    expect(gone(36)).toEqual(["nothing"]);
    expect(gone(42)).toEqual(["nothing", "noir"]);
    expect(gone(46)).toEqual(["nothing", "noir", "Extra:"]);
    expect(gone(60)).toEqual(["nothing", "noir", "Extra:", "dolly"]);

    // Whatever the pressure, the lead's traits stay.
    for (const words of [36, 42, 46, 60]) {
      expect(under(words).prompt).toContain("Nera: green coat.");
    }
  });

  it("never drops the subject, the action or the lead's traits", () => {
    // A prompt over budget is a worse shot. A prompt without its subject is a
    // different shot, so the budget does not get to take those.
    const built = shotPrompt({
      subject: long("subject", 40),
      action: long("action", 40),
      invariants: [long("invariant", 40)],
      constraints: long("constraint", 40),
    });
    expect(built.prompt).toContain("subject");
    expect(built.prompt).toContain("action");
    expect(built.prompt).toContain("invariant");
    expect(built.prompt).not.toContain("constraint");
    expect(built.wordCount).toBeGreaterThan(SEEDANCE_WORD_LIMIT);
  });

  it("fits comfortably under the limit when there is nothing to cut", () => {
    const built = shotPrompt({
      subject: "Nera alone in the alley.",
      action: "She turns towards the sound.",
      camera: "Slow push in.",
      style: "Noir, sodium light.",
      invariants: ["Nera: green coat."],
    });
    expect(built.dropped).toEqual([]);
    expect(built.wordCount).toBeLessThan(SEEDANCE_WORD_LIMIT);
  });
});

describe("beats", () => {
  it("makes adjacent beats one generation", () => {
    // One render holds the lighting and the geography across beats in a way
    // two renders cannot, however carefully the second one is prompted.
    expect(joinBeats(["She turns.", "  ", "He steps out."])).toBe(
      `She turns. ${LENS_SWITCH} He steps out.`,
    );
    expect(joinBeats([])).toBe("");
  });
});
