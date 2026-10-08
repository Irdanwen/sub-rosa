// The webview's half of a voice conversation: it relays what the Rust loop
// asks (send these words as a turn, stop that turn) to the shell's chat,
// and relays the chat's reply back as it streams. Framework-free, so a test
// drives it with fake commands and a fake chat; `use-voice-conversation.ts`
// wraps it for React.
//
// Which reply belongs to a voice turn is read from the transcript, not
// from the send call: a turn's reply is whatever the assistant writes after
// the person's message that the turn added (a new `key`). The reply is done
// when the chat stops working, but only once it was seen working (or wrote
// something): right after a send the chat can still read as idle for a
// moment, and taking that for the end would drop the whole answer. A turn
// that never starts (the chat refused it silently) is closed after a grace
// period, so the conversation goes back to listening instead of waiting.

import { messageFromError } from "../errors";
import type { ReplySnapshot } from "./reply-snapshot";
import type {
  VoiceCommands,
  VoiceEventPayload,
  VoiceNotice,
  VoicePhase,
  VoiceSpeech,
} from "./voice-session";

/** How the conversation reaches the shell's chat. */
export type VoicePort = {
  /** Sends the words as a chat turn. Resolves once the shell took it. */
  send(text: string): Promise<void>;
  /** Stops the turn being answered, keeping what it wrote. */
  stop(): void;
};

export type VoiceStatus = "idle" | "starting" | "active" | "error";

export type VoiceState = {
  status: VoiceStatus;
  phase: VoicePhase;
  /** The person's last words, for the captions. */
  heard: string;
  /** The sentence being spoken, for the captions. */
  saying: string;
  /** Microphone and speaker levels, 0 to 1. */
  input: number;
  output: number;
  muted: boolean;
  echoCancelled: boolean;
  notice: VoiceNotice | null;
  error: string | null;
};

export const IDLE_VOICE_STATE: VoiceState = {
  status: "idle",
  phase: "listening",
  heard: "",
  saying: "",
  input: 0,
  output: 0,
  muted: false,
  echoCancelled: false,
  notice: null,
  error: null,
};

/** How long a sent turn may stay unstarted before it is closed. */
export const TURN_START_GRACE_MS = 4_000;
/** Reply text is sent at most this often while it streams. */
export const REPLY_THROTTLE_MS = 120;

type Schedule = (callback: () => void, ms: number) => () => void;

const defaultSchedule: Schedule = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

type CurrentTurn = {
  turn: number;
  baseline: string | null;
  sawRunning: boolean;
  lastText: string;
  lastSentAt: number;
  doneSent: boolean;
  cancelGrace?: () => void;
  cancelTrailing?: () => void;
};

