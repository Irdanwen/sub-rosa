// The web client's voice conversation (ADR-0093 in a browser): the ports of
// the app's detector, sentence cutter and state machine, with the Rust tests'
// own vectors, and the session's loop run with fake audio, transcription,
// chat, speech and speaker.
import { describe, expect, it, vi } from "vitest";
import type { LiveModel, Operator } from "../../website/src/client/carpe-diem";
import { Engine } from "../../website/src/client/voice/engine";
import { frameFromVideo, frameSize } from "../../website/src/client/voice/frames";
import { fenceLabel } from "../../website/src/client/voice/labels";
import { type Effect, Machine } from "../../website/src/client/voice/machine";
import { Resampler } from "../../website/src/client/voice/resample";
import {
  creditsPerMinute,
  DEFAULT_TRANSCRIPTION_MODEL,
  transcriptionModel,
  turnModel,
} from "../../website/src/client/voice/routing";
import {
  clean,
  MAX_SENTENCE_CHARS,
  newCursor,
  nextSentences,
  type Spoken,
} from "../../website/src/client/voice/sentences";
import {
  type VoiceDeps,
  type VoiceEvent,
  VoiceSession,
} from "../../website/src/client/voice/session";
import { transcribe } from "../../website/src/client/voice/transcribe";
import {
  defaultVadConfig,
  echoCancelledVadConfig,
  FRAME_SAMPLES,
  frameDb,
  SAMPLE_RATE,
  Vad,
  type VadConfig,
  type VadEvent,
} from "../../website/src/client/voice/vad";
import { encodeWav } from "../../website/src/client/voice/wav";

/** A 20 ms frame of a 220 Hz tone at `db` dBFS (RMS), or silence. */
function tone(db: number, phase: { value: number }): Float32Array {
  const frame = new Float32Array(FRAME_SAMPLES);
  if (db <= -90) return frame;
  const amplitude = 10 ** (db / 20) * Math.SQRT2;
  for (let index = 0; index < FRAME_SAMPLES; index++) {
    phase.value += (2 * Math.PI * 220) / SAMPLE_RATE;
    frame[index] = amplitude * Math.sin(phase.value);
  }
  return frame;
}
function run(vad: Vad, db: number, ms: number, playback: number | null = null): VadEvent[] {
  const phase = { value: 0 };
  const events: VadEvent[] = [];
  for (let frame = 0; frame < ms / 20; frame++) {
    const event = vad.pushFrame(tone(db, phase), playback);
    if (event) events.push(event);
  }
  return events;
}
const kinds = (events: VadEvent[]) => events.map((event) => event.kind);

