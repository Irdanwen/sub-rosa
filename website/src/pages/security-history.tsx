import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SecurityEvent } from "../lib/api";
import { date, t } from "../lib/i18n";

/** The element the app links to: `/account#security-history`. */
export const SECURITY_HISTORY_ID = "security-history";
/** The service returns at most this many lines; anything more is not trusted. */
const MAX_EVENTS = 200;

/** What a line says. An unknown kind still renders, as plain account activity,
 * so a service that learned a new kind never blanks the list. */
export function securityEventLabel(kind: string): string {
  switch (kind) {
    case "signed_in":
      return t("Signed in on the website", "Connexion sur le site");
    case "signed_in_passkey":
      return t("Signed in on the website with a passkey", "Connexion sur le site avec une passkey");
    case "signed_out":
      return t("Signed out", "Déconnexion");
    case "device_added":
      return t("New device connected", "Nouvel appareil connecté");
    case "device_signed_in":
      return t("Device signed in again", "Appareil reconnecté");
    case "device_renamed":
      return t("Device renamed", "Appareil renommé");
    case "device_revoked":
      return t("Device revoked", "Appareil révoqué");
    case "device_signed_out":
      return t("Device signed out", "Appareil déconnecté");
    case "refresh_reuse_blocked":
      return t(
        "Reused session token blocked and the device signed out",
        "Jeton de session réutilisé bloqué et appareil déconnecté",
      );
    case "pairing_approved":
      return t("Vault key sent to another device", "Clé du coffre envoyée à un autre appareil");
    case "passkey_added":
      return t("Passkey added", "Passkey ajoutée");
    case "passkey_removed":
      return t("Passkey removed", "Passkey supprimée");
    case "vault_created":
      return t("Encrypted vault created", "Coffre chiffré créé");
    case "vault_updated":
      return t("Encrypted vault updated", "Coffre chiffré mis à jour");
    case "carpe_diem_key_requested":
      return t("Carpe Diem key requested for a device", "Clé Carpe Diem demandée pour un appareil");
    case "carpe_diem_key_revoked":
      return t("Carpe Diem key revoked", "Clé Carpe Diem révoquée");
    case "sessions_reset":
      return t(
        "All sessions ended after a service restore",
        "Toutes les sessions fermées après une restauration du service",
      );
    default:
      return t("Account activity", "Activité du compte");
  }
}

function valid(value: unknown): SecurityEvent[] {
  if (!Array.isArray(value)) throw new Error("Invalid security history");
  return value
    .filter(
      (event): event is SecurityEvent =>
        !!event &&
        typeof event.id === "string" &&
        typeof event.kind === "string" &&
        typeof event.occurred_at === "string" &&
        !Number.isNaN(Date.parse(event.occurred_at)) &&
        (event.device_name === null || typeof event.device_name === "string"),
    )
    .slice(0, MAX_EVENTS);
}

/**
 * What happened to this account's access in the last ninety days, newest
 * first: sign-ins, devices, passkeys, the vault and Carpe Diem keys. Read only.
 * The remedy for a line you do not recognise is on the devices page, which is
 * where the copy sends you.
 */
export function SecurityHistory() {
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const section = useRef<HTMLElement>(null);
  const scrolled = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    lifetime.current?.abort();
    const controller = new AbortController();
    lifetime.current = controller;
    setFailed(false);
    setEvents(null);
    api<unknown>("/api/v1/security-events", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setEvents(valid(value));
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
  }, []);
  useEffect(() => {
    load();
    return () => lifetime.current?.abort();
  }, [load]);
  // The page arrives before the list does, so the browser's own jump to the
  // fragment lands on nothing. Jump once, when there is something to land on.
  useEffect(() => {
    if (scrolled.current || (events === null && !failed)) return;
    if (location.hash !== `#${SECURITY_HISTORY_ID}`) return;
    scrolled.current = true;
    section.current?.scrollIntoView?.({ block: "start" });
  }, [events, failed]);
  return (
    <article
      className="card security-history"
      id={SECURITY_HISTORY_ID}
      ref={section}
      aria-labelledby={`${SECURITY_HISTORY_ID}-title`}
    >
      <h2 id={`${SECURITY_HISTORY_ID}-title`}>{t("Security history", "Historique de sécurité")}</h2>
      <p className="muted">
        {t(
          "Sign-ins, devices, passkeys and keys from the last 90 days. Sub Rosa does not record addresses or locations. If a line looks unfamiliar, revoke that device from your devices.",
          "Connexions, appareils, passkeys et clés des 90 derniers jours. Sub Rosa n’enregistre ni adresse ni lieu. Si une ligne ne vous dit rien, révoquez l’appareil concerné depuis vos appareils.",
        )}{" "}
        <a className="text-link" href="/account/devices">
          {t("Manage devices", "Gérer les appareils")}
        </a>
      </p>
      {failed ? (
        <div className="row">
          <p className="error" role="alert">
            {t(
              "We could not load your security history. Check your connection and try again.",
              "Impossible de charger votre historique de sécurité. Vérifiez votre connexion et réessayez.",
            )}
          </p>
          <button className="button" type="button" onClick={load}>
            {t("Try again", "Réessayer")}
          </button>
        </div>
      ) : events === null ? (
        <p role="status">{t("Loading…", "Chargement…")}</p>
      ) : events.length === 0 ? (
        <p>
          {t("Nothing recorded in the last 90 days.", "Rien d’enregistré ces 90 derniers jours.")}
        </p>
      ) : (
        <ul className="security-history-list">
          {events.map((event) => (
            <li key={event.id}>
              <span>
                <strong>{securityEventLabel(event.kind)}</strong>
                {event.device_name && <span className="muted"> · {event.device_name}</span>}
              </span>
              <time dateTime={event.occurred_at}>{date(event.occurred_at)}</time>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
