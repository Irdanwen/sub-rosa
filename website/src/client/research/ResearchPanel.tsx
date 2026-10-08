import { useCallback, useEffect, useMemo, useState } from "react";
import { date, t, websiteLocale } from "../../lib/i18n";
import { Markdown } from "../../lib/markdown";
import type { FeatureHost } from "../feature";
import { listNotes } from "../library";
import {
  ceiling,
  DEPTHS,
  type Depth,
  estimate,
  type ResearchCeiling,
  type ResearchPlan,
  RESEARCH,
  type ResearchPrices,
} from "./core";
import {
  approveRun,
  deleteRun,
  drive,
  isLive,
  planRun,
  resumeRun,
  type Run,
  type RunStore,
  startRun,
  stopRun,
} from "./engine";
import { liveBackend, researchPrices, runStore } from "./live";
import { type ResearchProvider, researchProviders } from "./providers";
import { changed, onChange, takeHandoff } from "./state";
import "./research.css";

export function depthLabel(depth: Depth): string {
  return depth === "quick"
    ? t("Quick", "Rapide")
    : depth === "standard"
      ? t("Standard", "Standard")
      : t("Deep", "Approfondie");
}

function usd(value: number): string {
  return new Intl.NumberFormat(websiteLocale(), { style: "currency", currency: "USD" }).format(
    // Never below a cent, so a part that costs something never reads as free.
    Math.max(value, 0.01),
  );
}

function statusLabel(run: Run): string {
  switch (run.status) {
    case "clarifying":
      return t("Waiting for your answers", "En attente de vos réponses");
    case "planned":
      return t("Plan ready", "Plan prêt");
    case "running":
      return run.phase === "reading"
        ? t("Reading sources", "Lecture des sources")
        : run.phase === "writing"
          ? t("Writing the report", "Rédaction du rapport")
          : t("Searching", "Recherche");
    case "done":
      return t("Report ready", "Rapport prêt");
    case "stopped":
      return t("Stopped", "Arrêtée");
    default:
      return t("Failed", "Échouée");
  }
}

/** The ceiling as the plan screen says it: each part, then the total, or why
 * there is none. */