describe("the voice detector (vad.rs)", () => {
  it("measures a frame's RMS", () => {
    expect(Math.abs(frameDb(tone(-20, { value: 0 })) + 20)).toBeLessThan(0.5);
    expect(frameDb(new Float32Array(10))).toBe(-100);
    expect(frameDb([])).toBe(-100);
  });

  it("starts, ends and keeps the first syllable", () => {
    const vad = new Vad();
    expect(run(vad, -70, 1000)).toEqual([]);
    expect(kinds(run(vad, -25, 1200))).toEqual(["speechStarted"]);
    expect(vad.inSpeech()).toBe(true);
    const ended = run(vad, -70, 1000);
    expect(kinds(ended)).toEqual(["utteranceEnded"]);
    const seconds = (ended[0] as { samples: Float32Array }).samples.length / SAMPLE_RATE;
    expect(seconds).toBeGreaterThanOrEqual(1.4);
    expect(seconds).toBeLessThan(1.9);
    expect(vad.inSpeech()).toBe(false);
  });

  it("keeps a sentence whole across a short pause", () => {
    const vad = new Vad();
    run(vad, -70, 500);
    const events = [
      ...run(vad, -25, 800),
      ...run(vad, -70, 400),
      ...run(vad, -25, 800),
      ...run(vad, -70, 900),
    ];
    expect(kinds(events)).toEqual(["speechStarted", "utteranceEnded"]);
  });

  it("ignores a click and discards a cough", () => {
    const vad = new Vad();
    run(vad, -70, 500);
    expect(run(vad, -20, 60)).toEqual([]);
    expect(run(vad, -70, 500)).toEqual([]);
    expect(kinds([...run(vad, -20, 200), ...run(vad, -70, 900)])).toEqual([
      "speechStarted",
      "utteranceDiscarded",
    ]);
  });

  it("learns a steady noise as the floor", () => {
    const vad = new Vad();
    expect(run(vad, -42, 400)[0]?.kind).toBe("speechStarted");
    expect(kinds(run(vad, -42, 2000))).toEqual(["utteranceDiscarded"]);
    expect(vad.thresholdDb(null)).toBeGreaterThan(-42);
    expect(run(vad, -42, 2000)).toEqual([]);
    expect(kinds(run(vad, -20, 400))).toEqual(["speechStarted"]);
  });

  it("lets a voice over the reply barge in, not the reply's echo", () => {
    const vad = new Vad();
    run(vad, -70, 500);
    expect(run(vad, -26, 2000, -20)).toEqual([]);
    expect(kinds(run(vad, -14, 400, -20))).toEqual(["speechStarted"]);
  });

  it("with echo cancellation, a normal voice barges in", () => {
    const vad = new Vad(echoCancelledVadConfig());
    run(vad, -70, 500);
    expect(run(vad, -50, 1000, -20)).toEqual([]);
    expect(kinds(run(vad, -30, 400, -20))).toEqual(["speechStarted"]);
    const raw = new Vad(defaultVadConfig());
    run(raw, -70, 500);
    expect(run(raw, -30, 400, -20)).toEqual([]);
  });

  it("cuts a monologue at the maximum", () => {
    const config: VadConfig = { ...defaultVadConfig(), maxUtteranceMs: 2000 };
    const vad = new Vad(config);
    run(vad, -70, 500);
    expect(kinds(run(vad, -25, 3000)).slice(0, 2)).toEqual(["speechStarted", "utteranceEnded"]);
  });
});

function texts(spoken: Spoken[]): string[] {
  return spoken.map((unit) => (unit.kind === "text" ? unit.text : `<fence ${unit.info}>`));
}
function streamed(reply: string, step: number): string[] {
  const cursor = newCursor();
  const chars = Array.from(reply);
  const out: string[] = [];
  let end = 0;
  while (end < chars.length) {
    end = Math.min(end + step, chars.length);
    out.push(...texts(nextSentences(chars.slice(0, end).join(""), cursor, false)));
  }
  out.push(...texts(nextSentences(reply, cursor, true)));
  return out;
}

