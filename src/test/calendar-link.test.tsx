import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  calendarAccessState: vi.fn(),
  calendarRequestAccess: vi.fn(),
  calendarLinkNote: vi.fn(),
  calendarAttachNote: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  ...tauriMocks,
}));

import { MeetingAmbiguityPrompt, MeetingBadge } from "../components/calendar/MeetingContext";
import { ensureCalendarAccess, linkRecordingToMeeting } from "../lib/calendar-link";

const EVENT = {
  id: "e1",
  title: "Point produit",
  start: 1_760_000_000,
  end: 1_760_001_800,
  allDay: false,
  attendees: ["Marie", "Tom"],
};

beforeEach(() => {
  for (const mock of Object.values(tauriMocks)) mock.mockReset();
  localStorage.clear();
});

describe("calendar access", () => {
  it("asks the system once, at the moment it pays off", async () => {
    tauriMocks.calendarAccessState.mockResolvedValue("notDetermined");
    tauriMocks.calendarRequestAccess.mockResolvedValue("granted");
    expect(await ensureCalendarAccess()).toBe(true);
    expect(tauriMocks.calendarRequestAccess).toHaveBeenCalledTimes(1);

    // A refusal is not re-asked on every later recording.
    tauriMocks.calendarAccessState.mockResolvedValue("notDetermined");
    tauriMocks.calendarRequestAccess.mockResolvedValue("denied");
    expect(await ensureCalendarAccess()).toBe(false);
    expect(tauriMocks.calendarRequestAccess).toHaveBeenCalledTimes(1);
  });

  it("never asks again once the system has answered", async () => {
    tauriMocks.calendarAccessState.mockResolvedValue("denied");
    expect(await ensureCalendarAccess()).toBe(false);
    tauriMocks.calendarAccessState.mockResolvedValue("granted");
    expect(await ensureCalendarAccess()).toBe(true);
    expect(tauriMocks.calendarRequestAccess).not.toHaveBeenCalled();
  });
});

describe("linking a recording", () => {
  it("attaches the single match", async () => {
    tauriMocks.calendarAccessState.mockResolvedValue("granted");
    tauriMocks.calendarLinkNote.mockResolvedValue({ kind: "one", events: EVENT });
    const match = await linkRecordingToMeeting("note-1", 1_760_000_100);
    expect(match).toEqual({ kind: "one", events: EVENT });
    expect(tauriMocks.calendarLinkNote).toHaveBeenCalledWith("note-1", 1_760_000_100);
  });

  it("costs a recording nothing when the calendar cannot be read", async () => {
    // No permission: never even calls through.
    tauriMocks.calendarAccessState.mockResolvedValue("denied");
    expect(await linkRecordingToMeeting("note-1")).toEqual({ kind: "none" });
    expect(tauriMocks.calendarLinkNote).not.toHaveBeenCalled();

    // And a command that throws is swallowed, not surfaced.
    tauriMocks.calendarAccessState.mockResolvedValue("granted");
    tauriMocks.calendarLinkNote.mockRejectedValue(new Error("EventKit is unhappy"));
    expect(await linkRecordingToMeeting("note-1")).toEqual({ kind: "none" });

    // As is a platform with no calendar at all.
    tauriMocks.calendarAccessState.mockResolvedValue("unsupported");
    expect(await linkRecordingToMeeting("note-1")).toEqual({ kind: "none" });
  });
});

describe("the two calendar surfaces", () => {
  it("shows when it was scheduled and who was invited, overflowing past three", () => {
    render(
      <MeetingBadge
        scheduledStart="2026-08-22T09:00:00Z"
        attendees={["Marie", "Tom", "Ana", "Sam"]}
      />,
    );
    expect(screen.getByText(/Marie, Tom, Ana \+1/)).toBeInTheDocument();
  });

  it("renders nothing for a note with no event", () => {
    const { container } = render(<MeetingBadge attendees={[]} />);
    expect(container).toBeEmptyDOMElement();
    // A malformed timestamp is also nothing, never a crash or "Invalid Date".
    const bad = render(<MeetingBadge scheduledStart="not a date" />);
    expect(bad.container).toBeEmptyDOMElement();
  });

  it("asks once, and takes 'neither' as a real answer", async () => {
    tauriMocks.calendarAttachNote.mockResolvedValue(null);
    const resolved = vi.fn();
    render(
      <MeetingAmbiguityPrompt
        noteId="note-1"
        events={[EVENT, { ...EVENT, id: "e2", title: "Bloc de travail" }]}
        onResolved={resolved}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Neither" }));
    await vi.waitFor(() => expect(resolved).toHaveBeenCalledWith(null));
    // Detaching passes no event id — that is the undo, too.
    expect(tauriMocks.calendarAttachNote).toHaveBeenCalledWith("note-1", null);
  });

  it("attaches the meeting the user picks", async () => {
    tauriMocks.calendarAttachNote.mockResolvedValue(EVENT);
    const resolved = vi.fn();
    render(<MeetingAmbiguityPrompt noteId="note-1" events={[EVENT]} onResolved={resolved} />);
    fireEvent.click(screen.getByRole("button", { name: /Point produit/ }));
    await vi.waitFor(() => expect(resolved).toHaveBeenCalledWith(EVENT));
    expect(tauriMocks.calendarAttachNote).toHaveBeenCalledWith("note-1", "e1");
  });
});
