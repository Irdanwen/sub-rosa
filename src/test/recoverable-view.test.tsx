import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverableView } from "../app/recoverable-view";

beforeEach(() => {
  // React/jsdom report intentionally thrown render errors to the console.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("recoverable views", () => {
  it("shows an accessible loading state until the chunk arrives", async () => {
    let resolve: (value: { default: () => JSX.Element }) => void = () => {};
    const View = recoverableView(
      () =>
        new Promise<{ default: () => JSX.Element }>((done) => {
          resolve = done;
        }),
    );
    render(<View />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    await act(async () => resolve({ default: () => <p>Ready</p> }));
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("actually reloads a rejected lazy import and preserves the current props", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("Chunk unavailable"))
      .mockResolvedValue({ default: ({ label }: { label: string }) => <p>{label}</p> });
    const View = recoverableView<{ label: string }>(load);
    const { rerender } = render(<View label="First view" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This view could not be displayed");
    rerender(<View label="Current view" />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Current view")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("contains a render crash while keeping the surrounding shell usable", async () => {
    let failed = true;
    const View = recoverableView(async () => ({
      default: () => {
        if (failed) throw new Error("Private content must not appear in the error UI");
        return <p>Recovered view</p>;
      },
    }));
    render(
      <>
        <input aria-label="Another draft" defaultValue="Keep my draft" />
        <View />
      </>,
    );
    await screen.findByRole("alert");
    expect(screen.queryByText(/Private content/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload app" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Still editable" } });
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Recovered view")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Still editable");
  });

  it("keeps recovery available after repeated failures without retrying automatically", async () => {
    const load = vi.fn().mockRejectedValue(new Error("Still unavailable"));
    const View = recoverableView(load, { fullScreen: true });
    render(<View />);
    await screen.findByRole("alert");
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("alert");
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Reload app" })).toBeInTheDocument();
    expect(screen.getByText(/Unsaved edits may be lost/)).toBeInTheDocument();
  });
});