export function CeilingLine({ value }: { value: ResearchCeiling }) {
  const part = (amount: number | undefined) =>
    amount === undefined ? t("price unknown", "prix inconnu") : usd(amount);
  return (
    <p className="quiet">
      {t(
        `At most: model ${part(value.modelUsd)}, searches ${part(value.searchesUsd)}, page reads ${part(value.readsUsd)}.`,
        `Au plus : modèle ${part(value.modelUsd)}, recherches ${part(value.searchesUsd)}, lectures de pages ${part(value.readsUsd)}.`,
      )}{" "}
      {value.totalUsd === undefined
        ? t(
            "No total: part of the price is not known.",
            "Pas de total : une partie du prix est inconnue.",
          )
        : t(`Total at most ${usd(value.totalUsd)}.`, `Total au plus ${usd(value.totalUsd)}.`)}
    </p>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : t("This could not be completed.", "Cela n’a pas abouti.");
}

/** Deep research (ADR-0089) in the browser: start, clarify, plan, follow,
 * stop, resume and read. */
export function ResearchPanel({ host }: { host: FeatureHost }) {
  const store: RunStore = useMemo(() => runStore(host.storeFor("research")), [host.storeFor]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [question, setQuestion] = useState(() => takeHandoff() ?? "");
  const [depth, setDepth] = useState<Depth>("standard");
  const [useNotes, setUseNotes] = useState(true);
  const [providers, setProviders] = useState<ResearchProvider[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const all = await store.list();
    setRuns(all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, [store]);
  useEffect(() => {
    void reload();
    return onChange(() => void reload());
  }, [reload]);
  useEffect(() => {
    void researchProviders(host).then(setProviders);
  }, [host]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
      changed();
    }
  };
  const backendFor = (run: Pick<Run, "model">) => liveBackend(host, run.model);
  const go = (run: Run) => {
    void drive(store, backendFor(run), run.id, changed);
  };

  const start = () =>
    act(async () => {
      const run = await startRun(store, backendFor({ model: host.model }), {
        question,
        depth,
        model: host.model,
        useNotes,
        providers: picked,
        chatId: host.openChatId,
      });
      setQuestion("");
      setOpenId(run.id);
    });

  const open = runs.find((run) => run.id === openId) ?? null;
  return (
    <div className="research">
      <h1>{t("Deep research", "Recherche approfondie")}</h1>
      <p className="quiet">
        {t(
          "A question read across many sources, written up as a note with numbered sources. It runs while this page is open and picks up where it stopped when you come back.",
          "Une question lue à travers de nombreuses sources, rédigée en note aux sources numérotées. Elle avance tant que cette page est ouverte et reprend là où elle s’était arrêtée à votre retour.",
        )}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {open ? (
        <RunView
          run={open}
          host={host}
          busy={busy}
          onBack={() => setOpenId(null)}
          onPlan={(answers) => act(() => planRun(store, backendFor(open), open.id, answers))}
          onApprove={(plan, chosen) =>
            act(async () => {
              const run = await approveRun(store, open.id, plan, chosen);
              go(run);
            })
          }
          onStop={() => act(() => stopRun(store, open.id))}
          onResume={(finishNow) =>
            act(async () => {
              const run = await resumeRun(store, open.id, finishNow);
              go(run);
            })
          }
          onDelete={() =>
            act(async () => {
              await deleteRun(store, open.id);
              setOpenId(null);
            })
          }
        />
      ) : (
        <>
          <form
            className="research-new"
            onSubmit={(event) => {
              event.preventDefault();
              if (question.trim() && !busy) void start();
            }}
          >
            <label htmlFor="research-question">
              {t("What should be researched?", "Que faut-il rechercher ?")}
            </label>
            <textarea
              id="research-question"
              rows={3}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
            <div className="wc-row">
              <label>
                {t("Depth", "Profondeur")}{" "}
                <select value={depth} onChange={(event) => setDepth(event.target.value as Depth)}>
                  {DEPTHS.map((item) => (
                    <option key={item} value={item}>
                      {depthLabel(item)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={useNotes}
                  onChange={(event) => setUseNotes(event.target.checked)}
                />{" "}
                {t("Also read my notes", "Lire aussi mes notes")}
              </label>
            </div>
            {providers.length > 0 && (
              <fieldset className="research-providers">
                <legend>{t("Connected apps to search", "Apps connectées à fouiller")}</legend>
                {providers.map((provider) => (
                  <label key={provider.id}>
                    <input
                      type="checkbox"
                      checked={picked.includes(provider.id)}
                      onChange={(event) =>
                        setPicked((value) =>
                          event.target.checked
                            ? [...value, provider.id]
                            : value.filter((id) => id !== provider.id),
                        )
                      }
                    />{" "}
                    {provider.label}
                  </label>
                ))}
              </fieldset>
            )}
            <p className="quiet">
              {t(
                "Nothing is searched before you approve the plan and its price.",
                "Rien n’est recherché avant que vous approuviez le plan et son prix.",
              )}
            </p>
            <button className="button primary" type="submit" disabled={busy || !question.trim()}>
              {busy ? t("Preparing…", "Préparation…") : t("Start", "Commencer")}
            </button>
          </form>
          <h2>{t("Your research", "Vos recherches")}</h2>
          {runs.length === 0 ? (
            <p className="quiet">{t("No research yet.", "Aucune recherche pour l’instant.")}</p>
          ) : (
            <ul className="research-runs">
              {runs.map((run) => (
                <li key={run.id}>
                  <button type="button" className="wc-chat-row" onClick={() => setOpenId(run.id)}>
                    <strong>{run.plan?.title ?? run.question}</strong>
                    <span className="quiet">
                      {statusLabel(run)} · {date(run.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function RunView({
  run,
  host,
  busy,
  onBack,
  onPlan,
  onApprove,
  onStop,
  onResume,
  onDelete,
}: {
  run: Run;
  host: FeatureHost;
  busy: boolean;
  onBack(): void;
  onPlan(answers: string[]): void;
  onApprove(plan: ResearchPlan, depth: Depth): void;
  onStop(): void;
  onResume(finishNow: boolean): void;
  onDelete(): void;
}) {
  const [answers, setAnswers] = useState<string[]>(() => run.clarifyQuestions.map(() => ""));
  const [plan, setPlan] = useState<ResearchPlan | null>(run.plan);
  const [depth, setDepth] = useState<Depth>(run.depth);
  const [prices, setPrices] = useState<ResearchPrices>({});
  useEffect(() => setPlan(run.plan), [run.plan]);
  useEffect(() => {
    if (run.status !== "planned") return;
    const controller = new AbortController();
    host
      .openKey()
      .catch(() => null)
      .then((key) => researchPrices(host.operator, key, run.model, controller.signal))
      .then(setPrices);
    return () => controller.abort();
  }, [run.status, run.model, host]);

  const searches = plan?.sections.reduce((sum, section) => sum + section.queries.length, 0) ?? 0;
  const done = run.steps.filter((step) => step.status !== "pending").length;
  const read = run.sources.filter((source) => source.status === "read").length;
  const report =
    run.status === "done" && run.reportNoteId
      ? listNotes(host.sync).find((note) => note.id === run.reportNoteId)
      : undefined;

  return (
    <section className="research-run" aria-label={run.plan?.title ?? run.question}>
      <div className="wc-row">
        <button className="button" type="button" onClick={onBack}>
          {t("All research", "Toutes les recherches")}
        </button>
        <button className="button" type="button" onClick={onDelete} disabled={busy}>
          {t("Forget this research", "Oublier cette recherche")}
        </button>
      </div>
      <h2>{run.plan?.title ?? run.question}</h2>
      <p className="quiet" role="status">
        {statusLabel(run)}
        {isLive(run.id) ? "" : run.status === "running" ? ` · ${t("waiting", "en attente")}` : ""}
      </p>

      {run.status === "clarifying" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onPlan(answers);
          }}
        >
          {run.clarifyQuestions.length === 0 ? (
            <p>{t("Nothing needs clarifying.", "Rien à préciser.")}</p>
          ) : (
            run.clarifyQuestions.map((asked, index) => (
              <label key={asked} className="research-answer">
                {asked}
                <input
                  value={answers[index] ?? ""}
                  onChange={(event) =>
                    setAnswers((value) =>
                      value.map((item, at) => (at === index ? event.target.value : item)),
                    )
                  }
                />
              </label>
            ))
          )}
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? t("Planning…", "Planification…") : t("Make the plan", "Établir le plan")}
          </button>
        </form>
      )}

      {run.status === "planned" && plan && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onApprove(plan, depth);
          }}
        >
          <label className="research-answer">
            {t("Title", "Titre")}
            <input
              value={plan.title}
              onChange={(event) => setPlan({ ...plan, title: event.target.value })}
            />
          </label>
          {plan.sections.map((section, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a section is edited in place, never moved.
            <fieldset key={`section-${index}`} className="research-section">
              <legend>{t(`Section ${index + 1}`, `Section ${index + 1}`)}</legend>
              <label className="research-answer">
                {t("What it answers", "Ce qu’elle traite")}
                <input
                  value={section.title}
                  onChange={(event) =>
                    setPlan({
                      ...plan,
                      sections: plan.sections.map((item, at) =>
                        at === index ? { ...item, title: event.target.value } : item,
                      ),
                    })
                  }
                />
              </label>
              <label className="research-answer">
                {t("Searches, one per line", "Recherches, une par ligne")}
                <textarea
                  rows={Math.max(2, section.queries.length)}
                  value={section.queries.join("\n")}
                  onChange={(event) =>
                    setPlan({
                      ...plan,
                      sections: plan.sections.map((item, at) =>
                        at === index ? { ...item, queries: event.target.value.split("\n") } : item,
                      ),
                    })
                  }
                />
              </label>
            </fieldset>
          ))}
          <fieldset className="research-depths">
            <legend>{t("Depth", "Profondeur")}</legend>
            {DEPTHS.map((item) => {
              const value = ceiling(estimate(item, Math.min(searches, maxQueries(item))), prices);
              return (
                <label key={item}>
                  <input
                    type="radio"
                    name="research-depth"
                    checked={depth === item}
                    onChange={() => setDepth(item)}
                  />{" "}
                  {depthLabel(item)}
                  {value.totalUsd !== undefined ? ` · ${usd(value.totalUsd)}` : ""}
                </label>
              );
            })}
          </fieldset>
          <CeilingLine
            value={ceiling(estimate(depth, Math.min(searches, maxQueries(depth))), prices)}
          />
          <button className="button primary" type="submit" disabled={busy}>
            {t("Start research", "Lancer la recherche")}
          </button>
        </form>
      )}

      {(run.status === "running" || run.status === "stopped" || run.status === "failed") && (
        <>
          <p>
            {t(
              `Searches ${done} of ${run.steps.length}, sources read ${read} of ${run.sources.length}.`,
              `Recherches ${done} sur ${run.steps.length}, sources lues ${read} sur ${run.sources.length}.`,
            )}
          </p>
          <progress
            max={Math.max(1, run.steps.length + run.sources.length + 1)}
            value={done + run.sources.filter((source) => source.status !== "pending").length}
          />
        </>
      )}
      {run.error && <p className="error">{run.error}</p>}
      {run.status === "running" && (
        <button className="button" type="button" onClick={onStop} disabled={busy}>
          {t("Stop", "Arrêter")}
        </button>
      )}
      {(run.status === "stopped" || run.status === "failed") && (
        <div className="wc-row">
          <button className="button primary" type="button" onClick={() => onResume(false)}>
            {t("Resume", "Reprendre")}
          </button>
          {read > 0 && (
            <button className="button" type="button" onClick={() => onResume(true)}>
              {t("Write the report from what was read", "Rédiger le rapport avec ce qui a été lu")}
            </button>
          )}
        </div>
      )}

      {run.status === "done" && (
        <>
          <p className="quiet">
            {t(
              `Saved in your notes, with ${run.citedSources} sources cited.`,
              `Enregistré dans vos notes, avec ${run.citedSources} sources citées.`,
            )}
            {run.inventedCitations > 0
              ? ` ${t(
                  `${run.inventedCitations} citations that named no source were removed.`,
                  `${run.inventedCitations} citations qui ne renvoyaient à aucune source ont été retirées.`,
                )}`
              : ""}
          </p>
          {report && (
            <article className="research-report">
              <h3>{report.title}</h3>
              <Markdown text={report.body} />
            </article>
          )}
        </>
      )}
    </section>
  );
}

/** A plan's searches beyond what a depth runs are not run, so not priced. */
function maxQueries(depth: Depth): number {
  return RESEARCH.depths[depth].maxQueries;
}
