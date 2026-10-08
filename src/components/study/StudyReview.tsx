import "../../styles/study-research.css";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useCallback, useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { intlLocale, t } from "../../lib/i18n";
import {
  deleteStudyCard,
  dueStudyCards,
  reviewStudyCard,
  type StudyCard,
  type StudyGrade,
  type StudyStats,
  studyStats,
} from "../../lib/study";
import { Dialog } from "../ui/Dialog";

const GRADES: { grade: StudyGrade; label: () => string; hint: () => string }[] = [
  { grade: "again", label: () => t("Again"), hint: () => t("In 10 minutes") },
  { grade: "hard", label: () => t("Hard"), hint: () => t("A little later") },
  { grade: "good", label: () => t("Good"), hint: () => t("On schedule") },
  { grade: "easy", label: () => t("Easy"), hint: () => t("Much later") },
];

/**
 * The review (ADR-0089): the cards that are due, one at a time. The person
 * recalls the answer, turns the card, and says how it went; spaced
 * repetition (SM-2, `study/schedule.rs`) decides when it comes back. A card
 * answered "Again" returns at the end of this sitting. Both shells open it
 * as a dialog from the composer.
 */
export function StudyReview({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [queue, setQueue] = useState<StudyCard[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [stats, setStats] = useState<StudyStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [due, current] = await Promise.all([dueStudyCards(), studyStats()]);
      setQueue(due);
      setStats(current);
    } catch (err) {
      setQueue([]);
      setError(messageFromError(err));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setReviewed(0);
    setRevealed(false);
    void load();
  }, [open, load]);

  const card = queue?.[0];

  const grade = async (value: StudyGrade) => {
    if (!card || busy) return;
    setBusy(true);
    try {
      const updated = await reviewStudyCard(card.id, value);
      setReviewed((count) => count + 1);
      setRevealed(false);
      setQueue((current) => {
        const rest = (current ?? []).slice(1);
        return value === "again" ? [...rest, updated] : rest;
      });
      if (value !== "again" && queue?.length === 1) setStats(await studyStats());
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!card || busy) return;
    setBusy(true);
    try {
      await deleteStudyCard(card.id);
      setRevealed(false);
      setQueue((current) => (current ?? []).slice(1));
      setStats(await studyStats());
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("Review")}
      className="study-dialog"
      description={
        queue && queue.length > 0
          ? queue.length === 1
            ? t("1 card to review")
            : t("{count} cards to review", { count: queue.length })
          : undefined
      }
    >
      {error ? (
        <p className="study-error" role="alert">
          {error}
        </p>
      ) : null}
      {queue === null ? (
        <p className="study-muted">{t("Loading your cards…")}</p>
      ) : card ? (
        <div className="study-review">
          {card.deck ? <p className="study-review-deck">{card.deck}</p> : null}
          <div className="study-review-card" aria-live="polite">
            <p className="study-review-front">{card.front}</p>
            {revealed ? <p className="study-review-back">{card.back}</p> : null}
          </div>
          {revealed ? (
            <fieldset className="study-review-grades" aria-label={t("How well did you remember?")}>
              {GRADES.map(({ grade: value, label, hint }) => (
                <button
                  key={value}
                  type="button"
                  className="study-grade"
                  data-grade={value}
                  disabled={busy}
                  onClick={() => void grade(value)}
                >
                  <span>{label()}</span>
                  <span className="study-grade-hint">{hint()}</span>
                </button>
              ))}
            </fieldset>
          ) : (
            <div className="study-review-actions">
              <button
                type="button"
                className="study-button study-button-primary"
                onClick={() => setRevealed(true)}
              >
                {t("Show the answer")}
              </button>
              <button
                type="button"
                className="study-icon-button"
                aria-label={t("Remove this card from your review")}
                title={t("Remove this card from your review")}
                disabled={busy}
                onClick={() => void remove()}
              >
                <IconTrashCan size={16} />
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="study-review-done">
          <p>
            {reviewed > 0
              ? t("You are done for now.")
              : stats && stats.total > 0
                ? t("No cards are due.")
                : t("Add flashcards from a study chat to review them here.")}
          </p>
          {stats?.nextDueAt ? (
            <p className="study-muted">
              {t("The next card comes back {date}.", {
                date: new Date(stats.nextDueAt).toLocaleString(intlLocale(), {
                  weekday: "long",
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              })}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
