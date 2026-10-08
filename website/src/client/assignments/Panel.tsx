import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, type Device } from "../../lib/api";
import { date, t } from "../../lib/i18n";
import type { FeatureHost } from "../feature";
import { BriefAgenda, SharedBrief } from "./BriefAgenda";
import {
  type BriefSettings,
  DEFAULT_BRIEF,
  loadBrief,
  prepareBrief,
  saveBrief,
  type StoredCard,
  todaysCard,
} from "./brief";
import { resultSummary } from "./prompt";
import {
  type Assignment,
  AssignmentError,
  type AssignmentInput,
  deleteAssignment,
  listAssignments,
  listRuns,
  needsReview,
  type Run,
  review,
  saveAssignment,
  scheduleOf,
  setPaused,
} from "./rows";
import {
  type AssignmentSettings,
  BROWSER_DEVICE_NAME,
  DEFAULT_SETTINGS,
  foreign,
  loadSettings,
  runNow,
  runsHere,
  saveSettings,
} from "./runner";
import { browserZone, type Cadence, nextAfter } from "./schedule";
import { ASSIGNMENTS } from "./words";
import "./assignments.css";

const GROUP_LABELS: Record<string, () => string> = {
  web: () => t("Search the web", "Chercher sur le web"),
  notes: () => t("Your notes", "Vos notes"),
  memory: () => t("Your memories", "Vos souvenirs"),
  personal: () => t("Health and finances", "Santé et finances"),
  connectors: () => t("Connected apps", "Apps connectées"),
  files: () => t("Files and code, on a computer", "Fichiers et code, sur un ordinateur"),
  terminal: () => t("The terminal, on a computer", "Le terminal, sur un ordinateur"),
  browser: () => t("The browser, on a computer", "Le navigateur, sur un ordinateur"),
};

const CADENCE_LABELS: Record<Cadence, () => string> = {
  hourly: () => t("Every hour", "Toutes les heures"),
  daily: () => t("Every day", "Tous les jours"),
  weekdays: () => t("On weekdays", "En semaine"),
  weekly: () => t("Every week", "Toutes les semaines"),
  every: () => t("Every few hours", "Toutes les quelques heures"),
};

const WEEKDAYS: (() => string)[] = [
  () => t("Sunday", "Dimanche"),
  () => t("Monday", "Lundi"),
  () => t("Tuesday", "Mardi"),
  () => t("Wednesday", "Mercredi"),
  () => t("Thursday", "Jeudi"),
  () => t("Friday", "Vendredi"),
  () => t("Saturday", "Samedi"),
];