describe("the sentence cutter (sentences.rs)", () => {
  it("hands a sentence out as soon as it completes", () => {
    const cursor = newCursor();
    expect(nextSentences("The weather in Geneva is", cursor, false)).toEqual([]);
    expect(
      texts(nextSentences("The weather in Geneva is mild today. Expect", cursor, false)),
    ).toEqual(["The weather in Geneva is mild today."]);
    expect(
      texts(nextSentences("The weather in Geneva is mild today. Expect rain", cursor, true)),
    ).toEqual(["Expect rain"]);
  });

  it("holds short sentences for the next one", () => {
    expect(streamed("Sure. Here is the plan for tomorrow morning. Bye.", 3)).toEqual([
      "Sure. Here is the plan for tomorrow morning.",
      "Bye.",
    ]);
  });

  it("does not depend on how the stream was cut", () => {
    const reply =
      "First, the good news: it works. Second, the bad news is that it costs more than planned. Third? We wait!\n\nA new paragraph starts here.";
    const whole = streamed(reply, reply.length);
    for (const step of [1, 2, 5, 17]) expect(streamed(reply, step)).toEqual(whole);
    expect(whole).toHaveLength(4);
  });

  it("reads markdown as words", () => {
    expect(
      streamed(
        "## Your **three** options\n\n- Take the [train](https://sbb.ch) at `8:02`.\n- Drive, which takes _longer_ than you think.\n",
        4,
      ),
    ).toEqual([
      "Your three options",
      "Take the train at 8:02.",
      "Drive, which takes longer than you think.",
    ]);
  });

  it("names a fenced block once and skips it", () => {
    const reply =
      "Here is the script you asked for:\n```python\nprint('hi.')\nprint('there.')\n```\nRun it twice to be sure it works.";
    for (const step of [1, 3, 50])
      expect(streamed(reply, step)).toEqual([
        "Here is the script you asked for:",
        "<fence python>",
        "Run it twice to be sure it works.",
      ]);
  });

  it("drops an unclosed fence at the end", () => {
    const cursor = newCursor();
    expect(
      texts(
        nextSentences(
          'Look at this card, it lists them all.\n```subrosa:places\n{"places": [',
          cursor,
          true,
        ),
      ),
    ).toEqual(["Look at this card, it lists them all.", "<fence subrosa:places>"]);
  });

  it("does not end a sentence on an abbreviation or a decimal", () => {
    expect(
      streamed("Bring fruit, e.g. apples, and pay 3.50 francs to Dr. Rossi tonight. Done.", 2),
    ).toEqual(["Bring fruit, e.g. apples, and pay 3.50 francs to Dr. Rossi tonight.", "Done."]);
  });

  it("cuts a run-on at a comma", () => {
    const long = `${"word ".repeat(60)}, and then it keeps going`;
    const out = streamed(long, 7);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.every((part) => Array.from(part).length <= MAX_SENTENCE_CHARS)).toBe(true);
    expect(out.join(" ").split(/\s+/).filter(Boolean)).toHaveLength(
      long.split(/\s+/).filter(Boolean).length,
    );
  });

  it("survives a retraction of unspoken text", () => {
    const cursor = newCursor();
    expect(
      nextSentences("This first sentence is long enough. And a draft that", cursor, false),
    ).toHaveLength(1);
    expect(nextSentences("This first sentence is long enough. And a", cursor, false)).toEqual([]);
    expect(
      texts(
        nextSentences("This first sentence is long enough. And a better ending.", cursor, true),
      ),
    ).toEqual(["And a better ending."]);
    expect(nextSentences("This", cursor, true)).toEqual([]);
  });

  it("reads a table cell by cell", () => {
    expect(clean("| City | Rain |\n| --- | --- |\n| Geneva | 3 mm |")).toBe(
      "City, Rain Geneva, 3 mm",
    );
    expect(clean("1. First step")).toBe("First step");
    expect(clean("> quoted *line*")).toBe("quoted line");
    expect(clean("keep snake_case and a<br>break")).toBe("keep snake_case and a break");
    expect(clean("![chart](x.png) Sales grew")).toBe("Sales grew");
  });
});

const TWO = "The first sentence is right here. The second one follows it now.";
const label = (info: string) => `[${info}]`;
const renders = (effects: Effect[]) =>
  effects.flatMap((effect) => (effect.kind === "render" ? [effect.index] : []));
function say(machine: Machine, utterance: number, text: string): number {
  machine.handle({ kind: "speechStarted" });
  machine.handle({ kind: "utteranceEnded", utterance });
  const sent = machine
    .handle({ kind: "transcribed", utterance, text })
    .find((effect) => effect.kind === "sendTurn");
  if (sent?.kind !== "sendTurn") throw new Error("no turn sent");
  return sent.turn;
}

