/**
 * The brief's agenda line on the web, and the card another device wrote
 * when this browser wrote none today (ADR-0107).
 */
import { t } from "../../lib/i18n";
import { deviceLabel } from "../connectors/relay";
import type { FeatureHost } from "../feature";
import { deviceCards, relayedCalendars } from "./agenda";
import { BriefCard } from "./Panel";
import { type DailyCard, dayOf } from "./brief";

/** The meetings line, or which device would add it. */
export function BriefAgenda({
  host,
  card,
  from,
}: {
  host: FeatureHost;
  card: DailyCard;
  from?: string;
}) {
  const agenda = card.agenda;
  if (agenda) {
    const source = card.agendaFrom ?? from;
    const line =
      agenda.count === 1
        ? t(
            `1 meeting: ${agenda.firstTitle} at ${agenda.firstAt}`,
            `1 réunion : ${agenda.firstTitle} à ${agenda.firstAt}`,
          )
        : t(
            `${agenda.count} meetings, next: ${agenda.firstTitle} at ${agenda.firstAt}`,
            `${agenda.count} réunions, la prochaine : ${agenda.firstTitle} à ${agenda.firstAt}`,
          );
    return (
      <>
        <h4>{t("Today", "Aujourd’hui")}</h4>
        <p>{line}</p>
        {source && source !== "browser" && (
          <p className="quiet">
            {t(
              `From the calendar on your ${deviceLabel(source)}.`,
              `D’après l’agenda de votre ${deviceLabel(source)}.`,
            )}
          </p>
        )}
      </>
    );
  }
  return <p className="quiet">{agendaHint(host)}</p>;
}

/** Why the card has no meetings line, and which device would add one. */
export function agendaHint(host: FeatureHost): string {
  if (relayedCalendars(host).length > 0)
    return t(
      "Your calendar did not answer in time: the app that reads it needs to be open.",
      "Votre agenda n’a pas répondu à temps : l’app qui le lit doit être ouverte.",
    );
  const devices = new Set(
    host.sync
      .rows("daily_brief_cards")
      .map((object) => String(object.row.device_name ?? ""))
      .filter((name) => name === "computer" || name === "phone"),
  );
  if (devices.size > 0) {
    const device = deviceLabel([...devices][0]);
    return t(
      `Your ${device} adds today's meetings once it writes its own brief this morning.`,
      `Votre ${device} ajoute les réunions du jour une fois son propre point du jour écrit ce matin.`,
    );
  }
  return t(
    "Your meetings are read by the app on your phone or computer. Turn on its daily brief there, or connect Google or Microsoft there and turn on “Run connectors for my browser”.",
    "Vos réunions sont lues par l’app sur votre téléphone ou votre ordinateur. Activez-y le point du jour, ou connectez-y Google ou Microsoft et activez « Exécuter les connecteurs pour mon navigateur ».",
  );
}

/** Today's card from another device, when this browser wrote none. */
export function SharedBrief({ host }: { host: FeatureHost }) {
  const shared = deviceCards<DailyCard>(host, dayOf(new Date()))[0];
  if (!shared) return null;
  return (
    <>
      <p className="quiet">
        {t(
          `Written on your ${deviceLabel(shared.deviceName)} today.`,
          `Écrit sur votre ${deviceLabel(shared.deviceName)} aujourd’hui.`,
        )}
      </p>
      <BriefCard
        host={host}
        stored={{ card: shared.card, status: shared.status === "silent" ? "silent" : "quiet" }}
        from={shared.deviceName}
      />
    </>
  );
}
