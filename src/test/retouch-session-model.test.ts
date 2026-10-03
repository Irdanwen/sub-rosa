/**
 * A retouch's model belongs to that retouch. It used to be one device-wide
 * setting, so a model picked once for one photo became the model of every
 * retouch after it, and a new retouch never opened on the recommended one.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readSettings, writeSettings } from "../lib/studio/retouch/prefs";

beforeEach(() => {
  window.localStorage.clear();
});

describe("the retouch model", () => {
  it("stays with the retouch it was chosen for", () => {
    writeSettings({ modelId: "flux-2-max-edit", aspectRatio: "auto", variants: 2 }, "photo-a");

    expect(readSettings("photo-a").modelId).toBe("flux-2-max-edit");
    // A new retouch opens on the default, which is the recommended model.
    expect(readSettings("photo-b").modelId).toBe("");
    // What is about the device, not the photo, still carries over.
    expect(readSettings("photo-b").variants).toBe(2);
  });

  it("goes back to the default when the default is chosen again", () => {
    writeSettings({ modelId: "flux-2-max-edit", aspectRatio: "auto", variants: 1 }, "photo-a");
    writeSettings({ modelId: "", aspectRatio: "auto", variants: 1 }, "photo-a");

    expect(readSettings("photo-a").modelId).toBe("");
  });

  it("ignores a model an older version stored for every retouch", () => {
    window.localStorage.setItem(
      "os-june:retouch-settings",
      JSON.stringify({ modelId: "seedream-v4-edit", aspectRatio: "auto", variants: 1 }),
    );

    expect(readSettings("photo-a").modelId).toBe("");
  });
});
