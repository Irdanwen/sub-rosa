import { useCallback, useEffect, useMemo, useState } from "react";
import { date, t } from "../../lib/i18n";
import type { FeatureHost } from "../feature";
import {
  deleteCard,
  dueCards,
  reviewCard,
  type StudyCard,
  type StudyStats,
  studyStats,
} from "./cards";
import { type Grade, GRADES } from "./schedule";
import "./study.css";

function gradeLabel(grade: Grade): string {
  switch (grade) {
    case "again":
      return t("Again", "À revoir");
    case "hard":
      return t("Hard", "Difficile");
    case "good":
      return t("Good", "Bien");
    default:
      return t("Easy", "Facile");
  }
}

/** The review (ADR-0089): the cards due now, one at a time, with the four
 * answers SM-2 schedules them by. Kept in this browser. */
export function ReviewPanel({ host }: { host: FeatureHost }) {
  const store = useMemo(() => host.storeFor("study"), [host.storeFor]);
  const [due, setDue] = useState<StudyCard[]>([]);
  const [stats, setStats] = useState<StudyStats | null>(null);
  const [shown, setShown] = useState(false);
  const reload = useCallback(async () => {
    setDue(await dueCards(store));
    setStats(await studyStats(store));
    setShown(false);
  }, [store]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const card = due[0];
  return (
    <div className="study-review">
      <h1>{t("Review", "Révision")}</h1>
      <p className="quiet">
        {t(
          "Cards you added from flashcards come back by spaced repetition. They are kept in this browser only.",
          "Les fiches que vous avez ajoutées reviennent par répétition espacée. Elles restent dans ce navigateur uniquement.",
        )}
      </p>
      {stats && (
        <p role="status">
          {t(
            `${stats.due} due now, ${stats.total} in review.`,
            `${stats.due} à réviser maintenant, ${stats.total} en révision.`,
          )}
        </p>
      )}
      {card ? (
        <section className="chat-block study-card" aria-label={t("Card", "Fiche")}>
          {card.deck && <p className="quiet">{card.deck}</p>}
          <p>
            <strong>{card.front}</strong>
          </p>
          {shown ? (
            <>
              <p>{card.back}</p>
              <fieldset className="wc-row study-grades">
                <legend className="sr-only">
                  {t("How did it go?", "Comment ça s’est passé ?")}
                </legend>
                {GRADES.map((grade) => (
                  <button
                    key={grade}
                    type="button"
                    className="button"
                    onClick={() => void reviewCard(store, card.id, grade).then(reload)}
                  >
                    {gradeLabel(grade)}
                  </button>
                ))}
              </fieldset>
            </>
          ) : (
            <button type="button" className="button primary" onClick={() => setShown(true)}>
              {t("Show the answer", "Voir la réponse")}
            </button>
          )}
          <button
            type="button"
            className="button"
            onClick={() => void deleteCard(store, card.id).then(reload)}
          >
            {t("Remove this card", "Retirer cette fiche")}
          </button>
        </section>
      ) : (
        <p>
          {stats?.nextDueAt
            ? t(
                `Nothing due until ${date(stats.nextDueAt)}.`,
                `Rien à réviser avant le ${date(stats.nextDueAt)}.`,
              )
            : t(
                "Nothing to review. Add flashcards from a chat in study mode.",
                "Rien à réviser. Ajoutez des fiches depuis une discussion en mode étude.",
              )}
        </p>
      )}
    </div>
  );
}
