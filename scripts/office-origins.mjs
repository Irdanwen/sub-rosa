// The two origins of the Office add-ins (ADR-0102, addendum of 2026-10-10).
//
// The task panes run Microsoft's Office.js, which cannot be pinned, so they
// live on an origin of their own: nothing there reaches the account's
// storage, its vault or its CSRF token. The account origin keeps the session
// and serves the one page the panes need from it, the courier frame. Both
// origins are fixed at build time, by the office build (both) and by the
// website build (the office origin, which the courier answers and only).

export const PRODUCTION_ACCOUNT_ORIGIN = "https://subrosa.furetier.com";
export const PRODUCTION_OFFICE_ORIGIN = "https://office.subrosa.furetier.com";

/** Hosts that can never be public: a plain HTTP origin is accepted only there
 * (the dev servers and the headless smoke). */
const local = (url) =>
  url.protocol === "http:" &&
  (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".test"));

/** `value` if it is an HTTPS origin without a path (or a local HTTP one). */
export function checkOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS origin without a path.`);
  }
  if ((url.protocol !== "https:" && !local(url)) || url.origin !== value)
    throw new Error(`${name} must be an HTTPS origin without a path.`);
  return value;
}

/** The registrable part, as far as these two hosts need it: the last two labels. */
const siteOf = (origin) => new URL(origin).hostname.split(".").slice(-2).join(".");

/**
 * The account and office origins a build bakes in: the environment's, or
 * production's. They must differ (the point of the second origin) and be the
 * same site, or the account's `SameSite=Lax` cookie would not reach the
 * courier frame the sign-in window embeds.
 */
export function officeOrigins(env = {}) {
  const account = checkOrigin(
    env.VITE_ACCOUNT_ORIGIN || PRODUCTION_ACCOUNT_ORIGIN,
    "VITE_ACCOUNT_ORIGIN",
  );
  const office = checkOrigin(
    env.VITE_OFFICE_ORIGIN || PRODUCTION_OFFICE_ORIGIN,
    "VITE_OFFICE_ORIGIN",
  );
  if (account === office)
    throw new Error("The Office add-ins need an origin of their own, apart from the account's.");
  if (siteOf(account) !== siteOf(office))
    throw new Error("The Office origin must be on the same site as the account origin.");
  return { account, office };
}