describe("the voice state machine (machine.rs)", () => {
  it("goes round the loop", () => {
    const m = new Machine(label);
    expect(m.handle({ kind: "speechStarted" })).toEqual([]);
    expect(m.handle({ kind: "utteranceEnded", utterance: 1 })).toEqual([
      { kind: "transcribe", utterance: 1 },
      { kind: "phase", phase: "transcribing" },
    ]);
    expect(m.handle({ kind: "transcribed", utterance: 1, text: " What is the weather? " })).toEqual(
      [
        { kind: "heard", text: "What is the weather?" },
        { kind: "sendTurn", turn: 1, text: "What is the weather?" },
        { kind: "phase", phase: "thinking" },
      ],
    );
    expect(renders(m.handle({ kind: "reply", turn: 1, text: TWO, done: true }))).toEqual([0, 1]);
    expect(m.handle({ kind: "rendered", turn: 1, index: 0 })).toContainEqual({
      kind: "play",
      turn: 1,
      index: 0,
    });
    m.handle({ kind: "rendered", turn: 1, index: 1 });
    expect(m.handle({ kind: "playbackFinished", turn: 1, index: 0 })).toContainEqual({
      kind: "play",
      turn: 1,
      index: 1,
    });
    expect(m.handle({ kind: "playbackFinished", turn: 1, index: 1 })).toEqual([
      { kind: "phase", phase: "listening" },
    ]);
    expect(m.awaiting()).toBeNull();
  });

  it("renders one sentence ahead of playback, no more", () => {
    const m = new Machine(label);
    const turn = say(m, 1, "Read me a story");
    const story =
      "Once upon a time there was a fox. It lived in a deep dark wood. Every night it went looking for food. One night it found a farm. ";
    expect(renders(m.handle({ kind: "reply", turn, text: story, done: false }))).toEqual([0, 1]);
    expect(renders(m.handle({ kind: "rendered", turn, index: 1 }))).toEqual([]);
    expect(m.handle({ kind: "rendered", turn, index: 0 })).toContainEqual({
      kind: "play",
      turn,
      index: 0,
    });
    const effects = m.handle({ kind: "playbackFinished", turn, index: 0 });
    expect(renders(effects)).toEqual([2]);
    expect(effects).toContainEqual({ kind: "play", turn, index: 1 });
  });

  it("barges in: the speaker first, then the turn, and drops what was in flight", () => {
    const m = new Machine(label);
    const turn = say(m, 1, "Tell me everything");
    m.handle({ kind: "reply", turn, text: TWO, done: false });
    m.handle({ kind: "rendered", turn, index: 0 });
    expect(m.phase()).toBe("speaking");
    expect(m.handle({ kind: "speechStarted" })).toEqual([
      { kind: "stopPlayback" },
      { kind: "cancelTurn", turn },
      { kind: "phase", phase: "listening" },
    ]);
    expect(m.handle({ kind: "rendered", turn, index: 1 })).toEqual([]);
    expect(m.handle({ kind: "playbackFinished", turn, index: 0 })).toEqual([]);
    expect(m.handle({ kind: "reply", turn, text: `${TWO} And more.`, done: true })).toEqual([]);
    m.handle({ kind: "utteranceEnded", utterance: 2 });
    expect(
      m.handle({ kind: "transcribed", utterance: 2, text: "Actually, just the summary" }),
    ).toContainEqual({ kind: "sendTurn", turn: turn + 1, text: "Actually, just the summary" });
  });

  it("joins words said during a transcription into one turn", () => {
    const m = new Machine(label);
    m.handle({ kind: "speechStarted" });
    m.handle({ kind: "utteranceEnded", utterance: 1 });
    expect(m.handle({ kind: "speechStarted" })).toEqual([{ kind: "phase", phase: "listening" }]);
    expect(
      m
        .handle({ kind: "transcribed", utterance: 1, text: "Book a table" })
        .some((effect) => effect.kind === "sendTurn"),
    ).toBe(false);
    m.handle({ kind: "utteranceEnded", utterance: 2 });
    expect(
      m.handle({ kind: "transcribed", utterance: 2, text: "for two at eight" }),
    ).toContainEqual({ kind: "sendTurn", turn: 1, text: "Book a table for two at eight" });
  });

  it("returns to listening after silence and failures, and names a card", () => {
    const m = new Machine(label);
    m.handle({ kind: "speechStarted" });
    m.handle({ kind: "utteranceEnded", utterance: 1 });
    expect(m.handle({ kind: "transcribed", utterance: 1, text: "  " })).toEqual([
      { kind: "notice", notice: "nothingHeard" },
      { kind: "phase", phase: "listening" },
    ]);
    const turn = say(m, 2, "Where should we eat");
    const spoken = m
      .handle({
        kind: "reply",
        turn,
        text: "Here are three places near you:\n```subrosa:places\n{}\n```\n",
        done: true,
      })
      .flatMap((effect) => (effect.kind === "render" ? [effect.text] : []));
    expect(spoken).toEqual(["Here are three places near you:", "[subrosa:places]"]);
  });
});