function clock(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function minuteOf(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

/** Where a run happened, as the app says it. */
function ranOn(run: Run) {
  if (run.deviceName === BROWSER_DEVICE_NAME) return t("In a browser", "Dans un navigateur");
  return run.deviceName === "phone"
    ? t("On your phone", "Sur votre téléphone")
    : t("On your computer", "Sur votre ordinateur");
}

function stateLabel(run: Run) {
  switch (run.state) {
    case "running":
      return t("Running", "En cours");
    case "needs_review":
      return t("To review", "À examiner");
    case "approved":
      return t("Approved", "Approuvé");
    case "rejected":
      return t("Rejected", "Refusé");
    case "failed":
      return t("Did not finish", "N’a pas abouti");
    default:
      return t("Done", "Terminé");
  }
}

interface Draft {
  id?: string;
  kind: "assignment" | "task";
  title: string;
  goal: string;
  cadence: Cadence;
  at: string;
  weekday: number;
  everyHours: number;
  autonomy: "ask" | "act";
  tools: string[];
  /** Empty: this browser. */
  deviceId: string;
}

const EMPTY: Draft = {
  kind: "assignment",
  title: "",
  goal: "",
  cadence: "daily",
  at: "09:00",
  weekday: 1,
  everyHours: 4,
  autonomy: "ask",
  tools: ["web", "notes"],
  deviceId: "",
};

function draftOf(row: Assignment, me: string): Draft {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    goal: row.goal,
    cadence: (scheduleOf(row)?.cadence ?? "daily") as Cadence,
    at: clock(row.atMinute),
    weekday: row.weekday,
    everyHours: row.everyHours,
    autonomy: row.autonomy,
    tools: row.tools,
    deviceId: row.deviceId === me ? "" : row.deviceId,
  };
}

/**
 * Assignments, scheduled tasks, their results and the daily brief, in the
 * browser. Every definition and run is a synchronised row; what runs here
 * runs only while this tab is open.
 */
export function AssignmentsPanel({ host }: { host: FeatureHost }) {
  const me = host.device.id ?? "";
  const [settings, setSettings] = useState<AssignmentSettings>(DEFAULT_SETTINGS);
  const [devices, setDevices] = useState<Device[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [brief, setBrief] = useState<BriefSettings>(DEFAULT_BRIEF);
  const [card, setCard] = useState<StoredCard | null>(null);
  const [topic, setTopic] = useState("");
  const [historyOf, setHistoryOf] = useState<string | null>(null);

  // The host is rebuilt on every render of the page; what is read once on
  // opening reads the latest through this ref.
  const hostRef = useRef(host);
  hostRef.current = host;
  const reloadBrief = useCallback(async () => {
    setBrief(await loadBrief(hostRef.current));
    setCard((await todaysCard(hostRef.current)) ?? null);
  }, []);

  useEffect(() => {
    let active = true;
    void loadSettings(hostRef.current).then((value) => active && setSettings(value));
    void reloadBrief();
    api<Device[]>("/api/v1/devices")
      .then((list) => active && setDevices(list.filter((device) => !device.revoked_at)))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [reloadBrief]);

  const rows = listAssignments(host.sync);
  const inbox = needsReview(host.sync);
  const titles = new Map(rows.map((row) => [row.id, row.title]));
  const others = devices.filter((device) => device.id !== me);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setError("");
    const device = others.find((item) => item.id === draft.deviceId);
    const input: AssignmentInput = {
      id: draft.id,
      kind: draft.kind,
      title: draft.title,
      goal: draft.goal,
      cadence: draft.cadence,
      atMinute: minuteOf(draft.at),
      weekday: draft.weekday,
      everyHours: draft.everyHours,
      autonomy: draft.autonomy,
      tools: draft.tools,
      deviceId: device?.id,
      deviceName: device?.name,
    };
    try {
      await saveAssignment(host.sync, input, { id: me, name: host.device.name });
      setDraft(null);
      host.refresh();
    } catch (failure) {
      setError(
        failure instanceof AssignmentError && failure.code === "goal_missing"
          ? t("Say what it should work on.", "Dites sur quoi elle doit travailler.")
          : failure instanceof AssignmentError && failure.code === "cadence_invalid"
            ? t("Choose how often it runs.", "Choisissez à quelle fréquence elle tourne.")
            : t("This could not be saved.", "Cela n’a pas pu être enregistré."),
      );
    }
  };

  const where = (row: Assignment) =>
    runsHere(row, me)
      ? t("In this browser", "Dans ce navigateur")
      : row.deviceName || t("On your other device", "Sur votre autre appareil");

  const describe = (row: Assignment) => {
    const schedule = scheduleOf(row);
    if (!schedule) return "";
    const at = clock(row.atMinute);
    switch (schedule.cadence) {
      case "hourly":
        return t(
          `Every hour at minute ${row.atMinute % 60}`,
          `Toutes les heures à la minute ${row.atMinute % 60}`,
        );
      case "weekly":
        return t(
          `Every ${WEEKDAYS[schedule.weekday]()} at ${at}`,
          `Chaque ${WEEKDAYS[schedule.weekday]().toLowerCase()} à ${at}`,
        );
      case "every":
        return t(
          `Every ${schedule.everyHours} hours from ${at}`,
          `Toutes les ${schedule.everyHours} heures dès ${at}`,
        );
      default:
        return `${CADENCE_LABELS[schedule.cadence]()}, ${at}`;
    }
  };

  const next = (row: Assignment) => {
    const schedule = scheduleOf(row);
    if (row.paused || !schedule || !runsHere(row, me)) return null;
    const at = nextAfter(schedule, Date.now(), browserZone);
    return at === null ? null : date(new Date(at).toISOString());
  };

  const verdict = async (run: Run, approve: boolean) => {
    await review(host.sync, run.id, approve, feedback[run.id] ?? null);
    setFeedback((value) => ({ ...value, [run.id]: "" }));
    host.refresh();
  };

  const updateBrief = async (value: BriefSettings) => {
    setBrief(await saveBrief(host, value));
  };

  return (
    <div className="as-panel">
      <h1>{t("Assignments", "Missions")}</h1>
      <p className="quiet">
        {t(
          "An assignment is a goal Sub Rosa works on again and again; a scheduled task runs and lets you know. They run only where an app is open: in this browser while this tab is open, never on a server. A closed tab runs nothing, and a missed slot runs once, late, when the tab opens again.",
          "Une mission est un objectif sur lequel Sub Rosa revient régulièrement ; une tâche planifiée s’exécute et vous prévient. Elles ne tournent que là où une app est ouverte : dans ce navigateur tant que cet onglet est ouvert, jamais sur un serveur. Un onglet fermé n’exécute rien, et un créneau manqué s’exécute une fois, en retard, à la réouverture.",
        )}
      </p>
      {!me && (
        <p className="notice">
          {t(
            "This browser is not a device of your account yet, so nothing runs here.",
            "Ce navigateur n’est pas encore un appareil de votre compte : rien ne tourne ici.",
          )}
        </p>
      )}

      <section aria-labelledby="as-inbox">
        <h2 id="as-inbox">{t("Results to review", "Résultats à examiner")}</h2>
        {inbox.length === 0 ? (
          <p className="quiet">{t("Nothing waits for you.", "Rien ne vous attend.")}</p>
        ) : (
          <ul className="as-list">
            {inbox.map((run) => (
              <li key={run.id} className="as-item">
                <strong>{titles.get(run.assignmentId) ?? ""}</strong>
                <span className="quiet">
                  {" "}
                  · {ranOn(run)}
                  {run.finishedAt ? ` · ${date(run.finishedAt)}` : ""}
                </span>
                <p>{resultSummary(run.result ?? "")}</p>
                {run.result && (
                  <details>
                    <summary>{t("Read the whole result", "Lire tout le résultat")}</summary>
                    <p className="as-result">{run.result}</p>
                  </details>
                )}
                {run.handle && (
                  <button
                    className="button"
                    type="button"
                    onClick={() => host.openChat(run.handle as string)}
                  >
                    {t("Open the run's chat", "Ouvrir la discussion de l’exécution")}
                  </button>
                )}
                <label className="as-field">
                  <span>
                    {t(
                      "Your feedback for the next runs",
                      "Votre retour pour les prochaines exécutions",
                    )}
                  </span>
                  <textarea
                    rows={2}
                    value={feedback[run.id] ?? ""}
                    onChange={(event) =>
                      setFeedback((value) => ({ ...value, [run.id]: event.target.value }))
                    }
                  />
                </label>
                <div className="wc-row">
                  <button
                    className="button primary"
                    type="button"
                    onClick={() => void verdict(run, true)}
                  >
                    {t("Approve", "Approuver")}
                  </button>
                  <button className="button" type="button" onClick={() => void verdict(run, false)}>
                    {t("Reject", "Refuser")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="as-list">
        <div className="wc-row">
          <h2 id="as-list">{t("Your assignments and tasks", "Vos missions et tâches")}</h2>
          <button className="button" type="button" onClick={() => setDraft({ ...EMPTY })}>
            {t("New assignment", "Nouvelle mission")}
          </button>
        </div>
        {rows.length === 0 && (
          <p className="quiet">{t("No assignment yet.", "Aucune mission pour l’instant.")}</p>
        )}
        <ul className="as-list">
          {rows.map((row) => {
            const here = runsHere(row, me);
            const waiting = here && foreign(row, me) && !settings.acceptOthers;
            const upcoming = next(row);
            const runs = listRuns(host.sync, row.id);
            return (
              <li key={row.id} className="as-item">
                <strong>{row.title}</strong>
                <span className="quiet">
                  {" "}
                  ·{" "}
                  {row.kind === "task"
                    ? t("Scheduled task", "Tâche planifiée")
                    : t("Assignment", "Mission")}{" "}
                  · {describe(row)} · {where(row)}
                  {row.paused ? ` · ${t("Paused", "En pause")}` : ""}
                </span>
                {upcoming && (
                  <p className="quiet">
                    {t(`Next run: ${upcoming}`, `Prochaine exécution : ${upcoming}`)}
                  </p>
                )}
                {waiting && (
                  <p className="notice">
                    {t(
                      "Another device sent this to this browser. It waits until you let this browser run assignments sent from your other devices.",
                      "Un autre appareil a envoyé ceci à ce navigateur. Elle attend que vous autorisiez ce navigateur à exécuter les missions envoyées par vos autres appareils.",
                    )}
                  </p>
                )}
                <div className="wc-row">
                  {here && !row.paused && !waiting && (
                    <button
                      className="button"
                      type="button"
                      onClick={() => void runNow(host, row.id).then(() => host.refresh())}
                    >
                      {t("Run now", "Exécuter maintenant")}
                    </button>
                  )}
                  <button
                    className="button"
                    type="button"
                    onClick={() =>
                      void setPaused(host.sync, row.id, !row.paused).then(host.refresh)
                    }
                  >
                    {row.paused ? t("Resume", "Reprendre") : t("Pause", "Mettre en pause")}
                  </button>
                  <button
                    className="button"
                    type="button"
                    onClick={() => setDraft(draftOf(row, me))}
                  >
                    {t("Edit", "Modifier")}
                  </button>
                  <button
                    className="button"
                    type="button"
                    aria-expanded={historyOf === row.id}
                    onClick={() => setHistoryOf(historyOf === row.id ? null : row.id)}
                  >
                    {t("History", "Historique")}
                  </button>
                  <button
                    className="button"
                    type="button"
                    onClick={() => {
                      if (
                        window.confirm(
                          t(
                            "Delete this assignment and its results on every device?",
                            "Supprimer cette mission et ses résultats sur tous les appareils ?",
                          ),
                        )
                      )
                        void deleteAssignment(host.sync, row.id).then(host.refresh);
                    }}
                  >
                    {t("Delete", "Supprimer")}
                  </button>
                </div>
                {!here && (
                  <p className="quiet">
                    {t(
                      "Run now works on the device that runs it.",
                      "Exécuter maintenant fonctionne sur l’appareil qui l’exécute.",
                    )}
                  </p>
                )}
                {historyOf === row.id && (
                  <ul className="as-history">
                    {runs.length === 0 && (
                      <li className="quiet">
                        {t("No run yet.", "Aucune exécution pour l’instant.")}
                      </li>
                    )}
                    {runs.slice(0, 20).map((run) => (
                      <li key={run.id}>
                        {date(run.startedAt)} · {stateLabel(run)} · {ranOn(run)}
                        {run.late ? ` · ${t("Late", "En retard")}` : ""}
                        {run.state === "failed" && run.error ? ` · ${run.error}` : ""}
                        {run.result ? ` · ${resultSummary(run.result)}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {draft && (
        <form className="form as-form" onSubmit={(event) => void save(event)}>
          <h2>
            {draft.id
              ? t("Edit the assignment", "Modifier la mission")
              : t("New assignment", "Nouvelle mission")}
          </h2>
          <label>
            <span>{t("Kind", "Type")}</span>
            <select
              value={draft.kind}
              onChange={(event) =>
                setDraft({ ...draft, kind: event.target.value as Draft["kind"] })
              }
            >
              <option value="assignment">
                {t("Assignment, results to review", "Mission, résultats à examiner")}
              </option>
              <option value="task">
                {t("Scheduled task, no review", "Tâche planifiée, sans examen")}
              </option>
            </select>
          </label>
          <label>
            <span>{t("Title", "Titre")}</span>
            <input
              value={draft.title}
              maxLength={ASSIGNMENTS.limits.titleChars}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </label>
          <label className="as-field">
            <span>{t("What should it work on?", "Sur quoi doit-elle travailler ?")}</span>
            <textarea
              rows={4}
              value={draft.goal}
              maxLength={ASSIGNMENTS.limits.goalChars}
              onChange={(event) => setDraft({ ...draft, goal: event.target.value })}
            />
          </label>
          <label>
            <span>{t("How often", "Fréquence")}</span>
            <select
              value={draft.cadence}
              onChange={(event) => setDraft({ ...draft, cadence: event.target.value as Cadence })}
            >
              {(Object.keys(CADENCE_LABELS) as Cadence[]).map((cadence) => (
                <option key={cadence} value={cadence}>
                  {CADENCE_LABELS[cadence]()}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>
              {draft.cadence === "every"
                ? t("First run of the day", "Première exécution du jour")
                : t("At", "À")}
            </span>
            <input
              type="time"
              value={draft.at}
              onChange={(event) => setDraft({ ...draft, at: event.target.value })}
            />
          </label>
          {draft.cadence === "weekly" && (
            <label>
              <span>{t("Day", "Jour")}</span>
              <select
                value={draft.weekday}
                onChange={(event) => setDraft({ ...draft, weekday: Number(event.target.value) })}
              >
                {WEEKDAYS.map((label, index) => (
                  <option key={label()} value={index}>
                    {label()}
                  </option>
                ))}
              </select>
            </label>
          )}
          {draft.cadence === "every" && (
            <label>
              <span>{t("Hours between runs", "Heures entre deux exécutions")}</span>
              <input
                type="number"
                min={1}
                max={24}
                value={draft.everyHours}
                onChange={(event) =>
                  setDraft({ ...draft, everyHours: Number(event.target.value) || 1 })
                }
              />
            </label>
          )}
          <label>
            <span>{t("Autonomy", "Autonomie")}</span>
            <select
              value={draft.autonomy}
              onChange={(event) =>
                setDraft({ ...draft, autonomy: event.target.value as Draft["autonomy"] })
              }
            >
              <option value="ask">
                {t(
                  "Ask before anything leaves the device",
                  "Demander avant que quoi que ce soit ne quitte l’appareil",
                )}
              </option>
              <option value="act">{t("Act within these tools", "Agir avec ces outils")}</option>
            </select>
          </label>
          <fieldset className="as-tools">
            <legend>{t("What it may use", "Ce qu’elle peut utiliser")}</legend>
            {ASSIGNMENTS.toolGroups.map((group) => (
              <label key={group.id} className="check">
                <input
                  type="checkbox"
                  checked={draft.tools.includes(group.id)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      tools: event.target.checked
                        ? [...draft.tools, group.id]
                        : draft.tools.filter((tool) => tool !== group.id),
                    })
                  }
                />
                {GROUP_LABELS[group.id]?.() ?? group.id}
              </label>
            ))}
            <small>
              {t(
                "Under Ask first, what would leave the device or change a computer is never used, whatever is ticked. A browser runs the web, your notes, your memories and your connected apps.",
                "Avec Demander d’abord, ce qui quitterait l’appareil ou changerait un ordinateur n’est jamais utilisé, quoi qu’on coche. Un navigateur utilise le web, vos notes, vos souvenirs et vos apps connectées.",
              )}
            </small>
          </fieldset>
          <label>
            <span>{t("Runs on", "S’exécute sur")}</span>
            <select
              value={draft.deviceId}
              onChange={(event) => setDraft({ ...draft, deviceId: event.target.value })}
            >
              <option value="">{t("This browser", "Ce navigateur")}</option>
              {others.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="wc-row">
            <button className="button primary" type="submit">
              {t("Save", "Enregistrer")}
            </button>
            <button className="button" type="button" onClick={() => setDraft(null)}>
              {t("Cancel", "Annuler")}
            </button>
          </div>
        </form>
      )}

      <section aria-labelledby="as-settings" className="form">
        <h2 id="as-settings">{t("This browser", "Ce navigateur")}</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.acceptOthers}
            onChange={(event) => {
              const next = { ...settings, acceptOthers: event.target.checked };
              setSettings(next);
              void saveSettings(host, next);
            }}
          />
          {t(
            "Run assignments sent from your other devices",
            "Exécuter les missions envoyées par vos autres appareils",
          )}
        </label>
      </section>

      <section aria-labelledby="as-brief" className="form">
        <h2 id="as-brief">{t("Daily brief", "Point du jour")}</h2>
        <p className="quiet">
          {t(
            "One card a day at the time you choose, while this tab is open: today's meetings, yesterday's notes and their follow-ups, results to review, runs that failed, and what is new on the topics you follow. Nothing when there is nothing to say. The meetings come from Google or Microsoft connected in an app that runs connectors for your browser, or from the brief your phone or computer wrote today.",
            "Une carte par jour à l’heure choisie, tant que cet onglet est ouvert : les réunions du jour, les notes d’hier et leurs suites, les résultats à examiner, les exécutions en échec, et le nouveau sur les sujets suivis. Rien quand il n’y a rien à dire. Les réunions viennent de Google ou Microsoft connecté dans une app qui exécute les connecteurs pour votre navigateur, ou du point du jour écrit aujourd’hui par votre téléphone ou votre ordinateur.",
          )}
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={brief.enabled}
            onChange={(event) => void updateBrief({ ...brief, enabled: event.target.checked })}
          />
          {t("Write a daily brief in this browser", "Écrire un point du jour dans ce navigateur")}
        </label>
        <label>
          <span>{t("At", "À")}</span>
          <input
            type="time"
            value={clock(brief.atMinute)}
            onChange={(event) =>
              void updateBrief({ ...brief, atMinute: minuteOf(event.target.value) })
            }
          />
        </label>
        <div>
          <span>{t("Topics you follow", "Sujets suivis")}</span>
          <ul className="as-history">
            {brief.topics.map((item) => (
              <li key={item}>
                {item}{" "}
                <button
                  className="button"
                  type="button"
                  onClick={() =>
                    void updateBrief({
                      ...brief,
                      topics: brief.topics.filter((other) => other !== item),
                    })
                  }
                >
                  {t("Stop following", "Ne plus suivre")}
                </button>
              </li>
            ))}
          </ul>
          {brief.topics.length < ASSIGNMENTS.dailyBrief.maxTopics && (
            <div className="wc-row">
              <label className="sr-only" htmlFor="as-topic">
                {t("A topic to follow", "Un sujet à suivre")}
              </label>
              <input
                id="as-topic"
                value={topic}
                maxLength={ASSIGNMENTS.dailyBrief.maxTopicChars}
                placeholder={t("A topic to follow", "Un sujet à suivre")}
                onChange={(event) => setTopic(event.target.value)}
              />
              <button
                className="button"
                type="button"
                disabled={!topic.trim()}
                onClick={() => {
                  void updateBrief({ ...brief, topics: [...brief.topics, topic] });
                  setTopic("");
                }}
              >
                {t("Follow", "Suivre")}
              </button>
            </div>
          )}
        </div>
        <div className="wc-row">
          <button
            className="button"
            type="button"
            onClick={() => void prepareBrief(host).then(() => reloadBrief())}
          >
            {t("Prepare today's brief now", "Préparer le point du jour maintenant")}
          </button>
        </div>
        {card ? <BriefCard host={host} stored={card} /> : <SharedBrief host={host} />}
      </section>
    </div>
  );
}

export function BriefCard({
  host,
  stored,
  from,
}: {
  host: FeatureHost;
  stored: StoredCard;
  /** The device that wrote it, when it is not this browser. */
  from?: string;
}) {
  const { card } = stored;
  if (stored.status === "silent")
    return <p className="quiet">{t("Nothing to report today.", "Rien à signaler aujourd’hui.")}</p>;
  return (
    <article className="as-card" aria-label={t("Your day", "Votre journée")}>
      <h3>{t("Your day", "Votre journée")}</h3>
      <BriefAgenda host={host} card={card} from={from} />
      {card.notes.length > 0 && (
        <>
          <h4>{t("Yesterday's notes", "Notes d’hier")}</h4>
          <ul>
            {card.notes.map((note) => (
              <li key={note.id}>
                {note.title}
                {note.followUps.length > 0 && (
                  <ul>
                    {note.followUps.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {card.reviews.length > 0 && (
        <>
          <h4>{t("Results to review", "Résultats à examiner")}</h4>
          <ul>
            {card.reviews.map((item) => (
              <li key={item.runId ?? item.title}>
                <strong>{item.title}</strong> {item.detail}
              </li>
            ))}
          </ul>
        </>
      )}
      {card.failures.length > 0 && (
        <>
          <h4>{t("Runs that failed", "Exécutions en échec")}</h4>
          <ul>
            {card.failures.map((item) => (
              <li key={item.runId ?? item.title}>
                <strong>{item.title}</strong> {item.detail}
              </li>
            ))}
          </ul>
        </>
      )}
      {card.topics.some((item) => item.links.length > 0) && (
        <>
          <h4>{t("New on your topics", "Du nouveau sur vos sujets")}</h4>
          <ul>
            {card.topics
              .filter((item) => item.links.length > 0)
              .map((item) => (
                <li key={item.topic}>
                  {item.topic}
                  <ul>
                    {item.links.map((link) => (
                      <li key={link.url}>
                        <a href={link.url} target="_blank" rel="noreferrer noopener">
                          {link.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
          </ul>
        </>
      )}
      <p className="quiet">{date(card.createdAt)}</p>
    </article>
  );
}
