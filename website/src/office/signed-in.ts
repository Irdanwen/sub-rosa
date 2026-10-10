/**
 * `/office/signed-in.html` (ADR-0102, addendum of 2026-10-10): where the
 * account service sends the Office sign-in window after signing in. The
 * service only returns to paths of its own origin, so this page hands the
 * window back to the office origin's sign-in window, at a URL fixed by the
 * build: nothing in the address can choose where it goes.
 */
import { OFFICE_ORIGIN } from "../lib/office-origins";

export const SESSION_WINDOW_URL = `${OFFICE_ORIGIN}/office/session.html`;

export function returnToSessionWindow(target: Pick<Location, "replace"> = location) {
  target.replace(SESSION_WINDOW_URL);
}
