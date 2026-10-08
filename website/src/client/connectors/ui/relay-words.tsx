/**
 * What the connectors panel and the call cards say about a connector one of
 * the person's apps runs for this tab (ADR-0107).
 */
import { t } from "../../../lib/i18n";
import type { FeatureHost } from "../../feature";
import type { CallRecord } from "../calls";
import { deviceLabel, messageText, type Offer, relayedConnectors } from "../relay";

/** The line under a connector this tab cannot reach: which device makes its
 * calls, or how to make one do it. */
export function relayText(offer: Offer | null, refusal: string): string {
  if (offer) {
    const device = deviceLabel(offer.deviceName);
    return t(
      `Your ${device} makes these calls for this page. It needs to be open, with Sub Rosa running.`,
      `Votre ${device} fait ces appels pour cette page. Il doit être allumé, avec Sub Rosa ouvert.`,
    );
  }
  return `${refusal} ${t(
    "Or, in the app on a computer where it is signed in, turn on “Run connectors for my browser” in Settings, Connectors, and use it here.",
    "Ou, dans l’app sur un ordinateur où il est connecté, activez « Exécuter les connecteurs pour mon navigateur » dans Réglages, Connecteurs, et utilisez-le ici.",
  )}`;
}

/** A relayed call's state, while it waits for its device. */
export function relayStatus(call: CallRecord): string | null {
  if (!call.relay?.errandId || call.status !== "running") return null;
  const device = deviceLabel(call.relay.deviceName);
  return t(`Waiting for your ${device}…`, `En attente de votre ${device}…`);
}

/** A relayed call's failure, in the page's language when it is one of the
 * relay's own sentences. */
export function relayError(call: CallRecord): string | null {
  return call.error ? messageText(call.error) : null;
}

/** The connectors an app runs for this tab whose definition is not on this
 * browser: what the app offers is all there is to show. */
export function RelayedList({ host, known }: { host: FeatureHost; known: string[] }) {
  const listed = relayedConnectors(host.sync, host.device.id).filter(
    (offer) => !known.includes(offer.connectorId),
  );
  if (listed.length === 0) return null;
  return (
    <>
      <h3>{t("Through your apps", "Par vos apps")}</h3>
      <ul className="cn-list">
        {listed.map((offer) => (
          <li key={offer.id} className="cn-item" data-available>
            <div className="wc-row">
              <strong>{offer.connectorName || offer.connectorId}</strong>
              <span className="quiet">
                {t(`${offer.tools.length} tools`, `${offer.tools.length} outils`)}
              </span>
            </div>
            <p className="quiet">{relayText(offer, "")}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
