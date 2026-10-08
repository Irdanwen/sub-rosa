/**
 * The voice conversation as a state machine: the browser's port of
 * `voice/machine.rs`. Inputs are what happened, effects what the session must
 * do about it. A turn is a number (a barge-in forgets it, so whatever is
 * still in flight for it is dropped on arrival), rendering stays one
 * sentence ahead of playback, and words said while an earlier part is being
 * transcribed join the same turn.
 */
import { newCursor, nextSentences, type SentenceCursor } from "./sentences";

export type Phase = "listening" | "transcribing" | "thinking" | "speaking";

export type Input =
  | { kind: "speechStarted" }
  | { kind: "utteranceEnded"; utterance: number }
  | { kind: "utteranceDiscarded" }
  | { kind: "transcribed"; utterance: number; text: string }
  | { kind: "transcriptionFailed"; utterance: number }
  | { kind: "reply"; turn: number; text: string; done: boolean }
  | { kind: "turnFailed"; turn: number }
  | { kind: "rendered"; turn: number; index: number }
  | { kind: "renderFailed"; turn: number; index: number }
  | { kind: "playbackFinished"; turn: number; index: number }
  | { kind: "interrupt" };

export type Notice = "nothingHeard" | "transcriptionFailed" | "speechFailed" | "turnFailed";

export type Effect =
  | { kind: "transcribe"; utterance: number }
  | { kind: "sendTurn"; turn: number; text: string }
  | { kind: "cancelTurn"; turn: number }
  | { kind: "render"; turn: number; index: number; text: string }
  | { kind: "play"; turn: number; index: number }
  | { kind: "stopPlayback" }
  | { kind: "phase"; phase: Phase }
  | { kind: "heard"; text: string }
  | { kind: "saying"; text: string }
  | { kind: "notice"; notice: Notice };

interface Reply {
  cursor: SentenceCursor;
  sentences: string[];
  done: boolean;
  nextRender: number;
  nextPlay: number;
  playing: number | null;
  ready: Set<number>;
  skipped: Set<number>;
}
const newReply = (): Reply => ({
  cursor: newCursor(),
  sentences: [],
  done: false,
  nextRender: 0,
  nextPlay: 0,
  playing: null,
  ready: new Set(),
  skipped: new Set(),
});

export class Machine {
  private currentPhase: Phase = "listening";
  private turn = 0;
  private awaitingTurn: number | null = null;
  private reply: Reply = newReply();
  private pending = new Set<number>();
  private userSpeaking = false;
  private heard: string[] = [];

  /** `fenceLabel` says a skipped fenced block in the person's language. */
  constructor(private readonly fenceLabel: (info: string) => string) {}

  phase(): Phase {
    return this.currentPhase;
  }
  awaiting(): number | null {
    return this.awaitingTurn;
  }

