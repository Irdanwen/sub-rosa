import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconPlusSmall } from "central-icons/IconPlusSmall";
import { useEffect, useId, useState } from "react";
import { formatMinute, minuteFromTime, runErrorLabel, timeFromMinute } from "../../lib/assignments";
import { requestOpenNoteFromChat } from "../../lib/chat-blocks-nav";
import {
  type DailyCard,
  type FollowedTopic,
  type Today,
  agendaSentence,
  cardHasContent,
  dailyBriefPrepare,
  dailyBriefSetSettings,
  followAdd,
  followList,
  followRemove,
} from "../../lib/daily-brief";
import { messageFromError } from "../../lib/errors";
import { openExternalUrl } from "../../lib/tauri";
import { t } from "../../lib/i18n";
import { Switch } from "../ui/Switch";

/**
 * The daily brief: today's card, the switch that turns it on and the time it
 * comes, and the topics it follows. Off until asked for, and a morning with
 * nothing to say shows that rather than an empty card (ADR-0091).
 */
export function DailyBrief({
  today,
  onToday,
  onOpenAssignment,
}: {
  today: Today | null;
  onToday: (today: Today) => void;
  onOpenAssignment: (assignmentId: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timeId = useId();
  const settings = today?.settings ?? { enabled: false, atMinute: 450 };

  async function saveSettings(next: typeof settings) {
    try {
      const saved = await dailyBriefSetSettings(next);
      if (today) onToday({ ...today, settings: saved });
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function prepare() {
    setBusy(true);
    try {
      onToday(await dailyBriefPrepare());
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="assignment-section" aria-label={t("Daily brief")}>
      <div className="assignment-section-head">
        <h2 className="assignment-section-title">{t("Daily brief")}</h2>
        <Switch
          checked={settings.enabled}
          aria-label={t("Daily brief")}
          onCheckedChange={(enabled) => void saveSettings({ ...settings, enabled })}
        />
      </div>
      {!settings.enabled ? (
        <p className="assignment-meta">
          {t(
            "One card each morning: your agenda, yesterday's notes and their follow-ups, results to review, runs that failed, and news on the topics you follow. Nothing on a morning with nothing to say.",
          )}
        </p>
      ) : (
        <>
          <div className="assignment-row">
            <label className="assignment-field-label" htmlFor={timeId}>
              {t("Arrives at")}
            </label>
            <input
              id={timeId}
              type="time"
              className="assignment-input"
              value={timeFromMinute(settings.atMinute)}
              onChange={(event) => {
                const minute = minuteFromTime(event.target.value);
                if (minute !== null) void saveSettings({ ...settings, atMinute: minute });
              }}
            />
          </div>
          {today?.card && cardHasContent(today.card) ? (
            <BriefCard card={today.card} onOpenAssignment={onOpenAssignment} />
          ) : today?.status === "silent" ? (
            <p className="assignment-meta">{t("Nothing to tell you this morning.")}</p>
          ) : (
            <div className="assignment-row">
              <p className="assignment-meta">
                {t("Your brief arrives at {time}.", { time: formatMinute(settings.atMinute) })}
              </p>
              <button
                type="button"
                className="assignment-button"
                disabled={busy}
                onClick={() => void prepare()}
              >
                {t("Prepare it now")}
              </button>
            </div>
          )}
          <FollowList />
        </>
      )}
      {error ? (
        <p className="assignment-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function BriefCard({
  card,
  onOpenAssignment,
}: {
  card: DailyCard;
  onOpenAssignment: (assignmentId: string) => void;
}) {
  return (
    <article className="daily-card">
      {card.agenda ? <p className="daily-card-agenda">{agendaSentence(card.agenda)}</p> : null}
      {card.notes.length ? (
        <div className="daily-card-part">
          <h3 className="daily-card-heading">{t("Yesterday's notes")}</h3>
          <ul className="daily-card-list">
            {card.notes.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  className="assignment-link-button"
                  onClick={() => requestOpenNoteFromChat(note.id)}
                >
                  {note.title.trim() || t("Untitled note")}
                </button>
                {note.followUps.length ? (
                  <ul className="daily-card-followups">
                    {note.followUps.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {card.reviews.length ? (
        <div className="daily-card-part">
          <h3 className="daily-card-heading">{t("Results to review")}</h3>
          <ul className="daily-card-list">
            {card.reviews.map((item) => (
              <li key={item.runId ?? item.title}>
                <ItemButton item={item} onOpenAssignment={onOpenAssignment} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {card.failures.length ? (
        <div className="daily-card-part">
          <h3 className="daily-card-heading">{t("Runs that failed")}</h3>
          <ul className="daily-card-list">
            {card.failures.map((item) => (
              <li key={item.runId ?? item.title}>
                <ItemButton item={item} onOpenAssignment={onOpenAssignment} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {card.topics.some((topic) => topic.links.length) ? (
        <div className="daily-card-part">
          <h3 className="daily-card-heading">{t("Topics you follow")}</h3>
          <ul className="daily-card-list">
            {card.topics
              .filter((topic) => topic.links.length)
              .map((topic) => (
                <li key={topic.topic}>
                  <span className="daily-card-topic">{topic.topic}</span>
                  <ul className="daily-card-followups">
                    {topic.links.map((link) => (
                      <li key={link.url}>
                        <button
                          type="button"
                          className="assignment-link-button"
                          onClick={() => void openExternalUrl(link.url)}
                        >
                          {link.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

function ItemButton({
  item,
  onOpenAssignment,
}: {
  item: DailyCard["reviews"][number];
  onOpenAssignment: (assignmentId: string) => void;
}) {
  // A failed run's detail is the reason Rust stored, in English: translated
  // like everywhere else it is shown. A result summary passes as it is.
  const detail = item.assignmentId ? runErrorLabel(item.detail) : item.detail;
  const label = detail ? `${item.title}: ${detail}` : item.title;
  if (!item.assignmentId) return <span>{label}</span>;
  const assignmentId = item.assignmentId;
  return (
    <button
      type="button"
      className="assignment-link-button"
      onClick={() => onOpenAssignment(assignmentId)}
    >
      {label}
    </button>
  );
}

/** The topics the brief follows: five at most, one web search each a day. */
function FollowList() {
  const [topics, setTopics] = useState<FollowedTopic[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  useEffect(() => {
    void followList()
      .then(setTopics)
      .catch(() => setTopics([]));
  }, []);

  async function run(work: () => Promise<FollowedTopic[]>) {
    try {
      setTopics(await work());
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  return (
    <div className="daily-follow">
      <label className="assignment-field-label" htmlFor={inputId}>
        {t("Topics you follow")}
      </label>
      <ul className="daily-follow-list">
        {topics.map((topic) => (
          <li key={topic.id} className="daily-follow-chip">
            <span>{topic.topic}</span>
            <button
              type="button"
              className="assignment-icon-button"
              aria-label={t("Stop following {topic}", { topic: topic.topic })}
              onClick={() => void run(() => followRemove(topic.id))}
            >
              <IconCrossSmall size={14} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="assignment-row"
        onSubmit={(event) => {
          event.preventDefault();
          const topic = draft.trim();
          if (!topic) return;
          setDraft("");
          void run(() => followAdd(topic));
        }}
      >
        <input
          id={inputId}
          className="assignment-input"
          value={draft}
          maxLength={80}
          placeholder={t("A topic, a company, a person")}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="assignment-button" aria-label={t("Follow topic")}>
          <IconPlusSmall size={16} aria-hidden />
          {t("Follow topic")}
        </button>
      </form>
      <p className="assignment-meta">{t("Each topic is one web search a day.")}</p>
      {error ? (
        <p className="assignment-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
