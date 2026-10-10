import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { accountConfigure, accountLoginOpen, accountStatus } from "./account";
import { t } from "./i18n";
import { isMobilePlatform } from "./mobile";
import { type CarpeDiemSettingsDto, openExternalUrl } from "./tauri";

/**
 * Device keys (ADR-0069): a Carpe Diem key created for this device from the
 * Sub Rosa account, so an email address is enough to start. The key itself
 * never crosses into the webview; these calls only say how it went.
 */
export type IssueOutcome = {
  status: "issued" | "confirmation_required";
  /** The six characters the confirmation page asks for. */
  code?: string;
  expiresAt?: string;
  /** The masked address the confirmation was sent to. */
  emailHint?: string;
};

export type IssuanceStatus = {
  /** Carpe Diem can create keys for Sub Rosa accounts. */
  keyIssuance: boolean;
  /** Carpe Diem sells credits by card. */
  fiat: boolean;
  /** The key on this device was created for it from the account. */
  issued: boolean;
  /** A confirmation by mail is still waiting. */
  pending?: IssueOutcome;
  /** Countries where Carpe Diem sells nothing (ISO 3166-1 alpha-2). */
  blockedCountries: string[];
};

export const carpeDiemIssuanceStatus = () => invoke<IssuanceStatus>("carpe_diem_issuance_status");
/** `reactivate` only after the person chose a new, empty Carpe Diem account
 * on the screen that said theirs was deleted (`carpe_diem_account_closed`). */
export const carpeDiemIssueKey = ({ reactivate = false }: { reactivate?: boolean } = {}) =>
  reactivate
    ? invoke<IssueOutcome>("carpe_diem_issue_key", { reactivate: true })
    : invoke<IssueOutcome>("carpe_diem_issue_key");
export const carpeDiemIssuePoll = () => invoke<IssueOutcome>("carpe_diem_issue_poll");
export const carpeDiemIssueCancel = () => invoke<void>("carpe_diem_issue_cancel");
export const carpeDiemRevokeIssuedKey = () => invoke<void>("carpe_diem_revoke_issued_key");

/** When Carpe Diem says the linked account was deleted, from a
 * `carpe_diem_account_closed` error; null when it gave no readable date. */
export function accountClosedAt(cause: unknown): Date | null {
  const details = (cause as { details?: { closedAt?: unknown } } | null | undefined)?.details;
  if (typeof details?.closedAt !== "string") return null;
  const at = new Date(details.closedAt);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Where the stored key came from. Only issued keys say so. */
export function keyOrigin(settings: CarpeDiemSettingsDto | null | undefined): "issued" | null {
  return (settings as (CarpeDiemSettingsDto & { keyOrigin?: string }) | null | undefined)
    ?.keyOrigin === "issued"
    ? "issued"
    : null;
}

/** Carpe Diem's published purchase refusals, for when it cannot be asked. */
export const DEFAULT_BLOCKED_COUNTRIES = [
  "IR",
  "KP",
  "CU",
  "SY",
  "SD",
  "SS",
  "MM",
  "RU",
  "BY",
  "US",
];

const NOT_AVAILABLE: IssuanceStatus = {
  keyIssuance: false,
  fiat: false,
  issued: false,
  blockedCountries: DEFAULT_BLOCKED_COUNTRIES,
};

/**
 * Asks once whether the account can create keys here. `null` while the answer
 * is on its way, and a plain "no" when it cannot be had: before Carpe Diem
 * ships the routes, every new path simply stays hidden.
 */
export function useIssuanceStatus(): IssuanceStatus | null {
  const [status, setStatus] = useState<IssuanceStatus | null>(null);
  useEffect(() => {
    let live = true;
    carpeDiemIssuanceStatus().then(
      (next) => {
        if (live) setStatus(next && typeof next === "object" ? next : NOT_AVAILABLE);
      },
      () => {
        if (live) setStatus(NOT_AVAILABLE);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return status;
}

export function defaultDeviceName() {
  return isMobilePlatform() ? t("My iPhone") : t("My computer");
}

/**
 * Opens the real account page to sign in, or to create the account when
 * `signup` is set. The page hands the app back through `subrosa://auth/callback`
 * and the Rust side finishes the exchange; callers listen for
 * `subrosa://account-updated`. Resolves with the start link so a screen can
 * offer to reopen it, and with `opened: false` when no browser came up.
 */
export async function openAccountSignIn({
  signup = false,
  deviceName,
}: {
  signup?: boolean;
  deviceName?: string;
} = {}) {
  const status = await accountStatus();
  await accountConfigure(status.server_url ?? status.default_server_url);
  const login = await accountLoginOpen(deviceName?.trim() || defaultDeviceName());
  const startUrl = signup ? withSignupIntent(login.start_url) : login.start_url;
  const opened = await openExternalUrl(startUrl);
  return { login: { ...login, start_url: startUrl }, opened };
}

/** The account page opens on its registration form instead of sign-in. */
export function withSignupIntent(startUrl: string) {
  try {
    const url = new URL(startUrl);
    url.searchParams.set("intent", "signup");
    return url.toString();
  } catch {
    return startUrl;
  }
}
