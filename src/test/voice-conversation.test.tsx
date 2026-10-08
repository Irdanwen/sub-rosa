// The voice surface (src/components/voice/VoiceConversation.tsx): refused
// by protected mode without starting, priced before the first use, and a
// turn the loop asks for reaches the shell's chat with its screen frame.

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceEventPayload } from "../lib/voice/voice-session";

const fake = vi.hoisted(() => ({
  handler: null as ((event: VoiceEventPayload) => void) | null,
  availability: { allowed: true, screen: false } as {
    allowed: boolean;
    reason?: string;
    screen: boolean;
  },
  start: vi.fn(async () => ({ sessionId: "s1", echoCancelled: false })),
  screenFrame: vi.fn(async () => "/tmp/subrosa-voice-frames/screen.jpg"),
}));

vi.mock("../lib/voice/voice-session", async (original) => ({
  ...(await original<typeof import("../lib/voice/voice-session")>()),
  voiceCommands: {
    availability: async () => fake.availability,
    start: fake.start,
    stop: async () => undefined,
    reply: async () => undefined,
    turnFailed: async () => undefined,
    setMuted: async () => undefined,
    interrupt: async () => undefined,
    screenFrame: fake.screenFrame,
    listen: async (handler: (event: VoiceEventPayload) => void) => {
      fake.handler = handler;
      return () => {
        fake.handler = null;
      };
    },
  },
}));

vi.mock("../lib/voice/voice-setup", () => ({
  resolveVoiceSpeech: async () => ({ model: "tts-kokoro", format: "mp3" }),
  fetchVoiceCost: async () => ({ creditsPerMinute: 0.46 }),
}));

import { VoiceConversation } from "../components/voice/VoiceConversation";

const flush = () => act(async () => {});
const idle = { key: null, text: "", done: true };

beforeEach(() => {
  localStorage.clear();
  fake.availability = { allowed: true, screen: false };
  fake.start.mockClear();
  fake.screenFrame.mockClear();
});

describe("the voice surface", () => {
  it("says why protected mode refuses it, and opens nothing", async () => {
    fake.availability = {
      allowed: false,
      reason: "Protected mode turned off voice conversations.",
      screen: false,
    };
    render(
      <VoiceConversation
        shell="mobile"
        reply={idle}
        send={vi.fn()}
        stop={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await flush();
    expect(screen.getByRole("alert").textContent).toContain(
      "Protected mode turned off voice conversations.",
    );
    expect(fake.start).not.toHaveBeenCalled();
  });

  it("prices a minute before the first conversation, then sends what was said", async () => {
    const send = vi.fn(async () => undefined);
    render(
      <VoiceConversation
        shell="mobile"
        reply={idle}
        send={send}
        stop={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await flush();
    expect(screen.getByText(/About 0.46 credits a minute/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Start talking" }));
    await flush();
    expect(fake.start).toHaveBeenCalledWith({ model: "tts-kokoro", format: "mp3" });

    await act(async () => {
      fake.handler?.({ sessionId: "s1", kind: "turn", turn: 1, text: "Hello there" });
    });
    expect(send).toHaveBeenCalledWith("Hello there", null);
    expect(screen.getByText("Hello there")).toBeTruthy();
  });

  it("explains screen sharing once, then sends a frame with the turn", async () => {
    localStorage.setItem("subrosa:voice-intro-seen", "1");
    fake.availability = { allowed: true, screen: true };
    const send = vi.fn(async () => undefined);
    render(
      <VoiceConversation
        shell="desktop"
        reply={idle}
        send={send}
        stop={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await flush();
    expect(fake.start).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Share your screen" }));
    expect(screen.getByText(/Nothing is recorded in between/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Share screen" }));
    expect(screen.getByRole("button", { name: "Stop sharing your screen" })).toBeTruthy();

    await act(async () => {
      fake.handler?.({ sessionId: "s1", kind: "turn", turn: 1, text: "What is on my screen?" });
    });
    expect(fake.screenFrame).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("What is on my screen?", {
      kind: "screen",
      path: "/tmp/subrosa-voice-frames/screen.jpg",
    });
    // No headphones in the room: the desktop suggests them.
    expect(screen.getByText("Headphones make it easier to talk over a reply.")).toBeTruthy();
  });
});
