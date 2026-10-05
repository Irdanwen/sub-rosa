import { describe, expect, it } from "vitest";
import { type BibleEntry, describeReferences, referenceStack } from "../lib/studio/bible";
import { rewriteReferences } from "../lib/studio/studio-rewrite";

function entry(name: string, kind: BibleEntry["kind"], refs: [string, string][]): BibleEntry {
  return {
    id: name,
    kind,
    name,
    traits: "",
    note: "",
    refs: refs.map(([artifactId, role], ordinal) => ({
      id: `${name}-${ordinal}`,
      entryId: name,
      artifactId,
      role: role as BibleEntry["refs"][number]["role"],
      label: "",
      ordinal,
    })),
    createdAt: "",
    updatedAt: "",
  };
}

const nera = entry("Nera", "character", [
  ["nera.png", "portrait"],
  ["nera-side.png", "profile"],
]);
const ivo = entry("Ivo", "character", [["ivo.png", "portrait"]]);
const alley = entry("Alley", "location", [
  ["alley-wide.png", "wide"],
  ["alley-mid.png", "medium"],
]);

describe("the references a shot rewrite is told about", () => {
  const stack = referenceStack({ characters: [nera, ivo], location: alley });

  it("gives kling one line per element and per scene, angles folded in", () => {
    expect(rewriteReferences({ id: "kling-o3-pro-reference-to-video" }, stack)).toEqual([
      { mention: "@Element1", name: "Nera", kind: "character", roles: ["portrait", "profile"] },
      { mention: "@Image1", name: "Alley", kind: "location", roles: ["wide"] },
      { mention: "@Image2", name: "Alley", kind: "location", roles: ["medium"] },
      { mention: "@Element2", name: "Ivo", kind: "character", roles: ["portrait"] },
    ]);
  });

  it("counts positions for seedance, one line per image", () => {
    const lines = rewriteReferences({ id: "seedance-2-0-reference-to-video-basic" }, stack);
    expect(lines.map((line) => line.mention)).toEqual([
      "<Image 1>",
      "<Image 2>",
      "<Image 3>",
      "<Image 4>",
      "<Image 5>",
    ]);
    expect(lines[1]).toMatchObject({ name: "Nera", roles: ["profile"] });
  });

  it("leaves out what a flat family's cap drops from the request", () => {
    const lines = rewriteReferences({ id: "gemini-omni-flash-reference-to-video" }, stack);
    expect(lines.map((line) => line.mention)).toEqual(["Image 1", "Image 2", "Image 3"]);
  });

  it("describes images picked from the gallery by the entry holding them", () => {
    const described = describeReferences(["alley-wide.png", "loose.png"], [nera, alley]);
    expect(described).toEqual([
      { artifactId: "alley-wide.png", entryName: "Alley", role: "wide", kind: "location" },
      { artifactId: "loose.png", entryName: "" },
    ]);
    expect(rewriteReferences({ id: "kling-o3-pro-reference-to-video" }, described)).toEqual([
      { mention: "@Image1", name: "Alley", kind: "location", roles: ["wide"] },
      { mention: "@Element1", name: "", kind: undefined, roles: [] },
    ]);
  });
});
