/**
 * The chat bar (ADR-0094): the shortcut a key press describes, the prompt it
 * sends with its files, and the answer assembled from the gateway's events.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let saved: unknown = null;
const invokeMock = vi.fn(async (command: string, args?: unknown) => {
  if (command === "chat_bar_settings") {
    return {
      settings: {
        enabled: true,
        shortcut: {
          code: "Space",
          modifiers: { command: false, control: false, option: true, shift: false },
          label: "Opt+Space",
        },
      },
      defaultShortcut: {
        code: "Space",
        modifiers: { command: false, control: false, option: true, shift: false },
        label: "Opt+Space",
      },
    };
  }
  if (command === "chat_bar_save_settings") {
    saved = args;
    throw {
      code: "chat_bar_shortcut_invalid",
      message: "Your system already uses this shortcut. Pick another one.",
    };
  }
  return undefined;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
}));

import { ChatBarShortcutCard } from "../components/settings/ChatBarShortcutCard";
import {
  type ChatBarTurn,
  IDLE_TURN,
  applyChatBarEvent,
  chatBarEventEnds,
  chatTitleFor,
  promptWithFiles,
  shortcutFromKeyboardEvent,
  shortcutLabel,
} from "../lib/chat-bar";
import type { JuneHermesEvent } from "../lib/hermes-control-plane/events";
import chatBarRust from "../../src-tauri/src/chat_bar/mod.rs?raw";
import appCss from "../styles/app.css?raw";
import chatBarCss from "../styles/chat-bar.css?raw";

beforeEach(() => {
  invokeMock.mockClear();
  saved = null;
});

const key = (
  code: string,
  mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("shortcuts", () => {
  it("reads a chord from a key press, and waits while only modifiers are down", () => {
    expect(shortcutFromKeyboardEvent(key("AltLeft", { altKey: true }), true)).toBeNull();
    const chord = shortcutFromKeyboardEvent(key("Space", { altKey: true }), true);
    expect(chord).toEqual({
      code: "Space",
      modifiers: { command: false, control: false, option: true, shift: false },
      label: "Opt+Space",
    });
    expect(shortcutFromKeyboardEvent(key("Space", { altKey: true }), false)?.label).toBe(
      "Alt+Space",
    );
    expect(
      shortcutLabel("KeyK", { command: true, control: false, option: false, shift: true }, true),
    ).toBe("Cmd+Shift+K");
    expect(
      shortcutLabel("Slash", { command: false, control: true, option: false, shift: false }, false),
    ).toBe("Ctrl+/");
  });

  it("captures a new shortcut in Settings and shows the backend's refusal", async () => {
    render(<ChatBarShortcutCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.keyDown(window, { code: "Space", key: " ", ctrlKey: true });
    await waitFor(() => expect(saved).not.toBeNull());
    expect(saved).toMatchObject({
      settings: { shortcut: { code: "Space", label: expect.stringContaining("Ctrl") } },
    });
    expect(
      await screen.findByText("Your system already uses this shortcut. Pick another one."),
    ).toBeInTheDocument();
  });
});

describe("the prompt", () => {
  it("names its files the way the main chat does", () => {
    const prompt = promptWithFiles("What does this say?", [
      { name: "Looking at Safari.md", rootLabel: "uploads", path: "/h/workspace/uploads/a.md" },
    ]);
    expect(prompt).toContain("Attached files copied into the Sub Rosa workspace:");
    expect(prompt).toContain("- Looking at Safari.md (uploads): uploads/a.md");
    expect(promptWithFiles("Hello", [])).toBe("Hello");
    expect(chatTitleFor("  a   short\nquestion ")).toBe("a short question");
    expect(chatTitleFor("x".repeat(80))).toHaveLength(60);
  });
});

describe("the streamed answer", () => {
  const delta = (text: string, sessionId = "rt-1"): JuneHermesEvent => ({
    kind: "transcript",
    sessionId,
    delta: text,
    role: "assistant",
  });

  it("grows with deltas, takes the final text, and ignores other chats", () => {
    let turn: ChatBarTurn = { ...IDLE_TURN, phase: "sending" };
    turn = applyChatBarEvent(turn, delta("Hel"), "rt-1");
    turn = applyChatBarEvent(turn, delta("lo"), "rt-1");
    turn = applyChatBarEvent(turn, delta("ignored", "rt-2"), "rt-1");
    expect(turn).toMatchObject({ phase: "streaming", answer: "Hello" });
    const complete: JuneHermesEvent = {
      kind: "transcript",
      sessionId: "rt-1",
      delta: "Hello there.",
      complete: true,
      role: "assistant",
    };
    expect(chatBarEventEnds(complete, "rt-1")).toBe(true);
    expect(chatBarEventEnds(complete, "rt-2")).toBe(false);
    turn = applyChatBarEvent(turn, complete, "rt-1");
    expect(turn).toMatchObject({ phase: "done", answer: "Hello there." });
  });

  it("does not echo the question, and flags what only the app can answer", () => {
    let turn = applyChatBarEvent(
      IDLE_TURN,
      { kind: "transcript", sessionId: "rt-1", delta: "my question", role: "user" },
      "rt-1",
    );
    expect(turn.answer).toBe("");
    turn = applyChatBarEvent(
      turn,
      {
        kind: "pending_action",
        sessionId: "rt-1",
        action: { kind: "approval", requestId: "r", receivedAt: "t" } as never,
      },
      "rt-1",
    );
    expect(turn.needsApp).toBe(true);
    const failed = applyChatBarEvent(
      turn,
      { kind: "error", sessionId: "rt-1", message: "Boom" },
      "rt-1",
    );
    expect(failed).toMatchObject({ phase: "error", error: "Boom" });
  });
});

describe("the panel's width", () => {
  // The panel is a 640px window and imports app.css, whose body has a 720px
  // floor for the main window: a real render cut off the send button and
  // "Open in Sub Rosa". The panel's stylesheet lifts the floor.
  it("lifts the main window's minimum width inside the panel", () => {
    expect(chatBarCss).toMatch(/html\.chat-bar-page body \{\s*min-width: 0;\s*\}/);
    const width = Number(/const WIDTH: f64 = (\d+)/.exec(chatBarRust)?.[1]);
    const floor = Number(/body \{[^}]*min-width: (\d+)px/.exec(appCss)?.[1]);
    expect(width).toBeLessThan(floor);
  });
});
