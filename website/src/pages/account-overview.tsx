import { useEffect, useState } from "react";
import { api, type Account, type Device } from "../lib/api";
import { date, number, t } from "../lib/i18n";
import { useLiveBalance } from "./browser-device";

/**
 * The account at a glance, before anything is unlocked: what is connected,
 * whether the vault is open here, and where credits come from. Nothing on it
 * needs the vault, so a person sees where they stand in one read and opens
 * the vault only for the page that needs it.
 */
export function AccountStatus({
  account,
  vaultOpen,
  onLock,
}: {
  account: Account;
  vaultOpen: boolean;
  onLock: () => void;
}) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [live] = useLiveBalance(account.id);
  useEffect(() => {
    const controller = new AbortController();
    api<Device[]>("/api/v1/devices", { signal: controller.signal })
      .then((list) => {
        if (!controller.signal.aborted) setDevices(list);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);
  const active = (devices ?? []).filter((device) => !device.revoked_at);
  const lastSeen = active
    .map((device) => device.last_seen_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  return (
    <section
      className="account-status"
      aria-label={t("Your account at a glance", "Votre compte en un coup d’œil")}
    >
      <div className="account-status-row">
        <span className="account-status-label">{t("Signed in", "Connecté")}</span>
        <span className="account-status-value">{account.email}</span>
      </div>
      <div className="account-status-row">
        <span className="account-status-label">{t("Devices", "Appareils")}</span>
        <span className="account-status-value" role="status">
          {failed
            ? t("Could not be listed right now.", "Impossible de les lister pour l’instant.")
            : devices === null
              ? t("Checking…", "Vérification…")
              : active.length === 0
                ? t("None connected yet.", "Aucun appareil connecté pour l’instant.")
                : active.length === 1
                  ? t("1 connected", "1 connecté")
                  : t(`${number(active.length)} connected`, `${number(active.length)} connectés`)}
          {lastSeen ? (
            <span className="account-status-detail">
              {t(`Last active ${date(lastSeen)}`, `Dernière activité le ${date(lastSeen)}`)}
            </span>
          ) : null}
        </span>
        <a className="text-link" href="/account/devices">
          {t("Manage", "Gérer")}
        </a>
      </div>
      <div className="account-status-row">
        <span className="account-status-label">{t("Vault", "Coffre")}</span>
        <span className="account-status-value">
          {vaultOpen
            ? t("Open in this tab.", "Ouvert dans cet onglet.")
            : t("Locked.", "Verrouillé.")}
          <span className="account-status-detail">
            {vaultOpen
              ? t(
                  "It locks again after 15 minutes without activity.",
                  "Il se verrouille après 15 minutes sans activité.",
                )
              : t(
                  "Your notes, key and usage stay encrypted until a page needs them.",
                  "Vos notes, votre clé et votre consommation restent chiffrées tant qu’une page n’en a pas besoin.",
                )}
          </span>
        </span>
        {vaultOpen ? (
          <button className="button" type="button" onClick={onLock}>
            {t("Lock", "Verrouiller")}
          </button>
        ) : null}
      </div>
      <div className="account-status-row">
        <span className="account-status-label">{t("Credits", "Crédits")}</span>
        <span className="account-status-value">
          {live.status === "ok"
            ? t(
                `${number(live.available, 2)} credits available`,
                `${number(live.available, 2)} crédits disponibles`,
              )
            : t("Bought at Carpe Diem.", "Achetés chez Carpe Diem.")}
          <span className="account-status-detail">
            {live.status === "ok"
              ? t(
                  `Read from Carpe Diem with this browser’s key, ${date(live.at)}.`,
                  `Lu chez Carpe Diem avec la clé de ce navigateur, ${date(live.at)}.`,
                )
              : live.status === "failed"
                ? t(
                    "Carpe Diem did not answer. Your balance also shows in the app and under Usage.",
                    "Carpe Diem n’a pas répondu. Votre solde s’affiche aussi dans l’app et sous Consommation.",
                  )
                : t(
                    "Your balance shows in the app and under Usage.",
                    "Votre solde s’affiche dans l’app et sous Consommation.",
                  )}
          </span>
        </span>
        <a className="text-link" href="/account/top-up">
          {t("Top up", "Recharger")}
        </a>
      </div>
    </section>
  );
}

/** Why a page asks for the vault, in one sentence, before the form. */
export function vaultPurpose(section: string): string | undefined {
  switch (section) {
    case "/account/library":
      return t(
        "Your notes are encrypted. Open the vault to read them here.",
        "Vos notes sont chiffrées. Ouvrez le coffre pour les lire ici.",
      );
    case "/account/provider":
      return t(
        "Your Carpe Diem key is encrypted. Open the vault to see or change it.",
        "Votre clé Carpe Diem est chiffrée. Ouvrez le coffre pour la voir ou la changer.",
      );
    case "/account/usage":
      return t(
        "Your usage is read with your key. Open the vault to show it.",
        "Votre consommation se lit avec votre clé. Ouvrez le coffre pour l’afficher.",
      );
    case "/account/devices":
    case "/account/pair":
      return t(
        "Approving a new device hands it your vault. Open it first.",
        "Approuver un nouvel appareil lui confie votre coffre. Ouvrez-le d’abord.",
      );
    default:
      return undefined;
  }
}
