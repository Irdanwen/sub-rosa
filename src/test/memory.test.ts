import { describe, expect, it } from "vitest";
import { conversationFromHermesMessages, windowedConversation } from "../lib/memory";
import type { HermesSessionMessage, MemoryConversationMessage } from "../lib/tauri";

function hermesMessage(
  role: HermesSessionMessage["role"],
  content: unknown,
  id = `${role}-${Math.random()}`,
): HermesSessionMessage {
  return { id, role, content };
}

describe("conversationFromHermesMessages", () => {
  it("keeps only user and assistant messages with text", () => {
    const conversation = conversationFromHermesMessages([
      hermesMessage("system", "You are Sub Rosa."),
      hermesMessage("user", "Réponds toujours en français."),
      hermesMessage("tool", "tool output"),
      hermesMessage("assistant", "Entendu."),
      hermesMessage("assistant", ""),
    ]);
    expect(conversation).toEqual([
      { role: "user", content: "Réponds toujours en français." },
      { role: "assistant", content: "Entendu." },
    ]);
  });

  it("flattens structured content and strips attached context blocks", () => {
    const conversation = conversationFromHermesMessages([
      hermesMessage("user", [{ type: "text", text: "Summarize my meeting" }]),
      hermesMessage("user", "What does the doc say?\n--- Attached Context ---\n(entire file dump)"),
      hermesMessage("assistant", "Done.\n--- Context Warnings ---\ntruncated"),
    ]);
    expect(conversation).toEqual([
      { role: "user", content: "Summarize my meeting" },
      { role: "user", content: "What does the doc say?" },
      { role: "assistant", content: "Done." },
    ]);
  });
});

describe("windowedConversation", () => {
  it("keeps the last five messages per role, preserving order", () => {
    const conversation: MemoryConversationMessage[] = [];
    for (let index = 0; index < 8; index += 1) {
      conversation.push({ role: "user", content: `question ${index}` });
      conversation.push({ role: "assistant", content: `answer ${index}` });
    }
    const windowed = windowedConversation(conversation);
    expect(windowed).toHaveLength(10);
    expect(windowed[0]).toEqual({ role: "user", content: "question 3" });
    expect(windowed.at(-1)).toEqual({ role: "assistant", content: "answer 7" });
    // Original interleaving preserved.
    expect(windowed.map((message) => message.role).slice(0, 4)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("returns short conversations untouched", () => {
    const conversation: MemoryConversationMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(windowedConversation(conversation)).toEqual(conversation);
  });
});
