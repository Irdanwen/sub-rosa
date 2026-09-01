import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NoteRow } from "../components/mobile/screens/NoteRow";

/**
 * A note's actions must be reachable without knowing to swipe.
 *
 * Archiving and deleting were behind a swipe and nowhere else: a shortcut
 * standing in for a route. Apple ships both on the same row, and so does this
 * now. The long press is the discoverable half, and the assertion that matters
 * most is the last one -- the browser synthesises a click when a long press
 * ends, and without swallowing it the sheet opens over a note that has just
 * been opened behind it.
 */

const note = {
  id: "n1",
  title: "Séance TPG",
  preview: "Pour la modification de l'armoire",
  processingStatus: "ready" as const,
  folderIds: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function press(row: HTMLElement, ms: number) {
  fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] });
  vi.advanceTimersByTime(ms);
  fireEvent.touchEnd(row, { touches: [] });
}

describe("a note row", () => {
  it("opens the note on a tap", () => {
    const onSelect = vi.fn();
    const onLongPress = vi.fn();
    render(<NoteRow note={note} onSelect={onSelect} onLongPress={onLongPress} />);

    screen.getByRole("button").click();

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("opens the actions on a held press", () => {
    vi.useFakeTimers();
    try {
      const onSelect = vi.fn();
      const onLongPress = vi.fn();
      render(<NoteRow note={note} onSelect={onSelect} onLongPress={onLongPress} />);

      press(screen.getByRole("button"), 600);

      expect(onLongPress).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire when the finger is scrolling", () => {
    vi.useFakeTimers();
    try {
      const onLongPress = vi.fn();
      render(<NoteRow note={note} onSelect={vi.fn()} onLongPress={onLongPress} />);
      const row = screen.getByRole("button");

      fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] });
      fireEvent.touchMove(row, { touches: [{ clientX: 10, clientY: 60 }] });
      vi.advanceTimersByTime(600);

      expect(onLongPress).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows the click a long press leaves behind", () => {
    vi.useFakeTimers();
    try {
      const onSelect = vi.fn();
      const onLongPress = vi.fn();
      render(<NoteRow note={note} onSelect={onSelect} onLongPress={onLongPress} />);
      const row = screen.getByRole("button");

      press(row, 600);
      row.click();

      expect(onLongPress).toHaveBeenCalledOnce();
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
