// The two shells' transcripts read the same way by the voice loop: the
// person's last message, the assistant's words since, and whether the
// turn still runs.

import { describe, expect, it } from "vitest";
import type { AgentChatTurn } from "../lib/agent-chat-runtime";
import { desktopReplySnapshot, mobileReplySnapshot } from "../lib/voice/reply-snapshot";

const turn = (id: string, role: AgentChatTurn["role"], ...texts: string[]): AgentChatTurn => ({
  id,
  role,
  createdAt: id,
  status: "complete",
  parts: texts.map((text) => ({ type: "text", text })),
});

describe("reply snapshots", () => {
  it("reads every assistant bubble after the person's last message on the desktop", () => {
    const turns: AgentChatTurn[] = [
      turn("1", "user", "Old question"),
      turn("2", "assistant", "Old answer"),
      turn("3", "user", "Find flights"),
      turn("4", "assistant", "Let me search."),
      { ...turn("5", "assistant"), parts: [{ type: "tool", name: "web_search" } as never] },
      turn("6", "assistant", "There are three."),
    ];
    expect(desktopReplySnapshot(turns, true)).toEqual({
      key: "3",
      text: "Let me search.\n\nThere are three.",
      done: false,
    });
    expect(desktopReplySnapshot([], false)).toEqual({ key: null, text: "", done: true });
  });

  it("reads the streamed text while the phone runs, the stored reply once done", () => {
    const messages = [
      { id: "a", role: "user", content: "Hi" },
      { id: "b", role: "assistant", content: "Hello." },
      { id: "c", role: "user", content: "Weather?" },
    ];
    expect(mobileReplySnapshot(messages, "Sunny", true)).toEqual({
      key: "c",
      text: "Sunny",
      done: false,
    });
    expect(
      mobileReplySnapshot(
        [...messages, { id: "d", role: "assistant", content: "Sunny and mild." }],
        "",
        false,
      ),
    ).toEqual({ key: "c", text: "Sunny and mild.", done: true });
  });
});
