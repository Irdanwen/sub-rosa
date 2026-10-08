import { invoke } from "@tauri-apps/api/core";
import { PRODUCT_NAME } from "./branding";
import { attachmentPromptPath } from "./agent-chat-transcript";
import type { JuneHermesEvent } from "./hermes-control-plane/events";
import type { HermesSessionInfo, ImportedHermesFile } from "./tauri";

/** The chat bar (ADR-0094): a system-wide shortcut, a floating field, the
 * agent's answer streamed into it. */

export type ChatBarModifiers = {
  command: boolean;
  control: boolean;
  option: boolean;
  shift: boolean;
};

export type ChatBarShortcut = {
  code: string;
  modifiers: ChatBarModifiers;
  label: string;
};

export type ChatBarSettings = { enabled: boolean; shortcut: ChatBarShortcut };

export type ChatBarSettingsResponse = {
  settings: ChatBarSettings;
  defaultShortcut: ChatBarShortcut;
};

/** Told to the panel each time it opens. */
export const CHAT_BAR_OPENED_EVENT = "chat-bar://opened";

export function chatBarSettings() {
  return invoke<ChatBarSettingsResponse>("chat_bar_settings");
}

export function saveChatBarSettings(settings: ChatBarSettings) {
  return invoke<ChatBarSettingsResponse>("chat_bar_save_settings", { settings });
}

export function chatBarHide() {
  return invoke<void>("chat_bar_hide");
}

export function chatBarSetHeight(height: number) {
  return invoke<void>("chat_bar_set_height", { height });
}

export function chatBarOpenInApp(session?: HermesSessionInfo) {
  return invoke<void>("chat_bar_open_in_app", { session });
}

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
  "Fn",
]);

type KeyChord = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** The shortcut a key press describes, or null while only modifiers are
 * down. The backend has the last word on what is allowed. */
export function shortcutFromKeyboardEvent(event: KeyChord, mac: boolean): ChatBarShortcut | null {
  if (!event.code || MODIFIER_CODES.has(event.code)) return null;
  const modifiers: ChatBarModifiers = {
    command: event.metaKey,
    control: event.ctrlKey,
    option: event.altKey,
    shift: event.shiftKey,
  };
  return { code: event.code, modifiers, label: shortcutLabel(event.code, modifiers, mac) };
}

export function shortcutLabel(code: string, modifiers: ChatBarModifiers, mac: boolean): string {
  const parts: string[] = [];
  if (modifiers.command) parts.push(mac ? "Cmd" : "Win");
  if (modifiers.control) parts.push("Ctrl");
  if (modifiers.option) parts.push(mac ? "Opt" : "Alt");
  if (modifiers.shift) parts.push("Shift");
  parts.push(keyLabel(code));
  return parts.join("+");
}

const KEY_LABELS: Record<string, string> = {
  Slash: "/",
  Period: ".",
  Comma: ",",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Backslash: "\\",
};

function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return KEY_LABELS[code] ?? code;
}

/** The prompt with its files named the way the main chat names them, so the
 * transcript hides the block the same way (`stripAttachmentPromptBlock`). */
export function promptWithFiles(
  message: string,
  files: Pick<ImportedHermesFile, "name" | "path" | "rootLabel">[],
): string {
  if (!files.length) return message;
  return [
    message || "Use the attached file(s).",
    "",
    `Attached files copied into the ${PRODUCT_NAME} workspace:`,
    ...files.map(
      (file) => `- ${file.name} (${file.rootLabel}): ${attachmentPromptPath(file.path)}`,
    ),
    "",
    "Use these file paths when inspecting or operating on the files.",
  ].join("\n");
}

/** A chat's title from its first question. */
export function chatTitleFor(text: string): string {
  const line = text.trim().split(/\s+/).join(" ");
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Where the panel's answer stands. */
export type ChatBarTurn = {
  phase: "idle" | "sending" | "streaming" | "done" | "error";
  answer: string;
  /** The agent is waiting on a question only the main window can show. */
  needsApp: boolean;
  error?: string;
};

export const IDLE_TURN: ChatBarTurn = { phase: "idle", answer: "", needsApp: false };

/** Folds one classified gateway event for `runtimeSessionId` into the turn. */
export function applyChatBarEvent(
  turn: ChatBarTurn,
  event: JuneHermesEvent,
  runtimeSessionId: string,
): ChatBarTurn {
  if (event.sessionId && event.sessionId !== runtimeSessionId) return turn;
  switch (event.kind) {
    case "transcript": {
      if (event.role === "user" || event.role === "system") return turn;
      if (event.complete) {
        const answer = event.delta?.trim() ? (event.delta ?? "") : turn.answer;
        return { ...turn, phase: "done", answer };
      }
      if (event.interim) return turn;
      return { ...turn, phase: "streaming", answer: turn.answer + (event.delta ?? "") };
    }
    case "pending_action":
      return { ...turn, needsApp: true };
    case "error":
      return { ...turn, phase: "error", error: event.message };
    default:
      return turn;
  }
}

/** Whether `event` ends the turn the panel is showing. */
export function chatBarEventEnds(event: JuneHermesEvent, runtimeSessionId: string): boolean {
  if (event.sessionId && event.sessionId !== runtimeSessionId) return false;
  if (event.kind === "error") return true;
  return (
    event.kind === "transcript" &&
    event.complete === true &&
    event.role !== "user" &&
    event.role !== "system"
  );
}
