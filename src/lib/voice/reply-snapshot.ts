// What the voice loop needs to know about the chat, from either shell: the
// person's last message, the assistant's words since, and whether the turn
// is still running. Pure, so both shells' shapes are tested side by side.

import type { AgentChatTurn } from "../agent-chat-runtime";

export type ReplySnapshot = {
  /** Identifies the person's last message: a new one means a new turn. */
  key: string | null;
  /** The assistant's text after that message, as far as it has streamed. */
  text: string;
  /** False while the chat is working on the turn. */
  done: boolean;
};

/** The desktop transcript: every assistant bubble after the person's last
 * message is the reply (interim commentary before a tool call included). */
export function desktopReplySnapshot(
  turns: readonly AgentChatTurn[],
  working: boolean,
): ReplySnapshot {
  let last = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role === "user") {
      last = index;
      break;
    }
  }
  const text = turns
    .slice(last + 1)
    .filter((turn) => turn.role === "assistant")
    .flatMap((turn) => turn.parts)
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((part) => part.trim())
    .join("\n\n");
  return { key: last >= 0 ? turns[last].id : null, text, done: !working };
}

type PhoneMessage = { id: string; role: string; content: string };

/** The phone chat: the streamed text while the turn runs, the stored reply
 * once it is done. */
export function mobileReplySnapshot(
  messages: readonly PhoneMessage[],
  streamed: string,
  running: boolean,
): ReplySnapshot {
  let last = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      last = index;
      break;
    }
  }
  const stored = messages
    .slice(last + 1)
    .filter((message) => message.role === "assistant")
    .map((message) => message.content)
    .join("\n\n");
  return {
    key: last >= 0 ? messages[last].id : null,
    text: running ? streamed : stored,
    done: !running,
  };
}
