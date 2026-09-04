/**
 * Linking a recording to the meeting it belongs to.
 *
 * The rule, in one place for both shells: ask for calendar access at the
 * first recording (the moment it pays off, never at launch), then attach the
 * event the recording started inside. One candidate attaches silently and
 * names an untitled note; several are handed back so the shell can ask, once;
 * none leaves the note exactly as the app has always made it.
 *
 * Every failure here is silent by design. A calendar we cannot read must
 * never cost the user a recording — that is the whole point of asking late.
 */

import { intlLocale } from "./i18n";
import {
  type CalendarEventDto,
  type CalendarMatch,
  calendarAccessState,
  calendarLinkNote,
  calendarRequestAccess,
} from "./tauri";

/** Remembers that we already put the system dialog in front of the user, so
 * a refusal is not re-asked on every recording. (The OS only shows it once
 * anyway; this keeps us from calling into it needlessly.) */
const ASKED_KEY = "os-june:calendar-asked";

function alreadyAsked(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === "true";
  } catch {
    // Sandboxed storage: treat as "not asked", the OS still decides.
    return false;
  }
}

function rememberAsked() {
  try {
    localStorage.setItem(ASKED_KEY, "true");
  } catch {
    // Best-effort.
  }
}

/**
 * Ensures we know whether we may read the day, asking the system at most
 * once. Returns true only when reading is actually allowed.
 */
export async function ensureCalendarAccess(): Promise<boolean> {
  try {
    const state = await calendarAccessState();
    if (state === "granted") return true;
    if (state !== "notDetermined") return false;
    if (alreadyAsked()) return false;
    rememberAsked();
    return (await calendarRequestAccess()) === "granted";
  } catch {
    return false;
  }
}

/**
 * Attaches the meeting a recording belongs to, if there is one.
 *
 * `startedAt` is epoch seconds. Returns the match so a shell can ask about an
 * ambiguity; callers that do not care can ignore it entirely — the single
 * match has already been written by the time this resolves.
 */
export async function linkRecordingToMeeting(
  noteId: string,
  startedAt: number = Math.floor(Date.now() / 1000),
): Promise<CalendarMatch> {
  const allowed = await ensureCalendarAccess();
  if (!allowed) return { kind: "none" };
  try {
    return await calendarLinkNote(noteId, startedAt);
  } catch {
    return { kind: "none" };
  }
}

/** The one-line summary a shell shows on a linked note. */
export function meetingSummary(event: CalendarEventDto): string {
  const when = new Date(event.start * 1000).toLocaleString(intlLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const who =
    event.attendees.length > 0
      ? ` · ${event.attendees.slice(0, 3).join(", ")}${
          event.attendees.length > 3 ? ` +${event.attendees.length - 3}` : ""
        }`
      : "";
  return `${when}${who}`;
}