export function createVoiceController(deps: {
  commands: VoiceCommands;
  port: VoicePort;
  schedule?: Schedule;
  now?: () => number;
}) {
  const schedule = deps.schedule ?? defaultSchedule;
  const now = deps.now ?? (() => Date.now());
  let state: VoiceState = IDLE_VOICE_STATE;
  const listeners = new Set<() => void>();
  let sessionId: string | null = null;
  let unlisten: (() => void) | null = null;
  let current: CurrentTurn | null = null;
  let latest: ReplySnapshot = { key: null, text: "", done: true };

  function set(patch: Partial<VoiceState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function forget() {
    current?.cancelGrace?.();
    current?.cancelTrailing?.();
    current = null;
  }

  function push() {
    const turn = current;
    if (!turn || turn.doneSent || !sessionId) return;
    // The person's message for this turn has not landed yet.
    if (latest.key === turn.baseline) return;
    if (!latest.done) turn.sawRunning = true;
    const done = latest.done && (turn.sawRunning || latest.text.trim() !== "");
    if (!done && latest.text === turn.lastText) return;
    if (!done && now() - turn.lastSentAt < REPLY_THROTTLE_MS) {
      turn.cancelTrailing ??= schedule(() => {
        if (current === turn) {
          turn.cancelTrailing = undefined;
          push();
        }
      }, REPLY_THROTTLE_MS);
      return;
    }
    turn.lastText = latest.text;
    turn.lastSentAt = now();
    if (done) {
      turn.doneSent = true;
      turn.cancelGrace?.();
      turn.cancelTrailing?.();
    }
    void deps.commands.reply(sessionId, turn.turn, latest.text, done).catch(() => undefined);
  }

  function onTurn(turnNumber: number, text: string) {
    forget();
    const turn: CurrentTurn = {
      turn: turnNumber,
      baseline: latest.key,
      sawRunning: false,
      lastText: "",
      lastSentAt: Number.NEGATIVE_INFINITY,
      doneSent: false,
    };
    current = turn;
    const id = sessionId;
    deps.port.send(text).then(
      () => {
        if (current !== turn || turn.sawRunning) return;
        // Taken, but nothing seen running yet: give it a moment to start.
        turn.cancelGrace = schedule(() => {
          if (current !== turn || turn.sawRunning || turn.doneSent || !sessionId) return;
          turn.doneSent = true;
          void deps.commands.reply(
            sessionId,
            turn.turn,
            latest.key === turn.baseline ? "" : latest.text,
            true,
          );
        }, TURN_START_GRACE_MS);
        push();
      },
      () => {
        if (current !== turn) return;
        current = null;
        if (id) void deps.commands.turnFailed(id, turnNumber).catch(() => undefined);
      },
    );
  }

  function onEvent(event: VoiceEventPayload) {
    if (!sessionId || event.sessionId !== sessionId) return;
    switch (event.kind) {
      case "phase":
        set({ phase: event.phase, ...(event.phase === "listening" ? { saying: "" } : {}) });
        if (event.phase === "listening" || event.phase === "speaking") set({ notice: null });
        break;
      case "turn":
        set({ heard: event.text, saying: "" });
        onTurn(event.turn, event.text);
        break;
      case "cancel":
        if (current?.turn === event.turn) {
          forget();
          deps.port.stop();
        }
        set({ saying: "" });
        break;
      case "caption":
        set(event.role === "user" ? { heard: event.text } : { saying: event.text });
        break;
      case "notice":
        set({ notice: event.notice });
        break;
      case "level":
        set({ input: event.input, output: event.output });
        break;
      case "echoCancellation":
        set({ echoCancelled: event.active });
        break;
      case "error":
        // The session's sentence, in the app's language.
        set({ status: "error", error: messageFromError({ message: event.message }) });
        break;
      case "ended":
        teardown();
        if (state.status !== "error") set({ ...IDLE_VOICE_STATE });
        break;
    }
  }

  function teardown() {
    forget();
    unlisten?.();
    unlisten = null;
    sessionId = null;
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start(speech: VoiceSpeech) {
      if (state.status === "starting" || state.status === "active") return;
      set({ ...IDLE_VOICE_STATE, status: "starting" });
      try {
        // Listen first: the session speaks as soon as it is open.
        unlisten = await deps.commands.listen(onEvent);
        const started = await deps.commands.start(speech);
        sessionId = started.sessionId;
        set({ status: "active", echoCancelled: started.echoCancelled });
      } catch (error) {
        teardown();
        set({ status: "error", error: messageFromError(error) });
      }
    },
    async end() {
      const wasActive = sessionId !== null;
      teardown();
      set({ ...IDLE_VOICE_STATE });
      if (wasActive) await deps.commands.stop().catch(() => undefined);
    },
    setMuted(muted: boolean) {
      set({ muted });
      if (sessionId) void deps.commands.setMuted(sessionId, muted).catch(() => undefined);
    },
    interrupt() {
      if (sessionId) void deps.commands.interrupt(sessionId).catch(() => undefined);
    },
    /** The chat as the shell sees it now; call on every change. */
    updateReply(snapshot: ReplySnapshot) {
      latest = snapshot;
      push();
    },
  };
}

export type VoiceController = ReturnType<typeof createVoiceController>;
