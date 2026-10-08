// The webview's half of a voice conversation (src/lib/voice/): it sends the
// turns the Rust loop asks for through the shell's chat, stops them when
// the person talks over the reply, and feeds the reply back as it streams,
// done only once the chat was seen working.

import { describe, expect, it, vi } from "vitest";
import { createVoiceController, TURN_START_GRACE_MS } from "../lib/voice/voice-controller";
import type { VoiceCommands, VoiceEvent, VoiceEventPayload } from "../lib/voice/voice-session";

function setup(options: { send?: (text: string) => Promise<void> } = {}) {
  let handler: ((event: VoiceEventPayload) => void) | null = null;
  const replies: Array<[number, string, boolean]> = [];
  const commands: VoiceCommands = {
    availability: vi.fn(async () => ({ allowed: true, screen: false })),
    start: vi.fn(async () => ({ sessionId: "s1", echoCancelled: true })),
    stop: vi.fn(async () => undefined),
    reply: vi.fn(async (_session, turn, text, done) => {
      replies.push([turn, text, done]);
    }),
    turnFailed: vi.fn(async () => undefined),
    setMuted: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    screenFrame: vi.fn(async () => "/tmp/frame.jpg"),
    listen: vi.fn(async (next) => {
      handler = next;
      return () => {
        handler = null;
      };
    }),
  };
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
  let clock = 0;
  const port = {
    send: vi.fn(options.send ?? (async () => undefined)),
    stop: vi.fn(),
  };
  const controller = createVoiceController({
    commands,
    port,
    now: () => clock,
    schedule: (callback, ms) => {
      const timer = { at: clock + ms, callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const emit = (event: VoiceEvent & { sessionId?: string }) =>
    handler?.({ sessionId: "s1", ...event });
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of timers.filter((entry) => !entry.cancelled && entry.at <= clock)) {
      timer.cancelled = true;
      timer.callback();
    }
  };
  return { controller, commands, port, replies, emit, advance };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the voice controller", () => {
  it("starts listening, then sends a turn and streams its reply back", async () => {
    const { controller, commands, port, replies, emit, advance } = setup();
    controller.updateReply({ key: "m1", text: "Earlier answer.", done: true });
    await controller.start({ model: "tts-kokoro", format: "mp3" });
    expect(commands.listen).toHaveBeenCalledBefore(commands.start as never);
    expect(controller.getState()).toMatchObject({ status: "active", echoCancelled: true });

    emit({ kind: "turn", turn: 1, text: "What is the weather?" });
    expect(port.send).toHaveBeenCalledWith("What is the weather?");
    expect(controller.getState().heard).toBe("What is the weather?");
    await flush();

    // The old reply is not this turn's: nothing goes back yet.
    controller.updateReply({ key: "m1", text: "Earlier answer.", done: true });
    expect(replies).toEqual([]);

    // The new message lands, the chat works, the reply streams.
    controller.updateReply({ key: "m2", text: "", done: false });
    advance(200);
    controller.updateReply({ key: "m2", text: "Sunny", done: false });
    advance(200);
    controller.updateReply({ key: "m2", text: "Sunny and mild.", done: false });
    controller.updateReply({ key: "m2", text: "Sunny and mild.", done: true });
    expect(replies.at(-1)).toEqual([1, "Sunny and mild.", true]);
    expect(replies.filter(([, , done]) => done)).toHaveLength(1);
  });

  it("does not take a moment of idle right after the send for the end", async () => {
    const { controller, replies, emit } = setup();
    controller.updateReply({ key: null, text: "", done: true });
    await controller.start({ model: "m", format: "mp3" });
    emit({ kind: "turn", turn: 1, text: "Hello" });
    // The message is there but the chat has not started working yet.
    controller.updateReply({ key: "m1", text: "", done: true });
    expect(replies).toEqual([]);
    controller.updateReply({ key: "m1", text: "", done: false });
    controller.updateReply({ key: "m1", text: "Hi there.", done: true });
    expect(replies).toEqual([[1, "Hi there.", true]]);
  });

  it("throttles a fast stream and sends the trailing text", async () => {
    const { controller, replies, emit, advance } = setup();
    await controller.start({ model: "m", format: "mp3" });
    emit({ kind: "turn", turn: 1, text: "Tell me" });
    controller.updateReply({ key: "m1", text: "A", done: false });
    controller.updateReply({ key: "m1", text: "AB", done: false });
    controller.updateReply({ key: "m1", text: "ABC", done: false });
    expect(replies).toEqual([[1, "A", false]]);
    advance(150);
    expect(replies).toEqual([
      [1, "A", false],
      [1, "ABC", false],
    ]);
  });

  it("stops the chat turn when the person talks over it", async () => {
    const { controller, port, replies, emit } = setup();
    await controller.start({ model: "m", format: "mp3" });
    emit({ kind: "turn", turn: 1, text: "Tell me everything" });
    controller.updateReply({ key: "m1", text: "Once upon", done: false });
    emit({ kind: "cancel", turn: 1 });
    expect(port.stop).toHaveBeenCalledTimes(1);
    const before = replies.length;
    // What the stopped turn still writes is not fed back.
    controller.updateReply({ key: "m1", text: "Once upon a time", done: true });
    expect(replies).toHaveLength(before);
    // A cancel for another turn is ignored.
    emit({ kind: "cancel", turn: 7 });
    expect(port.stop).toHaveBeenCalledTimes(1);
  });

  it("reports a turn the chat refused, and closes one that never starts", async () => {
    const failing = setup({ send: async () => Promise.reject(new Error("offline")) });
    await failing.controller.start({ model: "m", format: "mp3" });
    failing.emit({ kind: "turn", turn: 1, text: "Hi" });
    await flush();
    expect(failing.commands.turnFailed).toHaveBeenCalledWith("s1", 1);

    const silent = setup();
    await silent.controller.start({ model: "m", format: "mp3" });
    silent.emit({ kind: "turn", turn: 1, text: "Hi" });
    await flush();
    silent.advance(TURN_START_GRACE_MS - 1);
    expect(silent.replies).toEqual([]);
    silent.advance(1);
    expect(silent.replies).toEqual([[1, "", true]]);
  });

  it("shows the session's state and ignores other sessions", async () => {
    const { controller, emit, commands } = setup();
    await controller.start({ model: "m", format: "mp3" });
    emit({ kind: "phase", phase: "speaking" });
    emit({ kind: "caption", role: "assistant", text: "It is sunny." });
    emit({ kind: "level", input: 0.2, output: 0.7 });
    emit({ kind: "notice", notice: "nothingHeard" });
    emit({ kind: "phase", phase: "thinking", sessionId: "other" });
    expect(controller.getState()).toMatchObject({
      phase: "speaking",
      saying: "It is sunny.",
      output: 0.7,
      notice: "nothingHeard",
    });
    controller.setMuted(true);
    expect(commands.setMuted).toHaveBeenCalledWith("s1", true);
    controller.interrupt();
    expect(commands.interrupt).toHaveBeenCalledWith("s1");
    emit({
      kind: "error",
      code: "protected_mode_voice_off",
      message: "Protected mode turned off voice conversations.",
    });
    expect(controller.getState().status).toBe("error");
    emit({ kind: "ended" });
    // An error stays on screen after the session ends.
    expect(controller.getState().status).toBe("error");
  });

  it("ends cleanly and reports a start that failed", async () => {
    const { controller, commands, emit } = setup();
    await controller.start({ model: "m", format: "mp3" });
    await controller.end();
    expect(commands.stop).toHaveBeenCalled();
    expect(controller.getState().status).toBe("idle");
    // Events after the end are not heard.
    emit({ kind: "phase", phase: "speaking" });
    expect(controller.getState().phase).toBe("listening");

    const refused = setup();
    (refused.commands.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: "voice_microphone_unavailable",
      message:
        "The microphone could not start. Check that it is connected and allowed, then try again.",
    });
    await refused.controller.start({ model: "m", format: "mp3" });
    expect(refused.controller.getState()).toMatchObject({
      status: "error",
      error:
        "The microphone could not start. Check that it is connected and allowed, then try again.",
    });
  });
});
