/**
 * Whether a video variant can be found and recognised on screen.
 *
 * A video family is one picker row standing in for up to four backend models,
 * so everything the user could search for - the variant's own id, its own name,
 * the direction shorthand - is invisible by construction. The reported symptom
 * was exactly that: "seedance 2.5 R2V is not on my phone", for a model that was
 * both in the catalog and one tap away.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ModelSheet } from "../components/mobile/ModelSheet";
import {
  variantFor,
  variantHint,
  videoFamilies,
  videoFamilySearchTerms,
} from "../lib/studio/catalog";
import type { VideoFamily } from "../lib/studio/catalog";
import { seedanceCatalog } from "./fixtures/seedance-catalog";

const families = videoFamilies(seedanceCatalog());

function family(key: string): VideoFamily {
  const hit = families.find((entry) => entry.key === key);
  if (!hit) throw new Error(`no family ${key}`);
  return hit;
}

/** The filter `ModelSheet` applies, over the terms the video panel supplies. */
function findable(needle: string): string[] {
  const query = needle.trim().toLowerCase();
  return families
    .filter((entry) =>
      [entry.key, entry.name, ...videoFamilySearchTerms(entry)].some((term) =>
        term.toLowerCase().includes(query),
      ),
    )
    .map((entry) => entry.name);
}

describe("searching for a variant", () => {
  it("finds the family behind every spelling of its reference variant", () => {
    // The reported search. None of these matched before: the row's id is the
    // family key `seedance 2.5` and its name is `Seedance 2.5`.
    for (const needle of [
      "r2v",
      "rtv",
      "seedance 2.5 r2v",
      "Seedance 2.5 RTV",
      "seedance-2-5",
      "seedance-2-5-reference-to-video-basic",
      "reference to video",
    ]) {
      expect(findable(needle), `searching ${JSON.stringify(needle)}`).toContain("Seedance 2.5");
    }
  });

  it("still finds it by the plain family name and key", () => {
    expect(findable("seedance 2.5")).toContain("Seedance 2.5");
    expect(findable("SEEDANCE")).toContain("Seedance 2.5");
  });

  it("does not offer families that have no such variant", () => {
    // 1.5 Pro ships no reference variant at all, so it must not answer to a
    // reference search just because it is a seedance.
    expect(findable("r2v")).not.toContain("Seedance 1.5 Pro");
    expect(findable("v2v")).toEqual(["Wan 2.7 Edit"]);
  });

  it("matches each term whole, never across two of them", () => {
    // A concatenated haystack would match this: `...-basic` followed by
    // `seedance...`. Nothing in the catalog is actually called that.
    expect(findable("basic seedance")).toEqual([]);
  });
});

describe("naming the variant the inputs resolved to", () => {
  const seedance = family("seedance 2.5");
  const resolve = (hasFrame: boolean, hasReferences: boolean) =>
    variantHint(seedance, variantFor(seedance, { hasFrame, hasReferences }));

  it("says nothing for the family's plain text-to-video", () => {
    expect(resolve(false, false)).toBeUndefined();
  });

  it("names the direction, and the backend's own name when it differs", () => {
    // The whole point: "Seedance 2.5 R2V" appears nowhere else in the app.
    expect(resolve(false, true)).toBe("reference to video · Seedance 2.5 R2V");
  });

  it("gives the direction alone when the variant shares the family name", () => {
    expect(resolve(true, false)).toBe("image to video");
  });

  it("names a reference-only family's single variant", () => {
    // No text variant to be the silent default, so there is always something
    // to say.
    expect(variantHint(family("kling o3 4k"), family("kling o3 4k").referenceModel)).toBe(
      "reference to video · Kling O3 4K R2V",
    );
  });

  it("stays quiet about a family whose models carry no display name", () => {
    // The full seedance ids fall back to their own id as a name; repeating it
    // next to the label would be noise, not information.
    const full = family("seedance-2-0");
    expect(variantHint(full, full.referenceModel)).toBe("reference to video");
  });
});

describe("the model sheet", () => {
  const entries = families.map((entry) => ({
    id: entry.key,
    name: entry.name,
    subtitle: [
      entry.textModel ? "text" : undefined,
      entry.imageModel ? "photo" : undefined,
      entry.referenceModel ? "reference" : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
    keywords: videoFamilySearchTerms(entry),
  }));

  it("searches what the row displays as well as its hidden terms", async () => {
    render(
      <ModelSheet
        title="Video model"
        entries={entries}
        selectedId=""
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    );

    // "photo" only ever appears in the subtitle.
    await userEvent.type(screen.getByPlaceholderText("Search models"), "photo");

    expect(screen.getByText("Seedance 2.5")).toBeTruthy();
    expect(screen.queryByText("Wan 2.7 Edit")).toBeNull();
  });

  it("surfaces the family when the query only matches a hidden variant", async () => {
    render(
      <ModelSheet
        title="Video model"
        entries={entries}
        selectedId=""
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    );

    await userEvent.type(screen.getByPlaceholderText("Search models"), "rtv");

    expect(screen.getByText("Seedance 2.5")).toBeTruthy();
    expect(screen.queryByText("Seedance 1.5 Pro")).toBeNull();
  });
});