describe("the voice session in the page", () => {
  function world() {
    const events: VoiceEvent[] = [];
    const sent: string[] = [];
    const rendered: string[] = [];
    const turns: {
      signal: AbortSignal;
      onReply: (text: string) => void;
      finish: (text: string) => void;
    }[] = [];
    const played: ArrayBuffer[] = [];
    let playing: (() => void) | null = null;
    let refusal: string | null = null;
    const deps: VoiceDeps = {
      transcribe: async (samples) => (samples.length > 0 ? "What is the weather?" : ""),
      sendTurn: (text, onReply, signal) =>
        new Promise<string>((resolve) => {
          sent.push(text);
          turns.push({ signal, onReply, finish: resolve });
        }),
      render: async (text) => {
        rendered.push(text);
        return new TextEncoder().encode(text).buffer as ArrayBuffer;
      },
      player: {
        play: (clip) =>
          new Promise<void>((resolve) => {
            played.push(clip);
            playing = resolve;
          }),
        stop: () => {
          playing?.();
          playing = null;
        },
        levelDb: () => (playing ? -20 : null),
      },
      refusal: () => refusal,
      fenceLabel,
      onEvent: (event) => events.push(event),
    };
    const session = new VoiceSession(deps);
    const speak = (db: number, ms: number) => {
      const phase = { value: 0 };
      for (let frame = 0; frame < ms / 20; frame++) session.pushAudio(tone(db, phase));
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return {
      session,
      events,
      sent,
      rendered,
      turns,
      played,
      speak,
      settle,
      finishPlayback: () => {
        const done = playing;
        playing = null;
        done?.();
      },
      refuse: (reason: string) => {
        refusal = reason;
      },
    };
  }

  it("hears, sends the turn, reads the reply and drops it all on a barge-in", async () => {
    const w = world();
    w.speak(-70, 500);
    w.speak(-25, 1200);
    w.speak(-70, 1000);
    await w.settle();
    expect(w.sent).toEqual(["What is the weather?"]);
    w.turns[0].onReply(`${TWO} `);
    await w.settle();
    expect(w.rendered).toEqual([
      "The first sentence is right here.",
      "The second one follows it now.",
    ]);
    await w.settle();
    expect(w.played).toHaveLength(1);
    expect(w.events).toContainEqual({ kind: "phase", phase: "speaking" });
    // The person talks over the reply, louder than its echo.
    w.speak(-10, 400);
    await w.settle();
    expect(w.turns[0].signal.aborted).toBe(true);
    expect(w.events.at(-1)).toEqual({ kind: "phase", phase: "listening" });
    // What was in flight for that turn is never played.
    w.turns[0].finish(TWO);
    await w.settle();
    expect(w.played).toHaveLength(1);
  });

  it("ends with protected mode's reason when voice is switched off mid conversation", async () => {
    const w = world();
    w.speak(-70, 500);
    w.refuse("Protected mode turned off voice conversations.");
    w.speak(-25, 1200);
    w.speak(-70, 1000);
    await w.settle();
    expect(w.sent).toEqual([]);
    expect(w.events.at(-1)).toEqual({
      kind: "ended",
      reason: "Protected mode turned off voice conversations.",
    });
    expect(w.session.active).toBe(false);
  });

  it("the engine drops a half-heard utterance when muted", () => {
    const engine = new Engine(defaultVadConfig(), label);
    const phase = { value: 0 };
    const feed = (db: number, ms: number) => {
      const effects: Effect[] = [];
      for (let frame = 0; frame < ms / 20; frame++)
        effects.push(...engine.pushAudio(tone(db, phase), null));
      return effects;
    };
    feed(-70, 500);
    feed(-25, 600);
    engine.setMuted(true);
    expect(feed(-25, 400)).toEqual([]);
    engine.setMuted(false);
    // What was said before the tap is never transcribed after it.
    expect(feed(-70, 1000).some((effect) => effect.kind === "transcribe")).toBe(false);
  });
});

describe("audio and pictures", () => {
  it("writes a 16-bit mono WAV", () => {
    const wav = encodeWav([0, 1, -1, 0.5], 16000);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
  });

  it("resamples 48 kHz to 16 kHz across blocks without a seam", () => {
    const resampler = new Resampler(48000, 16000);
    const input = Float32Array.from({ length: 960 }, (_, index) => index);
    const out = [...resampler.process(input.slice(0, 480)), ...resampler.process(input.slice(480))];
    expect(out).toHaveLength(320);
    for (let index = 1; index < out.length; index++)
      expect(out[index] - out[index - 1]).toBeCloseTo(3);
  });

  it("draws a frame no longer than 1600 px as a JPEG", () => {
    expect(frameSize(3200, 1800)).toEqual({ width: 1600, height: 900 });
    expect(frameSize(800, 600)).toEqual({ width: 800, height: 600 });
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toDataURL: (type: string, quality: number) => `data:${type};q=${quality}`,
    } as unknown as HTMLCanvasElement;
    const video = { videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;
    expect(frameFromVideo(video, () => canvas)).toBe("data:image/jpeg;q=0.8");
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1600, 900);
    expect(frameFromVideo({ videoWidth: 0, videoHeight: 0 } as HTMLVideoElement)).toBeNull();
  });

  it("routes a turn with a picture to a model that can see", () => {
    const live = [
      { id: "text-only", type: "text", supportsVision: false },
      { id: "sees", type: "text", supportsVision: true },
    ] as LiveModel[];
    const offered = [{ id: "text-only" }, { id: "sees" }];
    expect(turnModel("text-only", offered, live, false)).toBe("text-only");
    expect(turnModel("text-only", offered, live, true)).toBe("sees");
    expect(turnModel("sees", offered, live, true)).toBe("sees");
    expect(turnModel("text-only", [{ id: "text-only" }], live, true)).toBe("text-only");
  });

  it("picks the app's transcription model and prices a minute", () => {
    expect(transcriptionModel([])).toBe(DEFAULT_TRANSCRIPTION_MODEL);
    expect(
      transcriptionModel([{ id: "openai/whisper-large-v3", type: "asr" }] as LiveModel[]),
    ).toBe("openai/whisper-large-v3");
    const prices = [
      { model: "tts-kokoro", inputPrice: 2 },
      { model: DEFAULT_TRANSCRIPTION_MODEL, inputPrice: 0.006 },
    ];
    // 450 characters at $2 a million, half a minute at $0.006 a minute.
    expect(creditsPerMinute(prices, "tts-kokoro", DEFAULT_TRANSCRIPTION_MODEL)).toBeCloseTo(
      0.39,
      2,
    );
    expect(creditsPerMinute(prices, "tts-other", DEFAULT_TRANSCRIPTION_MODEL)).toBeNull();
  });

  it("sends an utterance to Carpe Diem's transcription route as a WAV", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const operator: Operator = {
      root: "https://operator.test",
      fetch: async (input, init) => {
        seen = { url: String(input), init: init ?? {} };
        return new Response(JSON.stringify({ text: "Hello there" }), { status: 200 });
      },
    };
    expect(await transcribe(operator, "cdm_test", [0, 0.1], 16000, "model-x")).toBe("Hello there");
    const request = seen as unknown as { url: string; init: RequestInit };
    expect(request.url).toBe("https://operator.test/v1/audio/transcriptions");
    expect(request.init.credentials).toBe("omit");
    const form = request.init.body as FormData;
    expect(form.get("model")).toBe("model-x");
    expect(form.get("response_format")).toBe("json");
    expect((form.get("file") as File).type).toBe("audio/wav");
    operator.fetch = async () => new Response("{}", { status: 400 });
    expect(await transcribe(operator, "cdm_test", [0], 16000, "model-x")).toBe("");
  });

  it("names a card instead of reading it", () => {
    expect(fenceLabel("subrosa:links")).toBe("There are links here.");
    expect(fenceLabel("python")).toBe("There is some code here.");
    expect(fenceLabel("subrosa:quiz")).toBe("There is a card here.");
  });
});
