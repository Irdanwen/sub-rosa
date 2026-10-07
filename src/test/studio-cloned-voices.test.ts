// Cloned voices (ADR-0077): a `cloned:<id>` reference is resolved to a handle
// at the moment of speaking, and reminted once when the backend says the
// handle is gone. The handle itself is never stored anywhere else.

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ invoke: vi.fn(), mediaBinary: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: hoisted.invoke }));
vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaBinary: hoisted.mediaBinary,
}));

import { MediaError } from "../lib/studio/client";
import { clonedVoiceId, clonedVoiceRef, extensionOf } from "../lib/studio/cloned-voices";
import { acceptedVoice, generateSpeech, speechCapabilities } from "../lib/studio/speech";
import { castVoice } from "../lib/studio/workflow/compile";
import type { MediaCatalog, MediaModel } from "../lib/studio/types";
import { audioCatalog } from "./fixtures/audio-catalog";

const chatterbox = audioCatalog.models.find(
  (model) => model.id === "tts-chatterbox-hd",
) as MediaModel;
const kokoro = audioCatalog.models.find((model) => model.id === "tts-kokoro") as MediaModel;

beforeEach(() => {
  hoisted.invoke.mockReset();
  hoisted.mediaBinary.mockReset();
});

describe("a cloned voice reference", () => {
  it("round-trips its id and nothing else", () => {
    expect(clonedVoiceId(clonedVoiceRef("abc"))).toBe("abc");
    expect(clonedVoiceId("Aurora")).toBeUndefined();
    expect(extensionOf("Mémo vocal.M4A")).toBe("m4a");
  });

  it("is a voice only on the engine that clones", () => {
    expect(acceptedVoice(speechCapabilities(chatterbox), "cloned:abc")).toBe("cloned:abc");
    expect(acceptedVoice(speechCapabilities(kokoro), "cloned:abc")).toBe(
      speechCapabilities(kokoro).defaultVoice,
    );
  });
});

describe("speaking with a cloned voice", () => {
  it("sends the handle, never the reference", async () => {
    hoisted.invoke.mockResolvedValueOnce("vv_fresh");
    hoisted.mediaBinary.mockResolvedValueOnce({ base64: "AA" });
    await generateSpeech({
      model: "tts-chatterbox-hd",
      input: "Bonjour.",
      voice: "cloned:abc",
      format: "wav",
    });
    expect(hoisted.invoke).toHaveBeenCalledWith("cloned_voice_handle", {
      id: "abc",
      refresh: false,
    });
    expect(hoisted.mediaBinary.mock.calls[0][1]).toMatchObject({
      voice: "vv_fresh",
      response_format: "wav",
    });
  });

  it("remints once when the backend says the handle is gone", async () => {
    hoisted.invoke.mockResolvedValueOnce("vv_old").mockResolvedValueOnce("vv_new");
    hoisted.mediaBinary
      .mockRejectedValueOnce(new MediaError("gone", { status: 404, code: "VOICE_EXPIRED" }))
      .mockResolvedValueOnce({ base64: "AA" });
    await generateSpeech({ model: "tts-chatterbox-hd", input: "Bonjour.", voice: "cloned:abc" });
    expect(hoisted.invoke).toHaveBeenLastCalledWith("cloned_voice_handle", {
      id: "abc",
      refresh: true,
    });
    expect(hoisted.mediaBinary.mock.calls[1][1]).toMatchObject({ voice: "vv_new" });
  });

  it("does not retry any other failure, which may have been paid for", async () => {
    hoisted.invoke.mockResolvedValueOnce("vv_old");
    hoisted.mediaBinary.mockRejectedValueOnce(new MediaError("busy", { status: 503 }));
    await expect(
      generateSpeech({ model: "tts-chatterbox-hd", input: "Bonjour.", voice: "cloned:abc" }),
    ).rejects.toThrow("busy");
    expect(hoisted.mediaBinary).toHaveBeenCalledTimes(1);
  });

  it("leaves a named voice alone", async () => {
    hoisted.mediaBinary.mockResolvedValueOnce({ base64: "AA" });
    await generateSpeech({ model: "tts-kokoro", input: "Hi.", voice: "af_sky" });
    expect(hoisted.invoke).not.toHaveBeenCalled();
    expect(hoisted.mediaBinary.mock.calls[0][1]).toMatchObject({ voice: "af_sky" });
  });
});

describe("casting a cloned voice", () => {
  it("speaks the character on the cloning engine with their own voice", () => {
    const catalog: MediaCatalog = { backend: "carpe-diem", models: [kokoro, chatterbox] };
    const cast = castVoice(
      catalog,
      kokoro,
      { artifactId: "nera-own.wav", label: "cloned:abc" },
      new Map([["nera-own.wav", "tts-chatterbox-hd"]]),
    );
    expect(cast).toMatchObject({ voice: "cloned:abc", lost: false });
    expect(cast.model.id).toBe("tts-chatterbox-hd");
  });
});
