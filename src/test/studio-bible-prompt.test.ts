import { describe, expect, it } from "vitest";
import {
  invariantLine,
  MAX_REFERENCE_IMAGES,
  referenceStack,
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

  it("lets a full body outfit view take the profile's place", () => {
    // The prompt bible: a tight portrait and a full body view hold a face and
    // its clothes better than more angles of the face.
    const lea = entry("Léa", {
      refs: [
        ref("lea-profile.png", "profile"),
        ref("lea.png", "portrait"),
        ref("lea-outfit.png", "outfit"),
      ],
    });
    const attic = entry("The attic", { kind: "location", refs: [ref("attic.png", "wide")] });
    const letter = entry("The letter", { kind: "prop", refs: [ref("letter.png", "detail")] });
    const look = entry("Look", { kind: "look", refs: [ref("look.png", "wide")] });
    const stack = referenceStack({
      characters: [lea],
      location: attic,
      props: [letter],
      looks: [look],
    });
    expect(stack.map((item) => item.artifactId)).toEqual([
      "lea.png",
      "lea-outfit.png",
      "attic.png",
      "letter.png",
      "look.png",
    ]);
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
      "Nera, green coat, scar over the left brow.",
    );
    // Already punctuated is not punctuated twice.
    expect(invariantLine(entry("Nera", { traits: "green coat." }))).toBe("Nera, green coat.");
    // Traits that already open with the name are not doubled.
    expect(invariantLine(entry("Nera", { traits: "Nera, green coat" }))).toBe("Nera, green coat.");
    expect(invariantLine(entry("Nera"))).toBe("");
  });
});

describe("carrying traits into a prompt", () => {
  it("adds them once, and leaves a prompt that already says it alone", () => {
    const nera = entry("Nera", { traits: "green coat" });
    const once = withInvariant("Nera walks away.", nera);
    expect(once).toBe("Nera walks away. Nera, green coat.");
    // Picking the same face again must not grow the prompt without adding
    // information.
    expect(withInvariant(once, nera)).toBe(once);
  });

  it("adds nothing for an entry with no traits to hold", () => {
    expect(withInvariant("Nera walks away.", entry("Nera"))).toBe("Nera walks away.");
  });

  it("works on an empty prompt without leaving a leading space", () => {
    expect(withInvariant("", entry("Nera", { traits: "green coat" }))).toBe("Nera, green coat.");
  });
});
