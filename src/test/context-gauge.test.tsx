import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ContextGauge } from "../components/chat/ContextGauge";
import {
  CONTEXT_WARNING_RATIO,
  estimateTokens,
  formatTokenCount,
  readContextGauge,
  SYSTEM_ALLOWANCE_TOKENS,
} from "../lib/context-gauge";

describe("context gauge", () => {
  it("estimates four characters to a token, rounding up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("counts the messages, the draft and the system allowance", () => {
    const reading = readContextGauge({
      messages: [{ content: "a".repeat(400) }, { content: "b".repeat(400) }],
      draft: "c".repeat(40),
      contextTokens: 100_000,
    });
    expect(reading).toEqual({
      used: SYSTEM_ALLOWANCE_TOKENS + 210,
      total: 100_000,
      ratio: (SYSTEM_ALLOWANCE_TOKENS + 210) / 100_000,
      tone: "normal",
    });
  });

  it("warns past four fifths and never reads past full", () => {
    const total = 10_000;
    const nearlyFull = readContextGauge({
      messages: [{ content: "x".repeat((total * CONTEXT_WARNING_RATIO + 1) * 4) }],
      contextTokens: total,
    });
    expect(nearlyFull?.tone).toBe("warning");
    const over = readContextGauge({
      messages: [{ content: "x".repeat(total * 8) }],
      contextTokens: total,
    });
    expect(over?.ratio).toBe(1);
  });

  it("draws nothing when the model's window is unknown", () => {
    expect(readContextGauge({ messages: [], contextTokens: undefined })).toBeNull();
    expect(readContextGauge({ messages: [], contextTokens: 0 })).toBeNull();
  });

  it("formats counts the way a person reads them", () => {
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(12_400)).toBe("12K");
    expect(formatTokenCount(200_000)).toBe("200K");
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
  });

  it("shows the figure on tap and suggests a new chat when nearly full", async () => {
    const onNewChat = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <ContextGauge
        reading={{ used: 12_000, total: 200_000, ratio: 0.06, tone: "normal" }}
        onNewChat={onNewChat}
      />,
    );
    const ring = screen.getByRole("button", { name: "About 12K of 200K tokens used" });
    await user.click(ring);
    expect(screen.getByRole("status")).toHaveTextContent("About 12K of 200K tokens used");
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();

    rerender(
      <ContextGauge
        reading={{ used: 180_000, total: 200_000, ratio: 0.9, tone: "warning" }}
        onNewChat={onNewChat}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("This chat is getting long.");
    // A plain click: jsdom reports the move onto the bubble as leaving the gauge.
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders nothing without a reading", () => {
    const { container } = render(<ContextGauge reading={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
