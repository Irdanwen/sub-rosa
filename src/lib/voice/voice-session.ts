// The voice conversation's commands and its one event (ADR-0093). The loop
// itself runs in Rust (`src-tauri/src/voice/`); the webview sends the chat
// turns it asks for and feeds back the reply as it streams.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const VOICE_EVENT = "voice://event";

export type VoicePhase = "listening" | "transcribing" | "thinking" | "speaking";

export type VoiceNotice = "nothingHeard" | "transcriptionFailed" | "speechFailed" | "turnFailed";

export type VoiceEvent =
  | { kind: "phase"; phase: VoicePhase }
  | { kind: "turn"; turn: number; text: string }
  | { kind: "cancel"; turn: number }
  | { kind: "caption"; role: "user" | "assistant"; text: string }
  | { kind: "notice"; notice: VoiceNotice }
  | { kind: "level"; input: number; output: number }
  | { kind: "echoCancellation"; active: boolean }
  | { kind: "error"; code: string; message: string }
  | { kind: "ended" };

export type VoiceEventPayload = VoiceEvent & { sessionId: string };

/** What replies are read with (resolved from voice-preference.ts). */
export type VoiceSpeech = { model: string; voice?: string; format: string };

export type VoiceAvailability = { allowed: boolean; reason?: string; screen: boolean };

export type VoiceStarted = { sessionId: string; echoCancelled: boolean };

/** The commands, as one object so a test can stand in for them. */
export type VoiceCommands = {
  availability(): Promise<VoiceAvailability>;
  start(speech: VoiceSpeech): Promise<VoiceStarted>;
  stop(): Promise<void>;
  reply(sessionId: string, turn: number, text: string, done: boolean): Promise<void>;
  turnFailed(sessionId: string, turn: number): Promise<void>;
  setMuted(sessionId: string, muted: boolean): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  screenFrame(): Promise<string>;
  listen(handler: (event: VoiceEventPayload) => void): Promise<UnlistenFn>;
};

export const voiceCommands: VoiceCommands = {
  availability: () => invoke<VoiceAvailability>("voice_availability"),
  start: (speech) => invoke<VoiceStarted>("voice_start", { request: { speech } }),
  stop: () => invoke<void>("voice_stop"),
  reply: (sessionId, turn, text, done) =>
    invoke<void>("voice_reply", { request: { sessionId, turn, text, done } }),
  turnFailed: (sessionId, turn) => invoke<void>("voice_turn_failed", { sessionId, turn }),
  setMuted: (sessionId, muted) => invoke<void>("voice_set_muted", { sessionId, muted }),
  interrupt: (sessionId) => invoke<void>("voice_interrupt", { sessionId }),
  screenFrame: () => invoke<string>("voice_screen_frame"),
  listen: (handler) => listen<VoiceEventPayload>(VOICE_EVENT, (event) => handler(event.payload)),
};
