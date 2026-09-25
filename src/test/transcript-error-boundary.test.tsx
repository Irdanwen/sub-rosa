import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TranscriptErrorBoundary } from "../components/agent/TranscriptErrorBoundary";

function Row({ text, broken }: { text: string; broken?: boolean }) {
  if (broken) throw new Error("bad part");
  return <p>{text}</p>;
}

describe("TranscriptErrorBoundary", () => {
  it("replaces only the message that failed and keeps the rest readable", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <TranscriptErrorBoundary scope="conversation">
        <TranscriptErrorBoundary scope="message">
          <Row text="First message" />
        </TranscriptErrorBoundary>
        <TranscriptErrorBoundary scope="message">
          <Row text="Second message" broken />
        </TranscriptErrorBoundary>
      </TranscriptErrorBoundary>,
    );
    expect(screen.getByText("First message")).toBeInTheDocument();
    expect(screen.getByText("This message could not be displayed.")).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("tries again when the data it failed on changes", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <TranscriptErrorBoundary scope="message" resetKey={1}>
        <Row text="Streaming" broken />
      </TranscriptErrorBoundary>,
    );
    expect(screen.getByText("This message could not be displayed.")).toBeInTheDocument();
    rerender(
      <TranscriptErrorBoundary scope="message" resetKey={2}>
        <Row text="Streaming, now whole" />
      </TranscriptErrorBoundary>,
    );
    expect(screen.getByText("Streaming, now whole")).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
