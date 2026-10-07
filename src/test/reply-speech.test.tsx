// "Read aloud" on a reply (src/lib/reply-speech.ts): one reply at a time,
// chunk after chunk with the next one rendered ahead, pressing again stops,
// and a reply heard twice is paid for once.

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  createReplySpeechPlayer,
  type ReplySpeechDeps,
  type SpeechAudio,
} from "../lib/reply-speech";

class FakeAudio implements SpeechAudio {
  src = "";
  played: string[] = [];
  paused = 0;
  private listeners: Record<string, (() => void)[]> = {};
  async play() {
    this.played.push(this.src);
  }
  pause() {
    this.paused += 1;
  }
  addEventListener(type: "ended" | "error", listener: () => void) {
    this.listeners[type] = [...(this.listeners[type] ?? []), listener];
  }
  emit(type: "ended" | "error") {
    for (const listener of this.listeners[type] ?? []) listener();
  }
}

function setup(render: ReplySpeechDeps["render"] = async (text) => `url:${text.slice(0, 12)}`) {
  const audios: FakeAudio[] = [];
  const renderSpy = vi.fn(render);
  const player = createReplySpeechPlayer({
    render: renderSpy,
    createAudio: () => {
      const audio = new FakeAudio();
      audios.push(audio);
      return audio;
    },
  });
  return { player, audios, render: renderSpy };
}

const flush = () => act(async () => {});

/** Long enough for three chunks: a short first one, then full ones. */
const LONG = Array.from({ length: 40 }, (_, i) => `Sentence ${i + 1} is here to be read.`).join(
  " ",
);

describe("the reply reader", () => {
  it("plays the chunks in order, rendering the next one ahead", async () => {
    const { player, audios, render } = setup();
    await act(() => player.play("a", LONG));

    expect(player.getState()).toEqual({ key: "a", status: "playing" });
    const audio = audios[0];
    expect(audio.played).toHaveLength(1);
    // The second chunk was asked for as soon as the first one played.
    expect(render).toHaveBeenCalledTimes(2);

    audio.emit("ended");
    await flush();
    expect(audio.played).toHaveLength(2);
    const chunks = render.mock.calls.length;
    while (player.getState().status !== "idle") {
      audio.emit("ended");
      await flush();
    }
    expect(audio.played.length).toBe(chunks);
    expect(player.getState()).toEqual({ key: null, status: "idle" });
  });

  it("keeps one reply speaking at a time, and a second press stops it", async () => {
    const { player, audios } = setup();
    await act(() => player.play("a", "First reply."));
    await act(() => player.toggle("b", "Second reply."));
    expect(audios[0].paused).toBe(1);
    expect(player.getState()).toEqual({ key: "b", status: "playing" });
    // The first reply's audio ending late changes nothing.
    audios[0].emit("ended");
    expect(player.getState().key).toBe("b");

    await act(() => player.toggle("b", "Second reply."));
    expect(player.getState()).toEqual({ key: null, status: "idle" });
  });

  it("does not pay twice for a reply heard again", async () => {
    const { player, render } = setup();
    await act(() => player.play("a", "Short reply."));
    player.stop();
    await act(() => player.play("a", "Short reply."));
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("says it failed when the speech cannot be rendered", async () => {
    const { player } = setup(async () => {
      throw new Error("offline");
    });
    await act(() => player.play("a", "A reply."));
    expect(player.getState()).toEqual({ key: "a", status: "failed" });
    // An empty reply has nothing to say and changes nothing.
    await act(() => player.play("b", "   "));
    expect(player.getState().key).toBe("a");
  });
});

describe("the read aloud button", () => {
  it("starts and stops the reply it sits on", async () => {
    vi.resetModules();
    const audios: FakeAudio[] = [];
    vi.doMock("../lib/studio/catalog", () => ({
      fetchMediaCatalog: async () => ({}),
      modelsOfType: () => [{ id: "tts-1", name: "TTS" }],
    }));
    vi.doMock("../lib/studio/speech", () => ({
      defaultSpeechModel: (models: { id: string }[]) => models[0],
      speechCapabilities: () => ({ defaultFormat: "mp3" }),
      generateSpeech: vi.fn(async () => ({ base64: btoa("mp3"), contentType: "audio/mpeg" })),
    }));
    vi.stubGlobal(
      "Audio",
      class extends FakeAudio {
        constructor() {
          super();
          audios.push(this);
        }
      },
    );
    URL.createObjectURL = vi.fn(() => "blob:speech");
    const { ReadAloudButton } = await import("../components/chat/ReadAloudButton");
    const speech = await import("../lib/studio/speech");

    render(<ReadAloudButton speechKey="s:1" text="Hello **there**." className="action" />);
    await userEvent.click(screen.getByRole("button", { name: "Read aloud" }));
    await flush();

    expect(speech.generateSpeech).toHaveBeenCalledWith(
      expect.objectContaining({ model: "tts-1", input: "Hello there.", format: "mp3" }),
    );
    expect(audios[0]?.played).toEqual(["blob:speech"]);
    const stop = screen.getByRole("button", { name: "Stop reading" });
    expect(stop).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(stop);
    expect(screen.getByRole("button", { name: "Read aloud" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    vi.unstubAllGlobals();
    vi.doUnmock("../lib/studio/catalog");
    vi.doUnmock("../lib/studio/speech");
  });
});
