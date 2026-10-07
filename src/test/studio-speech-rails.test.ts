// The two speech rails (ADR-0076): what each speaking model accepts, the
// queue body built from it, and the price shown before a narration is sent.
// Models come from the captured catalog (fixtures/audio-catalog.ts).

import { describe, expect, it } from "vitest";
import { estimateCostCredits, speechModels } from "../lib/studio/catalog";
import {
  acceptedSpeed,
  acceptedVoice,
  defaultSpeechModel,
  insertTag,
  isProviderVoiceId,
  queuedSpeechJob,
  speechCapabilities,
  speechQueueBody,
} from "../lib/studio/speech";
import type { MediaModel } from "../lib/studio/types";
import { audioCatalog } from "./fixtures/audio-catalog";

function byId(id: string): MediaModel {
  const model = audioCatalog.models.find((entry) => entry.id === id);
  if (!model) throw new Error(`missing fixture ${id}`);
  return model;
}

describe("what a speaking model accepts", () => {
  it("keeps the one-call rail's own controls for a tts model", () => {
    const caps = speechCapabilities(byId("tts-kokoro"));
    expect(caps).toMatchObject({ rail: "speech", customVoiceId: false, audioTags: false });
    expect(caps.formats).toEqual(["mp3", "wav", "flac"]);
    expect(caps.speed).toMatchObject({ min: 0.25, max: 4 });
  });

  it("reads the queue models' voices, Voice ID, speed bounds and tags", () => {
    const v2 = speechCapabilities(byId("elevenlabs-tts-multilingual-v2"));
    expect(v2).toMatchObject({ rail: "queue", customVoiceId: true, audioTags: false });
    expect(v2.speed).toMatchObject({ min: 0.7, max: 1.2, default: 1 });
    expect(v2.formats).toEqual([]);
    expect(v2.defaultVoice).toBe("Aria");

    const v4 = speechCapabilities(byId("elevenlabs-tts-v4"));
    expect(v4).toMatchObject({ rail: "queue", customVoiceId: true, audioTags: true });
    expect(v4.speed).toBeUndefined();

    const seed = speechCapabilities(byId("seed-audio-1-0"));
    expect(seed).toMatchObject({ rail: "queue", customVoiceId: false, audioTags: false });
    expect(seed.speed).toMatchObject({ min: 0.5, max: 2 });
    expect(seed.inputLimit).toBe(3000);
  });
});

describe("the queue body", () => {
  it("sends the text as the prompt, a listed voice, and a speed only off its default", () => {
    const model = byId("elevenlabs-tts-multilingual-v2");
    const caps = speechCapabilities(model);
    expect(speechQueueBody(caps, { model, text: " Bonjour. ", voice: "Roger", speed: 1 })).toEqual({
      model: "elevenlabs-tts-multilingual-v2",
      prompt: "Bonjour.",
      voice: "Roger",
    });
    expect(speechQueueBody(caps, { model, text: "Vite.", speed: 3 })).toMatchObject({
      voice: "Aria",
      speed: 1.2,
    });
  });

  it("never sends a speed to a model that takes none", () => {
    const model = byId("elevenlabs-tts-v4");
    const caps = speechCapabilities(model);
    expect(acceptedSpeed(caps, 1.5)).toBeUndefined();
    expect(speechQueueBody(caps, { model, text: "Hi.", speed: 1.5 })).not.toHaveProperty("speed");
  });

  it("takes a provider Voice ID where the model does, never a name from another model", () => {
    const caps = speechCapabilities(byId("elevenlabs-tts-v4"));
    expect(isProviderVoiceId("21m00Tcm4TlvDq8ikWAM")).toBe(true);
    expect(acceptedVoice(caps, "21m00Tcm4TlvDq8ikWAM")).toBe("21m00Tcm4TlvDq8ikWAM");
    expect(acceptedVoice(caps, "af_sky")).toBe("Aria");
    // Seed Audio takes no provider id: a pasted one falls back to its default.
    const seed = speechCapabilities(byId("seed-audio-1-0"));
    expect(acceptedVoice(seed, "21m00Tcm4TlvDq8ikWAM")).toBe("Describe in prompt");
  });

  it("is a durable job on the backend's music queue, kept as a voice-over", () => {
    const model = byId("elevenlabs-tts-v4-turbo");
    const caps = speechCapabilities(model);
    const job = queuedSpeechJob({ backend: "carpe-diem" }, caps, { model, text: "Hello." });
    expect(job).toMatchObject({
      kind: "speech",
      extension: "mp3",
      queuePath: "/audio/music/queue",
    });
    expect(job.retrieve("q1")).toMatchObject({ path: "/audio/music/retrieve" });
    const venice = queuedSpeechJob({ backend: "venice" }, caps, { model, text: "Hello." });
    expect(venice.queuePath).toBe("/audio/queue");
  });
});

describe("expression tags", () => {
  it("inserts a tag with the spaces it needs", () => {
    expect(insertTag("Hello there", "[whispers]", 5)).toEqual({
      text: "Hello [whispers] there",
      caret: 16,
    });
    expect(insertTag("", "[laughs]", 0)).toEqual({ text: "[laughs]", caret: 8 });
  });
});

describe("the price of a narration", () => {
  const priced = (pricing: Record<string, unknown>, mediaType: MediaModel["mediaType"] = "music") =>
    ({ id: "m", name: "m", mediaType, offline: false, pricing }) as MediaModel;

  it("prices per thousand characters, per second and per million characters", () => {
    expect(
      estimateCostCredits(priced({ per_thousand_characters: { usd: 0.092 } }), {
        characters: 2000,
        multiplier: 0.5,
      }),
    ).toBe(9.2);
    expect(
      estimateCostCredits(priced({ per_second: { usd: 0.002875 } }), { durationSeconds: 40 }),
    ).toBe(11.5);
    expect(
      estimateCostCredits(priced({ input: { usd: 3.5 } }, "tts"), { characters: 100_000 }),
    ).toBe(35);
  });
});

describe("the engine a speech surface opens on", () => {
  it("is the cheapest one-call engine, never the first name in the alphabet", () => {
    // Alphabetically the panel would open on Chatterbox HD (or, with ids for
    // names, on a queued ElevenLabs engine): nobody's choice either way.
    const models = speechModels(audioCatalog);
    expect(models[0].id).not.toBe("tts-kokoro");
    expect(defaultSpeechModel(models)?.id).toBe("tts-kokoro");
  });

  it("falls back to a queued engine when the account has no other", () => {
    const queued = speechModels(audioCatalog).filter((model) => model.mediaType === "music");
    expect(defaultSpeechModel(queued)?.id).toBe(queued[0].id);
  });
});
