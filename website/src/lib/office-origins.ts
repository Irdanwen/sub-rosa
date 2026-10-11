/**
 * The origins the Office add-ins span (ADR-0102, addendum of 2026-10-10),
 * fixed at build time by `scripts/office-origins.mjs`: the panes and their
 * sign-in window run on the office origin, the session and the courier frame
 * stay on the account origin.
 */

/** Where the task panes run. The courier frame answers this origin only. */
export const OFFICE_ORIGIN: string =
  import.meta.env.VITE_OFFICE_ORIGIN || "https://office.subrosa.furetier.com";

/**
 * Where the account service answers: this page's own origin, unless the build
 * names another. The office build always does, so a pane signs its device
 * proofs for the URL the service checks (`public_url` and the path), never
 * for its own origin.
 */
export function accountOrigin(): string {
  return import.meta.env.VITE_ACCOUNT_ORIGIN || location.origin;
}
