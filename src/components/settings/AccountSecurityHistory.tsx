import { useCallback, useEffect, useRef, useState } from "react";
import { accountSecurityEvents, type SecurityEvent } from "../../lib/account";
import { intlLocale, t } from "../../lib/i18n";
import { openExternalUrl } from "../../lib/tauri";

/** The account site's copy of the same list, kept as a link. */
export function securityHistoryUrl(serverUrl: string): string {
  return new URL("/account#security-history", serverUrl).toString();
}

/** What a line says, in the website's words. An unknown kind still renders,
 * as plain account activity, so a service that learned a new kind never
 * blanks the list. */
export function securityEventLabel(kind: string): string {
  switch (kind) {
    case "signed_in":
      return t("Signed in on the website");
    case "signed_in_passkey":
      return t("Signed in on the website with a passkey");
    case "signed_out":
      return t("Signed out");
    case "device_added":
      return t("New device connected");
    case "device_signed_in":
      return t("Device signed in again");
    case "device_renamed":
      return t("Device renamed");
    case "device_revoked":
      return t("Device revoked");
    case "device_signed_out":
      return t("Device signed out");
    case "refresh_reuse_blocked":
      return t("Reused session token blocked and the device signed out");
    case "pairing_approved":
      return t("Vault key sent to another device");
    case "passkey_added":
      return t("Passkey added");
    case "passkey_removed":
      return t("Passkey removed");
    case "vault_created":
      return t("Encrypted vault created");
    case "vault_updated":
      return t("Encrypted vault updated");
    case "carpe_diem_key_requested":
      return t("Carpe Diem key requested for a device");
    case "carpe_diem_key_revoked":
      return t("Carpe Diem key revoked");
    case "sessions_reset":
      return t("All sessions ended after a service restore");
    default:
      return t("Account activity");
  }
}

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short" }).format(
        date,
      );
}

/**
 * The account's security history, read in the app with this device's own
 * session (ADR-0049 addendum): sign-ins, devices, passkeys, the vault and
 * Carpe Diem keys from the last 90 days, newest first. Read only; the remedy
 * for a line you do not recognise is the device list on this same screen.
 */
export function AccountSecurityHistory({ serverUrl }: { serverUrl: string | null }) {
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const load = useCallback(() => {
    const current = ++generation.current;
    setFailed(false);
    setEvents(null);
    accountSecurityEvents()
      .then((next) => {
        if (current !== generation.current) return;
        // Rust parses the list; anything else is a shell this screen does not know.
        if (Array.isArray(next)) setEvents(next);
        else setFailed(true);
      })
      .catch(() => {
        if (current === generation.current) setFailed(true);
      });
  }, []);
  useEffect(() => {
    load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  return (
    <div className="settings-card account-card">
      <h3 className="settings-row-title">{t("Security history")}</h3>
      <p className="settings-row-description">
        {t(
          "Sign-ins, devices, passkeys and keys from the last 90 days. Sub Rosa does not record addresses or locations. If a line looks unfamiliar, revoke that device from your devices.",
        )}
      </p>
      {failed ? (
        <div className="account-actions">
          <p className="settings-row-error" role="alert">
            {t("We could not load your security history. Check your connection and try again.")}
          </p>
          <button type="button" className="btn btn-secondary" onClick={load}>
            {t("Try again")}
          </button>
        </div>
      ) : events === null ? (
        <p className="settings-row-description" role="status">
          {t("Loading security history")}
        </p>
      ) : events.length === 0 ? (
        <p className="settings-row-description">{t("Nothing recorded in the last 90 days.")}</p>
      ) : (
        <ul className="account-security-history">
          {events.map((event) => (
            <li key={event.id}>
              <span>
                <strong>{securityEventLabel(event.kind)}</strong>
                {event.deviceName ? (
                  <span className="settings-row-description"> · {event.deviceName}</span>
                ) : null}
              </span>
              <time className="settings-row-description" dateTime={event.occurredAt}>
                {formatWhen(event.occurredAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
      {serverUrl ? (
        <div className="account-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void openExternalUrl(securityHistoryUrl(serverUrl))}
          >
            {t("Open on the web")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