  handle(input: Input): Effect[] {
    const effects: Effect[] = [];
    switch (input.kind) {
      case "speechStarted":
        this.userSpeaking = true;
        if (this.currentPhase === "thinking" || this.currentPhase === "speaking")
          this.bargeIn(effects);
        else if (this.currentPhase === "transcribing") this.setPhase("listening", effects);
        break;
      case "utteranceEnded":
        this.userSpeaking = false;
        this.pending.add(input.utterance);
        effects.push({ kind: "transcribe", utterance: input.utterance });
        if (this.awaitingTurn === null) this.setPhase("transcribing", effects);
        break;
      case "utteranceDiscarded":
        this.userSpeaking = false;
        this.maybeSend(effects);
        break;
      case "transcribed": {
        if (!this.pending.delete(input.utterance)) return effects;
        const text = input.text.trim();
        if (!text) {
          if (this.pending.size === 0 && this.heard.length === 0 && !this.userSpeaking)
            effects.push({ kind: "notice", notice: "nothingHeard" });
        } else {
          this.heard.push(text);
          effects.push({ kind: "heard", text: this.heard.join(" ") });
        }
        this.maybeSend(effects);
        break;
      }
      case "transcriptionFailed":
        if (!this.pending.delete(input.utterance)) return effects;
        effects.push({ kind: "notice", notice: "transcriptionFailed" });
        this.maybeSend(effects);
        break;
      case "reply":
        if (this.awaitingTurn !== input.turn) return effects;
        for (const unit of nextSentences(input.text, this.reply.cursor, input.done)) {
          const sentence = unit.kind === "text" ? unit.text : this.fenceLabel(unit.info);
          if (sentence.trim()) this.reply.sentences.push(sentence);
        }
        this.reply.done ||= input.done;
        this.advance(effects);
        break;
      case "turnFailed":
        if (this.awaitingTurn !== input.turn) return effects;
        if (this.reply.playing !== null) effects.push({ kind: "stopPlayback" });
        this.awaitingTurn = null;
        this.reply = newReply();
        effects.push({ kind: "notice", notice: "turnFailed" });
        this.settle(effects);
        break;
      case "rendered":
        if (this.awaitingTurn !== input.turn) return effects;
        this.reply.ready.add(input.index);
        this.advance(effects);
        break;
      case "renderFailed":
        if (this.awaitingTurn !== input.turn) return effects;
        this.reply.skipped.add(input.index);
        effects.push({ kind: "notice", notice: "speechFailed" });
        this.advance(effects);
        break;
      case "playbackFinished":
        if (this.awaitingTurn !== input.turn || this.reply.playing !== input.index) return effects;
        this.reply.playing = null;
        this.reply.nextPlay += 1;
        this.advance(effects);
        break;
      case "interrupt":
        if (this.currentPhase === "thinking" || this.currentPhase === "speaking")
          this.bargeIn(effects);
        break;
    }
    return effects;
  }

  /** Silence the speaker first (that is what the person hears), then stop
   * the turn. */
  private bargeIn(effects: Effect[]) {
    if (this.reply.playing !== null || this.currentPhase === "speaking")
      effects.push({ kind: "stopPlayback" });
    if (this.awaitingTurn !== null) {
      effects.push({ kind: "cancelTurn", turn: this.awaitingTurn });
      this.awaitingTurn = null;
    }
    this.reply = newReply();
    this.setPhase("listening", effects);
  }

  /** Sends the words heard once nothing more is coming. */
  private maybeSend(effects: Effect[]) {
    if (this.pending.size > 0 || this.userSpeaking || this.awaitingTurn !== null) return;
    if (this.heard.length === 0) {
      this.settle(effects);
      return;
    }
    this.turn += 1;
    const turn = this.turn;
    this.awaitingTurn = turn;
    this.reply = newReply();
    const text = this.heard.join(" ");
    this.heard = [];
    effects.push({ kind: "sendTurn", turn, text });
    this.setPhase("thinking", effects);
  }

  /** Renders what the window allows, plays what is ready, and closes the
   * turn once everything it said has been played. */
  private advance(effects: Effect[]) {
    const turn = this.awaitingTurn;
    if (turn === null) return;
    const reply = this.reply;
    if (reply.playing === null) while (reply.skipped.has(reply.nextPlay)) reply.nextPlay += 1;
    while (reply.nextRender < reply.sentences.length && reply.nextRender < reply.nextPlay + 2) {
      const index = reply.nextRender;
      effects.push({ kind: "render", turn, index, text: reply.sentences[index] });
      reply.nextRender += 1;
    }
    if (reply.playing === null && reply.ready.delete(reply.nextPlay)) {
      const index = reply.nextPlay;
      reply.playing = index;
      effects.push({ kind: "play", turn, index });
      effects.push({ kind: "saying", text: reply.sentences[index] });
      this.setPhase("speaking", effects);
      return;
    }
    if (reply.done && reply.playing === null && reply.nextPlay >= reply.sentences.length) {
      this.awaitingTurn = null;
      this.reply = newReply();
      this.settle(effects);
    }
  }

  private settle(effects: Effect[]) {
    this.setPhase(
      this.pending.size > 0 && !this.userSpeaking ? "transcribing" : "listening",
      effects,
    );
  }

  private setPhase(phase: Phase, effects: Effect[]) {
    if (this.currentPhase !== phase) {
      this.currentPhase = phase;
      effects.push({ kind: "phase", phase });
    }
  }
}
