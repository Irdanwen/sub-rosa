// ADR-0076: an audio model is filed by what it does, read from what it
// publishes, and the queue body carries only keys the model accepts. The
// catalog is the captured one (fixtures/audio-catalog.ts), never invented.

import { describe, expect, it } from "vitest";
import {
  acceptedDuration,
  audioRole,
  defaultVoice,
  modelVoices,
  musicCapabilities,
  musicModels,
  musicQueueBody,
  musicRequestMissing,
  soundEffectsModels,
  speechModels,
  speechRail,
} from "../lib/studio/catalog";
import type { MediaModel } from "../lib/studio/types";
import { audioCatalog } from "./fixtures/audio-catalog";

function byId(id: string): MediaModel {
  const model = audioCatalog.models.find((entry) => entry.id === id);
  if (!model) throw new Error(`missing fixture ${id}`);
  return model;
}

const ids = (models: MediaModel[]) => models.map((model) => model.id).sort();

describe("every audio model has one role", () => {
  it("files the speaking models of the music queue under speech", () => {
    const speech = ids(speechModels(audioCatalog));
    for (const id of [
      "elevenlabs-tts-v4",
      "elevenlabs-tts-v4-turbo",
      "elevenlabs-tts-v3",
      "elevenlabs-tts-multilingual-v2",
      "seed-audio-1-0",
      "tts-kokoro",
      "tts-elevenlabs-turbo-v2-5",
    ]) {
      expect(speech).toContain(id);
    }
    expect(speech).toHaveLength(16);
  });

  it("keeps music and sound effects apart, and neither speaks", () => {
    expect(ids(soundEffectsModels(audioCatalog))).toEqual([
      "elevenlabs-sound-effects-v2",
      "mmaudio-v2-text-to-audio",
      "sonilo-v1-1-sound-effects",
    ]);
    expect(ids(musicModels(audioCatalog))).toEqual([
      "ace-step-15",
      "elevenlabs-music",
      "elevenlabs-music-v2",
      "elevenlabs-music-v2-5",
      "lyria-3-pro",
      "minimax-music-v2",
      "minimax-music-v25",
      "minimax-music-v26",
      "sonilo-v1-1-music",
      "stable-audio-25",
    ]);
  });

  it("gives every one of the 29 models exactly one role", () => {
    const roles = audioCatalog.models.map(audioRole);
    expect(roles.every((role) => role !== undefined)).toBe(true);
    expect(
      speechModels(audioCatalog).length +
        musicModels(audioCatalog).length +
        soundEffectsModels(audioCatalog).length,
    ).toBe(audioCatalog.models.length);
  });

  it("reaches a speaking model on the rail that serves it", () => {
    expect(speechRail(byId("tts-kokoro"))).toBe("speech");
    expect(speechRail(byId("elevenlabs-tts-v4"))).toBe("queue");
    expect(speechRail(byId("seed-audio-1-0"))).toBe("queue");
  });

  it("reads voices wherever the catalog carries them", () => {
    expect(modelVoices(byId("tts-kokoro")).length).toBeGreaterThan(50);
    expect(modelVoices(byId("elevenlabs-tts-v4"))).toContain("Aria");
    expect(defaultVoice(byId("elevenlabs-tts-v4"))).toBe("Aria");
    expect(defaultVoice(byId("seed-audio-1-0"))).toBe("Describe in prompt");
  });
});

