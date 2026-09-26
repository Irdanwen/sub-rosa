import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("offers to try again, for a failure the data will not change", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let broken = true;
    function Flaky() {
      if (broken) throw new Error("transient");
      return <p>Rendered after all</p>;
    }
    render(
      <TranscriptErrorBoundary scope="message" resetKey="same">
        <Flaky />
      </TranscriptErrorBoundary>,
    );
    expect(screen.getByText("This message could not be displayed.")).toBeInTheDocument();
    broken = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Rendered after all")).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("tries again when any of several keys changes", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const turn = { id: "t1" };
    const { rerender } = render(
      <TranscriptErrorBoundary scope="message" resetKey={[turn, "thinking-closed"]}>
        <Row text="Row" broken />
      </TranscriptErrorBoundary>,
    );
    // Same turn, same other props: a fresh array alone is not a change, so the
    // row is not re-attempted (and does not fail again) on every parent render.
    const failuresLogged = consoleError.mock.calls.length;
    rerender(
      <TranscriptErrorBoundary scope="message" resetKey={[turn, "thinking-closed"]}>
        <Row text="Row" broken />
      </TranscriptErrorBoundary>,
    );
    expect(screen.getByText("This message could not be displayed.")).toBeInTheDocument();
    expect(consoleError.mock.calls.length).toBe(failuresLogged);
    // Another prop the row reads changed: that is worth another attempt.
    rerender(
      <TranscriptErrorBoundary scope="message" resetKey={[turn, "thinking-open"]}>
        <Row text="Row, now whole" />
      </TranscriptErrorBoundary>,
    );
    expect(screen.getByText("Row, now whole")).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
