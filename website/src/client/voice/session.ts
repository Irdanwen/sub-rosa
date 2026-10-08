/**
 * A voice conversation in the browser: the engine's effects carried out
 * with real requests, behind dependencies a test can fake (the role of
 * `voice/session.rs` in the app). The loop is the app's cascade (ADR-0093):
 * an utterance, its transcription, an ordinary chat turn of the open chat,
 * and the reply read back one sentence ahead of the one playing. It lives in
 * the page, not in Rust: a browser has no Rust, and the tab is the app that
 * is open (ADR-0091's rule for agents applies to a conversation the person
 * is in).
 */
import { Engine } from "./engine";
import type { Effect, Notice, Phase } from "./machine";
import { defaultVadConfig, SAMPLE_RATE, type VadConfig } from "./vad";

export interface VoicePlayer {
  /** Plays one rendered sentence; settles when it ended or was stopped. */
  play(clip: ArrayBuffer): Promise<void>;
  stop(): void;
  /** The level the page is playing at (held for the echo tail), or null. */
  levelDb(): number | null;
}

export type VoiceEvent =
  | { kind: "phase"; phase: Phase }
  | { kind: "heard"; text: string }
  | { kind: "saying"; text: string }
  | { kind: "notice"; notice: Notice }
  | { kind: "ended"; reason: string | null };

export interface VoiceDeps {
  transcribe(samples: Float32Array, signal: AbortSignal): Promise<string>;
  /** Sends the words as a chat turn: `onReply` gets the reply so far, the
   * promise its final text. A rejection is a turn that failed; aborting
   * `signal` stops the turn and keeps what it wrote. */
  sendTurn(text: string, onReply: (soFar: string) => void, signal: AbortSignal): Promise<string>;
  render(text: string, signal: AbortSignal): Promise<ArrayBuffer>;
  player: VoicePlayer;
  /** Why the conversation may not go on (protected mode), or null. */
  refusal(): string | null;
  fenceLabel(info: string): string;
  onEvent(event: VoiceEvent): void;
}

export class VoiceSession {
  private readonly engine: Engine;
  private readonly controller = new AbortController();
  private clips = new Map<string, ArrayBuffer>();
  private turnControllers = new Map<number, AbortController>();
  private ended = false;

  constructor(
    private readonly deps: VoiceDeps,
    config: VadConfig = defaultVadConfig(),
  ) {
    this.engine = new Engine(config, deps.fenceLabel);
  }

  get active() {
    return !this.ended;
  }

  /** Microphone audio, already at 16 kHz. */
  pushAudio(samples: ArrayLike<number>) {
    if (this.ended) return;
    this.execute(this.engine.pushAudio(samples, this.deps.player.levelDb()));
  }

  /** A tap on the reply: stop it like a voice would. */
  interrupt() {
    if (!this.ended) this.execute(this.engine.handle({ kind: "interrupt" }));
  }

  setMuted(muted: boolean) {
    if (!this.ended) this.execute(this.engine.setMuted(muted));
  }

  end(reason: string | null = null) {
    if (this.ended) return;
    this.ended = true;
    this.controller.abort();
    for (const controller of this.turnControllers.values()) controller.abort();
    this.deps.player.stop();
    this.clips.clear();
    this.deps.onEvent({ kind: "ended", reason });
  }

  private execute(effects: Effect[]) {
    for (const effect of effects) {
      if (this.ended) return;
      this.run(effect);
    }
  }

  private feed(input: Parameters<Engine["handle"]>[0]) {
    if (!this.ended) this.execute(this.engine.handle(input));
  }

  private run(effect: Effect) {
    const { deps } = this;
    switch (effect.kind) {
      case "transcribe": {
        const samples = this.engine.takeUtterance(effect.utterance);
        // Asked again before every utterance leaves (ADR-0093 decision 7):
        // a switch turned on mid conversation ends it with its reason.
        const refusal = deps.refusal();
        if (refusal) {
          this.end(refusal);
          return;
        }
        if (!samples) {
          this.feed({ kind: "transcriptionFailed", utterance: effect.utterance });
          return;
        }
        deps
          .transcribe(samples, this.controller.signal)
          .then((text) => this.feed({ kind: "transcribed", utterance: effect.utterance, text }))
          .catch(() => this.feed({ kind: "transcriptionFailed", utterance: effect.utterance }));
        return;
      }
      case "sendTurn": {
        const controller = new AbortController();
        this.turnControllers.set(effect.turn, controller);
        deps
          .sendTurn(
            effect.text,
            (soFar) => this.feed({ kind: "reply", turn: effect.turn, text: soFar, done: false }),
            controller.signal,
          )
          .then((text) => this.feed({ kind: "reply", turn: effect.turn, text, done: true }))
          .catch(() => this.feed({ kind: "turnFailed", turn: effect.turn }))
          .finally(() => this.turnControllers.delete(effect.turn));
        return;
      }
      case "cancelTurn": {
        // The turn's own signal stops it the way Stop does: what it wrote is
        // kept (ADR-0079), and no other turn of the page is touched.
        this.turnControllers.get(effect.turn)?.abort();
        // Whatever was rendered for it is not played.
        for (const key of [...this.clips.keys()])
          if (key.startsWith(`${effect.turn}:`)) this.clips.delete(key);
        return;
      }
      case "render":
        deps
          .render(effect.text, this.controller.signal)
          .then((clip) => {
            this.clips.set(`${effect.turn}:${effect.index}`, clip);
            this.feed({ kind: "rendered", turn: effect.turn, index: effect.index });
          })
          .catch(() => this.feed({ kind: "renderFailed", turn: effect.turn, index: effect.index }));
        return;
      case "play": {
        const key = `${effect.turn}:${effect.index}`;
        const clip = this.clips.get(key);
        this.clips.delete(key);
        const finished = () =>
          this.feed({ kind: "playbackFinished", turn: effect.turn, index: effect.index });
        if (!clip) {
          finished();
          return;
        }
        deps.player.play(clip).then(finished, finished);
        return;
      }
      case "stopPlayback":
        deps.player.stop();
        return;
      case "phase":
        deps.onEvent({ kind: "phase", phase: effect.phase });
        return;
      case "heard":
        deps.onEvent({ kind: "heard", text: effect.text });
        return;
      case "saying":
        deps.onEvent({ kind: "saying", text: effect.text });
        return;
      case "notice":
        deps.onEvent({ kind: "notice", notice: effect.notice });
        return;
    }
  }
}

export { SAMPLE_RATE };