describe("the published limits replace the six wrong rules", () => {
  it("lets MiniMax 2.5 and 2.6 go instrumental without lyrics", () => {
    for (const id of ["minimax-music-v25", "minimax-music-v26"]) {
      const caps = musicCapabilities(byId(id));
      expect(caps).toMatchObject({ lyrics: "optional", instrumental: true, published: true });
      expect(musicRequestMissing(caps, {})).toBeUndefined();
    }
    // Only v2 still needs words.
    expect(musicCapabilities(byId("minimax-music-v2")).lyrics).toBe("required");
  });

  it("never sends ACE-Step the instrumental flag it refuses", () => {
    const caps = musicCapabilities(byId("ace-step-15"));
    expect(caps.instrumental).toBe(false);
    expect(
      musicQueueBody(caps, { model: "ace-step-15", prompt: "Calm piano", instrumental: true }),
    ).toEqual({ model: "ace-step-15", prompt: "Calm piano", duration_seconds: 60 });
  });

  it("offers no lyrics to Sonilo or Seed Audio", () => {
    expect(musicCapabilities(byId("sonilo-v1-1-music")).lyrics).toBe("none");
    expect(musicCapabilities(byId("seed-audio-1-0")).lyrics).toBe("none");
  });

  it("reads each length range as published", () => {
    expect(musicCapabilities(byId("sonilo-v1-1-sound-effects")).durationSeconds?.max).toBe(180);
    expect(musicCapabilities(byId("stable-audio-25")).durationSeconds?.max).toBe(190);
    expect(musicCapabilities(byId("elevenlabs-music")).durationSeconds).toMatchObject({
      min: 3,
      max: 600,
    });
    // A model that publishes no length takes none.
    expect(musicCapabilities(byId("minimax-music-v26")).durationSeconds).toBeUndefined();
    expect(musicCapabilities(byId("lyria-3-pro")).durationSeconds).toBeUndefined();
  });

  it("tells ElevenLabs Music to stay instrumental even though it takes no lyrics", () => {
    const caps = musicCapabilities(byId("elevenlabs-music-v2-5"));
    expect(
      musicQueueBody(caps, {
        model: "elevenlabs-music-v2-5",
        prompt: "Warm strings",
        instrumental: true,
        lyrics: "ignored",
      }),
    ).toEqual({
      model: "elevenlabs-music-v2-5",
      prompt: "Warm strings",
      force_instrumental: true,
      duration_seconds: 60,
    });
  });

  it("reads an id against the cached catalog, and the fallback table without one", () => {
    // No catalog cached here: the measured table answers, corrected.
    expect(musicCapabilities("minimax-music-v26")).toMatchObject({
      lyrics: "optional",
      instrumental: true,
      published: false,
    });
    expect(musicCapabilities("minimax-music-v2").lyrics).toBe("required");
    expect(musicCapabilities("unknown-engine")).toEqual({
      lyrics: "optional",
      instrumental: false,
      published: false,
    });
  });
});

describe("the queue body", () => {
  it("writes lyrics for you only where the model can, and then sends none", () => {
    const caps = musicCapabilities(byId("minimax-music-v25"));
    expect(caps.lyricsOptimizer).toBe(true);
    expect(
      musicQueueBody(caps, {
        model: "minimax-music-v25",
        prompt: "Disco anthem",
        lyrics: "my own words",
        writeLyrics: true,
      }),
    ).toEqual({ model: "minimax-music-v25", prompt: "Disco anthem", lyrics_optimizer: true });
    const v26 = musicCapabilities(byId("minimax-music-v26"));
    expect(
      musicQueueBody(v26, {
        model: "minimax-music-v26",
        prompt: "Disco anthem",
        writeLyrics: true,
      }),
    ).toEqual({ model: "minimax-music-v26", prompt: "Disco anthem" });
  });

  it("loops only the model that can loop, and leaves an automatic length unsent", () => {
    const caps = musicCapabilities(byId("elevenlabs-sound-effects-v2"));
    expect(caps.loop).toBe(true);
    expect(
      musicQueueBody(caps, {
        model: "elevenlabs-sound-effects-v2",
        prompt: "Rain on glass",
        loop: true,
        autoDuration: true,
      }),
    ).toEqual({ model: "elevenlabs-sound-effects-v2", prompt: "Rain on glass", loop: true });
    const mmaudio = musicCapabilities(byId("mmaudio-v2-text-to-audio"));
    expect(
      musicQueueBody(mmaudio, { model: "mmaudio-v2-text-to-audio", prompt: "Rain", loop: true }),
    ).toEqual({ model: "mmaudio-v2-text-to-audio", prompt: "Rain", duration_seconds: 5 });
  });

  it("snaps a length to the model's list or range", () => {
    const ace = musicCapabilities(byId("ace-step-15"));
    expect(acceptedDuration(ace, 100)).toBe(90);
    expect(acceptedDuration(ace, 500)).toBe(210);
    const eleven = musicCapabilities(byId("elevenlabs-music"));
    expect(acceptedDuration(eleven, 1)).toBe(3);
    expect(acceptedDuration(eleven, undefined)).toBe(60);
    expect(acceptedDuration(musicCapabilities(byId("lyria-3-pro")), 30)).toBeUndefined();
  });
});
