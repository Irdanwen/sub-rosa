import { describe, expect, it } from "vitest";
import {
  klingLayout,
  klingMention,
  klingMentions,
  klingReferenceFields,
} from "../lib/studio/kling";

describe("klingLayout", () => {
  it("is the positional rule when nothing is known", () => {
    const mentions = klingMentions(9);
    expect(mentions).toEqual([
      "@Element1",
      "@Element2",
      "@Element3",
      "@Element4",
      "@Image1",
      "@Image2",
      "@Image3",
      "@Image4",
      undefined,
    ]);
    // The free studio's chips spell the same thing one at a time.
    expect(mentions.slice(0, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(klingMention));
  });

  it("makes a subject's later images angles of its element, up to three", () => {
    const roles = Array.from({ length: 5 }, () => ({ subject: "Nera" }));
    expect(klingLayout(5, roles)).toEqual([
      { field: "element", element: 0 },
      { field: "angle", element: 0 },
      { field: "angle", element: 0 },
      { field: "angle", element: 0 },
      { field: "dropped" },
    ]);
    expect(klingMentions(4, roles)).toEqual(["@Element1", "@Element1", "@Element1", "@Element1"]);
  });

  it("matches subjects by name, whatever their case and spacing", () => {
    expect(klingMentions(2, [{ subject: "Nera" }, { subject: " nera " }])).toEqual([
      "@Element1",
      "@Element1",
    ]);
  });

  it("keeps places out of the elements, wherever they sit in the stack", () => {
    // The bible stack: lead portrait, lead profile, three angles of the
    // place, then a second character.
    const roles = [
      { subject: "Nera" },
      { subject: "Nera" },
      { scene: true },
      { scene: true },
      { scene: true },
      { subject: "Ivo" },
    ];
    expect(klingMentions(6, roles)).toEqual([
      "@Element1",
      "@Element1",
      "@Image1",
      "@Image2",
      "@Image3",
      "@Element2",
    ]);
  });

  it("spills a fifth subject into the scenes rather than lose it", () => {
    const roles = ["A", "B", "C", "D", "E"].map((subject) => ({ subject }));
    expect(klingMentions(5, roles)).toEqual([
      "@Element1",
      "@Element2",
      "@Element3",
      "@Element4",
      "@Image1",
    ]);
  });

  it("builds the request fields in the same layout", () => {
    expect(
      klingReferenceFields(
        ["a", "b", "c"],
        [{ subject: "Nera" }, { scene: true }, { subject: "Nera" }],
      ),
    ).toEqual({
      elements: [{ frontal_image_url: "a", reference_image_urls: ["c"] }],
      scene_image_urls: ["b"],
    });
    expect(klingReferenceFields([])).toEqual({});
  });
});
