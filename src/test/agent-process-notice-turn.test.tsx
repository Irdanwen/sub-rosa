import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentChatTurnRow } from "../components/agent/AgentWorkspace";
import type { AgentChatTurn } from "../lib/agent-chat-runtime";
import { buildHermesSessionChatTurns } from "../lib/agent-chat-runtime";

const noop = () => {};

function renderTurn(turn: AgentChatTurn, extra: Record<string, unknown> = {}) {
  return render(
    <AgentChatTurnRow
      turn={turn}
      approvalSubmitting={{}}
      clarifySubmitting={{}}
      sudoSubmitting={{}}
      secretSubmitting={{}}
      thinkingOpen={() => false}
      onApproval={noop}
      onClarify={noop}
      onSudo={noop}
      onSecret={noop}
      onThinkingOpenChange={noop}
      {...extra}
    />,
  );
}

const WATCH_NOTICE =
  '[IMPORTANT: Background process proc_a8f9b7e429b2 matched watch pattern "Serving HTTP on".\nCommand: python3 -m http.server 8765 --bind 127.0.0.1\nMatched output:\nServing HTTP on 127.0.0.1 port 8765 (http://127.0.0.1:8765/) ...]';

function turnFor(content: string) {
  const [turn] = buildHermesSessionChatTurns([
    { id: "m-1", role: "user", content, timestamp: "2026-06-11T12:00:00.000Z" },
  ]);
  if (!turn) throw new Error("no turn built");
  return turn;
}

describe("background-process notification rows", () => {
  it("renders an injected notification as a process row, not a user bubble", () => {
    const { container } = renderTurn(turnFor(WATCH_NOTICE));

    // The bug: this used to render in the user's own bubble, so the app looked
    // like it was sending messages the user never wrote.
    expect(container.querySelector(".agent-user-turn")).toBeNull();
    const row = container.querySelector(".agent-process-notice");
    expect(row).not.toBeNull();
    expect(row?.getAttribute("data-kind")).toBe("watch-match");
    expect(screen.getByText('Background process matched "Serving HTTP on"')).toBeTruthy();
    // Collapsed by default: the row is a beat in the transcript, not a wall of
    // output. The notification stays available behind the disclosure.
    expect((row as HTMLDetailsElement).open).toBe(false);
    expect(container.querySelector(".agent-process-detail")?.textContent).toContain(
      "Serving HTTP on 127.0.0.1 port 8765",
    );
  });

  it("offers no copy, edit, branch or retry action on a notification", () => {
    const onEditUserPrompt = vi.fn();
    const onBranch = vi.fn();
    const { container } = renderTurn(turnFor(WATCH_NOTICE), {
      onEditUserPrompt,
      onBranch,
      onRetry: vi.fn(),
    });

    // Nothing here is the user's to re-send or fork from: resubmitting machine
    // scaffolding would just confuse the agent.
    expect(container.querySelector(".agent-turn-actions")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("still renders a message the user actually wrote as a bubble", () => {
    const { container } = renderTurn(turnFor("Start the build in the background"), {
      onEditUserPrompt: vi.fn(),
    });

    expect(container.querySelector(".agent-process-notice")).toBeNull();
    expect(container.querySelector(".agent-user-turn")).not.toBeNull();
    expect(screen.getByText("Start the build in the background")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit message" })).toBeTruthy();
  });
});
