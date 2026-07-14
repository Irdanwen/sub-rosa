import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFilmRef } from "../lib/films/refs";

// jsdom decodes no images, so stub Image: setting src fires onload with a
// sub-preview size, driving downscale()'s early-return path (no canvas).
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 640;
  naturalHeight = 480;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

let originalImage: typeof Image | undefined;

beforeEach(() => {
  originalImage = globalThis.Image;
  // @ts-expect-error test double
  globalThis.Image = FakeImage;
});

afterEach(() => {
  if (originalImage) globalThis.Image = originalImage;
});

describe("readFilmRef", () => {
  it("extracts the original base64 and produces a preview + stable id", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "nera.png", { type: "image/png" });
    const ref = await readFilmRef(file, "character");
    expect(ref.role).toBe("character");
    expect(ref.fileName).toBe("nera.png");
    expect(ref.label).toBe("");
    // base64 of [1,2,3] is "AQID"; base64Data must carry no data-URI prefix.
    expect(ref.base64Data).toBe("AQID");
    expect(ref.previewDataUri.startsWith("data:image/")).toBe(true);
    expect(ref.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("names an unnamed file so the studio has something to store", async () => {
    const file = new File([new Uint8Array([9])], "", { type: "image/png" });
    const ref = await readFilmRef(file, "style");
    expect(ref.fileName).toBe("reference.png");
    expect(ref.role).toBe("style");
  });
});
