import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { openModalCount, useModalFocus } from "../lib/modal-focus";

function Surface({
  name,
  onClose,
  open = true,
  empty = false,
}: {
  name: string;
  onClose?: () => void;
  open?: boolean;
  empty?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, { open, onClose });
  if (!open) return null;
  return (
    <div ref={ref} role="dialog" aria-label={name} tabIndex={-1}>
      {empty ? null : (
        <>
          <button type="button">{name} first</button>
          <button type="button">{name} last</button>
        </>
      )}
    </div>
  );
}

describe("useModalFocus", () => {
  it("moves focus inside on open and gives it back on close", () => {
    const outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.appendChild(outside);
    outside.focus();
    const view = render(<Surface name="a" />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "a first" }));
    view.unmount();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("keeps Tab and Shift+Tab inside", () => {
    render(<Surface name="a" />);
    const first = screen.getByRole("button", { name: "a first" });
    const last = screen.getByRole("button", { name: "a last" });
    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("keeps focus on an empty surface rather than letting Tab leave", () => {
    render(<Surface name="a" empty />);
    const surface = screen.getByRole("dialog", { name: "a" });
    expect(document.activeElement).toBe(surface);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(surface);
  });

  it("Escape closes only the surface on top, and the one below takes over after", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const view = render(
      <>
        <Surface name="a" onClose={closeA} />
        <Surface name="b" onClose={closeB} />
      </>,
    );
    expect(openModalCount()).toBe(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();
    act(() => {
      view.rerender(
        <>
          <Surface name="a" onClose={closeA} />
          <Surface name="b" onClose={closeB} open={false} />
        </>,
      );
    });
    expect(openModalCount()).toBe(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeA).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(openModalCount()).toBe(0);
  });
});
