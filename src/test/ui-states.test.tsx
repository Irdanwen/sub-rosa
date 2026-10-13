import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmptyState, LoadFailed, NoMatches } from "../components/ui/EmptyState";
import { ErrorMessage } from "../components/ui/ErrorMessage";
import { ShimmerRows } from "../components/ui/Shimmer";
import { formatClock } from "../lib/wait-clock";

describe("the shared states (D6)", () => {
  it("keeps the panel empty state a labelled region with a heading", () => {
    render(<EmptyState label="Nothing yet" title="No notes yet" description="Record one." />);
    expect(screen.getByRole("region", { name: "Nothing yet" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No notes yet" })).toBeInTheDocument();
  });

  it("draws a compact state without a heading, read as a status", () => {
    render(<EmptyState size="compact" title="No toolsets reported" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("data-size", "compact");
    expect(status).toHaveTextContent("No toolsets reported");
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("announces a list that failed to load, and offers a retry only when it can help", () => {
    const retry = vi.fn();
    const { rerender } = render(
      <LoadFailed title="Couldn't load skills" message="Hermes timed out." onRetry={retry} />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load skills");
    expect(alert).toHaveTextContent("Hermes timed out.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);

    rerender(<LoadFailed title="Couldn't load skills" message="Permission denied." />);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("lets a search that found nothing be undone in one press", () => {
    const clear = vi.fn();
    render(<NoMatches message="No notes match “budget”." onClear={clear} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("gives placeholder rows one status line and hides the bars", () => {
    const { container } = render(<ShimmerRows count={3} label="Loading routines…" />);
    expect(screen.getByRole("status", { name: "Loading routines…" })).toBeInTheDocument();
    const rows = container.querySelectorAll(".shimmer-row");
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toHaveAttribute("aria-hidden", "true");
  });

  it("announces a failure next to the control that caused it", () => {
    render(<ErrorMessage>The clip could not be read.</ErrorMessage>);
    expect(screen.getByRole("alert")).toHaveTextContent("The clip could not be read.");
  });

  it("formats the wait clock the way the badge shows it", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(12 * 60_000 + 7_000)).toBe("12:07");
    expect(formatClock(82 * 60_000 + 40_000)).toBe("1:22:40");
    expect(formatClock(-5)).toBe("0:00");
  });
});
