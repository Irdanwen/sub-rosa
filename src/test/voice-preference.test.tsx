// One read-aloud voice (src/lib/voice-preference.ts): chosen in Settings on
// either shell, honoured by every reader, and never a choice the catalog no
// longer offers.

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceSettingsGroup } from "../components/mobile/VoiceSettingsGroup";
import { VoiceSettingsCard } from "../components/settings/VoiceSettingsCard";
import { noteSpeechUrl } from "../lib/note-speech";
import { createReplySpeechPlayer, type SpeechAudio } from "../lib/reply-speech";
import type { MediaModel } from "../lib/studio/types";
import {
  readVoicePreference,
  renderPreferredSpeech,
  resetVoicePreferenceForTests,
  resolveSpeechVoice,
  setVoicePreference,
  voicePreferenceKey,
} from "../lib/voice-preference";

const ENGINES: MediaModel[] = [
  {
    id: "kokoro",
    mediaType: "tts",
    name: "Kokoro",
    offline: false,
    voices: ["af_sky", "am_adam", "ff_siwis"],
    constraints: { default_voice: "af_sky", supported_formats: ["mp3"] },
    pricing: { input: { usd: 0.001 } },
  },
  {
    id: "chatterbox-hd",
    mediaType: "tts",
    name: "Chatterbox HD",
    offline: false,
    voices: ["Aurora", "Blade"],
    constraints: { default_voice: "Aurora", supported_formats: ["wav"] },
    pricing: { input: { usd: 0.01 } },
  },
  // A queued engine takes minutes: never offered to read aloud.
  { id: "elevenlabs-tts-v3", mediaType: "music", name: "ElevenLabs", offline: false },
];

const speech = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("../lib/studio/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/catalog")>()),
  fetchMediaCatalog: async () => ({ backend: "carpe-diem", models: ENGINES }),
}));
vi.mock("../lib/studio/speech", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/speech")>()),
  generateSpeech: speech.generate,
}));
vi.mock("../lib/haptics", () => ({
  hapticImpact: vi.fn(),
  hapticNotify: vi.fn(),
  hapticSelection: vi.fn(),
}));

class FakeAudio implements SpeechAudio {
  src = "";
  async play() {}
  pause() {}
  addEventListener() {}
}

beforeEach(() => {
  localStorage.clear();
  resetVoicePreferenceForTests();
  speech.generate.mockReset();
  speech.generate.mockResolvedValue({ base64: btoa("sound"), contentType: "audio/mpeg" });
  URL.createObjectURL = vi.fn(() => `blob:${speech.generate.mock.calls.length}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the read-aloud voice", () => {
  it("reads with the chosen engine and voice, and falls back when the catalog drops them", () => {
    expect(resolveSpeechVoice(ENGINES, {})).toMatchObject({
      engine: { id: "kokoro" },
      voice: "af_sky",
      format: "mp3",
    });
    expect(resolveSpeechVoice(ENGINES, { model: "chatterbox-hd", voice: "Blade" })).toMatchObject({
      engine: { id: "chatterbox-hd" },
      voice: "Blade",
      format: "wav",
    });
    // An engine gone from the catalog, or a voice it no longer has.
    expect(resolveSpeechVoice(ENGINES, { model: "retired", voice: "Blade" })).toMatchObject({
      engine: { id: "kokoro" },
      voice: "af_sky",
    });
    expect(resolveSpeechVoice(ENGINES, { model: "elevenlabs-tts-v3" })?.engine.id).toBe("kokoro");
  });

  it("is kept on this device and survives a reload", () => {
    setVoicePreference({ model: "kokoro", voice: "ff_siwis" });
    resetVoicePreferenceForTests();
    expect(readVoicePreference()).toEqual({ model: "kokoro", voice: "ff_siwis" });
    expect(voicePreferenceKey()).toBe("kokoro|ff_siwis");
  });

  it("is what both a reply and a note are read with", async () => {
    setVoicePreference({ model: "kokoro", voice: "am_adam" });
    await renderPreferredSpeech("A reply.");
    await noteSpeechUrl("note-1", "A note worth hearing.");
    expect(speech.generate).toHaveBeenCalledTimes(2);
    for (const [request] of speech.generate.mock.calls) {
      expect(request).toMatchObject({ model: "kokoro", voice: "am_adam", format: "mp3" });
    }
  });

  it("sends no voice when none was chosen, so the engine reads in its own", async () => {
    await renderPreferredSpeech("A reply.");
    expect(speech.generate.mock.calls[0]?.[0]).toMatchObject({ model: "kokoro", voice: undefined });
  });

  it("does not replay a reply rendered in another voice", async () => {
    const renderChunk = vi.fn(async (text: string) => `url:${text}`);
    const player = createReplySpeechPlayer({
      render: renderChunk,
      createAudio: () => new FakeAudio(),
      voiceKey: () => voicePreferenceKey(),
    });
    await act(() => player.play("reply", "Short reply."));
    player.stop();
    await act(() => player.play("reply", "Short reply."));
    expect(renderChunk).toHaveBeenCalledTimes(1);

    setVoicePreference({ model: "kokoro", voice: "am_adam" });
    player.stop();
    await act(() => player.play("reply", "Short reply."));
    expect(renderChunk).toHaveBeenCalledTimes(2);
  });
});

describe("choosing the voice in Settings", () => {
  it("on the desktop: an engine, one of its voices, and a preview in that voice", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const user = userEvent.setup();
    render(<VoiceSettingsCard />);

    const engine = await screen.findByRole("combobox", { name: "Voice engine" });
    await waitFor(() => expect(engine).toHaveValue("kokoro"));
    // The queued engine is not offered.
    expect(within(engine).queryByRole("option", { name: "ElevenLabs" })).toBeNull();

    await user.selectOptions(engine, "chatterbox-hd");
    expect(readVoicePreference()).toEqual({ model: "chatterbox-hd" });
    const voice = screen.getByRole("combobox", { name: "Voice" });
    expect(voice).toHaveValue("Aurora");
    await user.selectOptions(voice, "Blade");
    expect(readVoicePreference()).toEqual({ model: "chatterbox-hd", voice: "Blade" });

    await user.click(screen.getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(speech.generate.mock.calls[0]?.[0]).toMatchObject({
      model: "chatterbox-hd",
      voice: "Blade",
    });
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("on the phone: the same choice, from sheets", async () => {
    const user = userEvent.setup();
    render(<VoiceSettingsGroup />);

    await user.click(await screen.findByRole("button", { name: /Voice engine/ }));
    await user.click(screen.getByRole("button", { name: "Chatterbox HD" }));
    expect(readVoicePreference()).toEqual({ model: "chatterbox-hd" });

    await user.click(screen.getByRole("button", { name: /^Voice\s*Aurora/ }));
    await user.click(screen.getByRole("button", { name: "Blade" }));
    expect(readVoicePreference()).toEqual({ model: "chatterbox-hd", voice: "Blade" });
    expect(screen.getByRole("button", { name: "Listen to a preview" })).toBeInTheDocument();
  });
});
