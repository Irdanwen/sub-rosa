// Making a film, on one screen.
//
// The pieces to make a film all existed and were spread over eight surfaces:
// generate reference images in the Image tab, name a cast in the Bible tab,
// write a script in the Notes app, compile it in Workflows, run it on a node
// graph, and finish it in Assemble. Every screen was individually clear and
// the whole was unusable - roughly thirty-five interactions, five decisions
// asked before any work had been shown, and the word "film" nowhere in the
// navigation.
//
// So: one tab, one order, and the app going first. You describe the film, it
// reads it, it proposes the cast and offers to draw them, it says what the
// whole thing costs, and then it makes it while you watch. Everything after
// "describe" is a correction rather than a decision.
//
// It composes what already exists and reimplements none of it: the reading is
// the durable shot-list row, the production is an ordinary compiled workflow
// (ADR-0030) run by the same durable engine, and the result is an ordinary
// gallery artifact. The Bible, Workflows and Assemble tabs are the same
// objects in detail, so nothing here is a private world.

import { t } from "../../lib/i18n";
import { IconClapboard } from "central-icons/IconClapboard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type BibleEntry,
  type BibleKind,
  listBibleEntries,
  saveBibleEntry,
} from "../../lib/studio/bible";
import { generateReference, portraitCostCredits } from "../../lib/studio/bible/portrait";
import {
  compileShotList,
  familyOf,
  retargetShotModel,
  pickMusicModel,
  pickTtsModel,
  type Shot,
  videoFamilies,
} from "../../lib/studio/workflow/compile";
import { estimateCostCredits, modelsOfType } from "../../lib/studio/catalog";
import {
  estimateWorkflowCost,
  fetchVideoQuotes,
  needsRunConfirmation,
  nodeCostMap,
} from "../../lib/studio/workflow/cost";
import type { Workflow } from "../../lib/studio/workflow/schema";
import { createWorkflow, saveWorkflow } from "../../lib/studio/workflow/store";
import { validateWorkflow } from "../../lib/studio/workflow/validator";
import { type NodeRunResult, WorkflowRunError } from "../../lib/studio/workflow/engine";
import {
  resumeWorkflowRun,
  runAndSaveWorkflow,
  setWorkflowRunDefinition,
} from "../../lib/studio/workflow-run";
import { extractFrameAt } from "../../lib/studio/frames";
import { judge, type JudgeVerdict, pickJudgeModel } from "../../lib/studio/judge";
import type { MediaCatalog } from "../../lib/studio/types";
import {
  buildShotList,
  carpeDiemGetCredits,
  createNote,
  type FilmListItemDto,
  listFilms,
  forgetShotList,
  type NoteListItemDto,
  shotList,
  type ShotListDto,
  type ShotListPlanDto,
  shotListPlan,
  SHOT_LIST_EVENT,
  updateNote,
} from "../../lib/tauri";
import { EmptyState } from "../ui/EmptyState";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { Darkroom } from "./Darkroom";
import { Switch } from "../ui/Switch";
import { NotePicker } from "./NotePicker";
import { StudioField } from "./controls";
import { STUDIO_FILM_NOTE_KEY } from "./studio-keys";

/** Which engines this user likes to shoot on. See the effect that reads it. */
const FILM_MODELS_KEY = "os-june:film-models";

/** What a production may spend when the balance cannot be read at all. */
const FALLBACK_ENVELOPE_CREDITS = 200;

/**
 * The ceiling to start from, given what the account actually holds.
 *
 * Not a round number: a fixed default is wrong in both directions. Set it
 * above the balance and the compile happily builds a film the run cannot pay
 * for, which fails half way through having spent the first half. Set it below
 * and it refuses a film the user could easily afford. The balance is the only
 * number that is right, so the ceiling is the balance - the ceiling is there
 * to stop a runaway, not to be a budget the user has to guess.
 */
/**
 * When a film is close enough to the balance to be worth saying so.
 *
 * The estimate is a *minimum*: metered renders publish no price and count
 * zero. So a film estimated at most of the balance can still run out half way,
 * and the honest thing is to say that before it is started rather than after.
 * Four fifths is a warning threshold, not a gate - nothing is refused here.
 */
export const TIGHT_BUDGET_FRACTION = 0.8;

export function isTight(estimateCredits: number, availableCredits: number | undefined): boolean {
  if (availableCredits === undefined || !Number.isFinite(availableCredits)) return false;
  return estimateCredits > availableCredits * TIGHT_BUDGET_FRACTION;
}

export function ceilingFor(availableCredits: number | undefined): number {
  if (availableCredits === undefined || !Number.isFinite(availableCredits)) {
    return FALLBACK_ENVELOPE_CREDITS;
  }
  return Math.max(0, Math.floor(availableCredits));
}

interface CastMember {
  name: string;
  kind: BibleKind;
  traits: string;
}

/** A reading, in either shape it can have on disk. */
function parseReading(row: ShotListDto | null | undefined): {
  shots: Shot[];
  cast: CastMember[];
} {
  if (!row?.shotsJson) return { shots: [], cast: [] };
  try {
    const parsed: unknown = JSON.parse(row.shotsJson);
    if (Array.isArray(parsed)) return { shots: parsed as Shot[], cast: [] };
    const body = (parsed ?? {}) as { shots?: unknown; cast?: unknown };
    return {
      shots: Array.isArray(body.shots) ? (body.shots as Shot[]) : [],
      cast: Array.isArray(body.cast) ? (body.cast as CastMember[]) : [],
    };
  } catch {
    return { shots: [], cast: [] };
  }
}

type Stage = "describe" | "reading" | "review" | "making" | "done";

export function FilmStudio({
  catalog,
  onOpenProduction,
}: {
  catalog: MediaCatalog;
  /** Hand the finished film to Assemble, which is where it gets finished. */
  onOpenProduction?: (runId: string) => void;
}) {
  const [note, setNote] = useState<NoteListItemDto | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [picking, setPicking] = useState(false);
  const [row, setRow] = useState<ShotListDto | null>(null);
  const [plan, setPlan] = useState<ShotListPlanDto | undefined>(undefined);
  const [bible, setBible] = useState<BibleEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [castingName, setCastingName] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const [showOptions, setShowOptions] = useState(false);
  const [videoModelId, setVideoModelId] = useState("");
  const [ttsModelId, setTtsModelId] = useState("");
  const [musicModelId, setMusicModelId] = useState("");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [envelope, setEnvelope] = useState(FALLBACK_ENVELOPE_CREDITS);
  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [films, setFilms] = useState<FilmListItemDto[]>([]);
  // The user has not overruled the ceiling, so it keeps following the balance.
  const ceilingTouched = useRef(false);
  const [withScore, setWithScore] = useState(true);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Map<string, NodeRunResult>>(new Map());
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [runError, setRunError] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const workflowRef = useRef<Workflow | undefined>(undefined);
  const [verdict, setVerdict] = useState<JudgeVerdict | undefined>(undefined);
  const [judging, setJudging] = useState(false);

  // Remembered across films, because it is a taste, not a per-film decision:
  // somebody who found an engine they like should not re-find it every time.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(FILM_MODELS_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved) as Record<string, unknown>;
      if (typeof parsed.video === "string") setVideoModelId(parsed.video);
      if (typeof parsed.tts === "string") setTtsModelId(parsed.tts);
      if (typeof parsed.music === "string") setMusicModelId(parsed.music);
    } catch {
      // Unreadable or absent: the defaults below are perfectly good.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        FILM_MODELS_KEY,
        JSON.stringify({ video: videoModelId, tts: ttsModelId, music: musicModelId }),
      );
    } catch {
      // No storage: the choice simply lasts as long as the tab does.
    }
  }, [videoModelId, ttsModelId, musicModelId]);

  useEffect(() => {
    listBibleEntries()
      .then(setBible)
      .catch(() => undefined);
    // A note the shell asked for, read once and cleared: coming back to the
    // tab later should not silently reopen a film from last week.
    try {
      const asked = window.localStorage.getItem(STUDIO_FILM_NOTE_KEY);
      if (asked) {
        window.localStorage.removeItem(STUDIO_FILM_NOTE_KEY);
        setNote({ id: asked, title: "" } as NoteListItemDto);
      }
    } catch {
      // No storage: the tab simply opens on its own empty state.
    }
    listFilms()
      // Defensive: this list is a convenience, and a command surface that
      // answers oddly must not take the whole tab down with it.
      .then((list) => setFilms(Array.isArray(list) ? list : []))
      .catch(() => undefined);
    carpeDiemGetCredits()
      .then((credits) => {
        setBalance(credits.availableCredits);
        if (!ceilingTouched.current) setEnvelope(ceilingFor(credits.availableCredits));
      })
      // A balance that cannot be read leaves the fallback in place rather than
      // blocking a film on a number nobody asked about.
      .catch(() => undefined);
  }, []);
  useEffect(() => () => abortRef.current?.abort(), []);

  // The reading is a durable row, so it changes from outside this component.
  useEffect(() => {
    if (!note) return;
    let cancelled = false;
    void shotList(note.id).then((current) => {
      if (!cancelled) setRow(current);
    });
    void shotListPlan(note.id).then((current) => {
      if (!cancelled) setPlan(current);
    });
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then((api) =>
        api.listen<ShotListDto>(SHOT_LIST_EVENT, (event) => {
          if (!cancelled && event.payload.noteId === note.id) setRow(event.payload);
        }),
      )
      .then((stop) => {
        if (cancelled) stop?.();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [note]);

  const reading = useMemo(() => parseReading(row), [row]);
  const shots = reading.shots;
  const referenceCost = useMemo(() => portraitCostCredits(catalog), [catalog]);
  const families = useMemo(() => videoFamilies(catalog), [catalog]);
  const voiceModels = useMemo(() => modelsOfType(catalog, "tts"), [catalog]);
  const musicModels = useMemo(() => modelsOfType(catalog, "music"), [catalog]);
  /** What is actually going to be used, chosen or defaulted, for the summary line. */
  const chosen = useMemo(
    () => ({
      family: familyOf(catalog, videoModelId) ?? families[0],
      voice: pickTtsModel(catalog, ttsModelId || undefined),
      music: pickMusicModel(catalog, musicModelId || undefined),
    }),
    [catalog, families, videoModelId, ttsModelId, musicModelId],
  );

  /** Who the script names that the bible has never met, described. */
  const uncast = useMemo(() => {
    const known = new Set(bible.map((entry) => entry.name.trim().toLowerCase()));
    const described = new Map(
      reading.cast.map((member) => [member.name.trim().toLowerCase(), member]),
    );
    const found = new Map<string, CastMember>();
    for (const shot of shots) {
      for (const [name, kind] of [
        ...shot.characters.map((who) => [who, "character" as BibleKind] as const),
        [shot.location, "location" as BibleKind] as const,
      ]) {
        const key = name.trim().toLowerCase();
        if (!key || known.has(key) || found.has(key)) continue;
        const known_ = described.get(key);
        found.set(key, {
          name: known_?.name?.trim() || name.trim(),
          kind: known_?.kind ?? kind,
          traits: known_?.traits ?? "",
        });
      }
    }
    return [...found.values()];
  }, [shots, reading.cast, bible]);

  const compiled = useMemo(() => {
    if (shots.length === 0) return undefined;
    return compileShotList({
      name: note?.title?.trim() || "Untitled film",
      shots,
      bible,
      catalog,
      envelopeCredits: envelope,
      aspectRatio,
      videoModelId: videoModelId || undefined,
      ttsModelId: ttsModelId || undefined,
      musicModelId: musicModelId || undefined,
      withScore,
    });
  }, [
    shots,
    note,
    bible,
    catalog,
    envelope,
    aspectRatio,
    videoModelId,
    ttsModelId,
    musicModelId,
    withScore,
  ]);

  /**
   * The film itself, once there is one.
   *
   * This is what "done" means. Reading it off the assemble node rather than
   * off "the run returned" matters: a run that failed also returns, and
   * telling somebody their film is ready when a shot failed is the worst
   * thing this screen can do.
   */
  const film = useMemo(() => {
    const assembleId = compiled?.workflow?.nodes.find((node) => node.type === "assemble")?.id;
    const result = assembleId ? progress.get(assembleId) : undefined;
    return result?.status === "done" && result.output?.kind === "video" ? result.output : undefined;
  }, [progress, compiled]);

  const stage: Stage = running
    ? "making"
    : film
      ? "done"
      : shots.length > 0
        ? "review"
        : row?.status === "running" || row?.status === "pending"
          ? "reading"
          : "describe";

  /** Turn what was typed into a note, so the script is a note like any other. */
  const readIt = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      let target = note;
      if (!target) {
        const text = draft.trim();
        if (!text) return;
        const created = await createNote();
        const title = text.split(/[.\n]/)[0]?.slice(0, 60) || "Untitled film";
        await updateNote({ noteId: created.id, title, editedContent: text });
        target = { ...created, title } as NoteListItemDto;
        setNote(target);
      }
      setRow(await buildShotList(target.id));
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "That could not be read.");
    } finally {
      setBusy(false);
    }
  }, [busy, note, draft]);

  const castOne = useCallback(
    async (member: CastMember) => {
      setCastingName(member.name);
      setError(undefined);
      try {
        const id = await saveBibleEntry({
          kind: member.kind,
          name: member.name,
          traits: member.traits,
        });
        await generateReference(
          {
            id,
            kind: member.kind,
            name: member.name,
            traits: member.traits,
            note: "",
            refs: [],
            createdAt: "",
            updatedAt: "",
          },
          member.kind === "location" ? "wide" : "portrait",
          catalog,
        );
        setBible(await listBibleEntries());
      } catch (castError) {
        setError(castError instanceof Error ? castError.message : "That could not be drawn.");
      } finally {
        setCastingName(undefined);
      }
    },
    [catalog],
  );

  const castEveryone = useCallback(async () => {
    for (const member of uncast) await castOne(member);
  }, [uncast, castOne]);

  /**
   * Make the film.
   *
   * The compiled graph is saved as an ordinary workflow before it runs, so a
   * production started here is visible, resumable and editable on the canvas
   * like any other - this tab is a way in, never a private world.
   */
  const makeIt = useCallback(async () => {
    const workflow = compiled?.workflow;
    if (!workflow || running) return;
    const validation = validateWorkflow(workflow);
    if (!validation.ok) {
      setError(
        t("That did not compile cleanly: {reason}", {
          reason: validation.errors[0]?.message ?? t("unknown"),
        }),
      );
      return;
    }
    const saved: Workflow = {
      ...createWorkflow(workflow.name),
      nodes: workflow.nodes,
      edges: workflow.edges,
    };
    saveWorkflow(saved);
    workflowRef.current = saved;

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setRunning(true);
    setRunError(undefined);
    setProgress(new Map());
    try {
      const estimate = estimateWorkflowCost(saved, catalog);
      const refined = needsRunConfirmation(estimate)
        ? estimateWorkflowCost(saved, catalog, await fetchVideoQuotes(saved, catalog))
        : estimate;
      await runAndSaveWorkflow(saved, {
        signal: controller.signal,
        nodeCosts: nodeCostMap(refined),
        onRunRecorded: setRunId,
        onUpdate: (result) => setProgress((current) => new Map(current).set(result.nodeId, result)),
      });
    } catch (madeError) {
      if (madeError instanceof DOMException && madeError.name === "AbortError") {
        // Stopped on purpose.
      } else if (madeError instanceof WorkflowRunError) {
        setRunError(madeError.message);
      } else {
        setRunError(madeError instanceof Error ? madeError.message : "The film failed.");
      }
    } finally {
      setRunning(false);
    }
  }, [compiled, running, catalog]);

  /** The shot nodes of the film that ran, with what each one produced. */
  /** What one shot and the cut it feeds cost to make again. */
  const retakeCost = useMemo(() => {
    const workflow = workflowRef.current ?? compiled?.workflow;
    if (!workflow) return undefined;
    const shot = workflow.nodes.find((node) => node.type === "video");
    const modelId = typeof shot?.params.model === "string" ? shot.params.model : "";
    const model = catalog.models.find((entry) => entry.id === modelId);
    return model ? estimateCostCredits(model, { multiplier: catalog.priceMultiplier }) : undefined;
  }, [compiled, catalog]);

  const madeShots = useMemo(() => {
    const workflow = workflowRef.current ?? compiled?.workflow;
    if (!workflow) return [];
    return workflow.nodes
      .filter((node) => node.type === "video")
      .map((node, index) => {
        const result = progress.get(node.id);
        return {
          nodeId: node.id,
          // Numbered, because several shots share a scene name and the judge
          // is asked to point at one of them. Matching a remark back by scene
          // would attach it to whichever shot happened to be first.
          label: node.label ? `Shot ${index + 1}, ${node.label}` : `Shot ${index + 1}`,
          index,
          status: result?.status ?? "pending",
          src: result?.output?.kind === "video" ? result.output.src : undefined,
        };
      });
  }, [progress, compiled]);

  /**
   * Make one shot again, and only what was built from it.
   *
   * The same resume machinery that makes a restart cheap, pointed the other
   * way: everything else replays from cache, so a retake costs one shot and
   * the cut - not the film.
   */
  /**
   * Make one shot again, optionally on a different engine.
   *
   * The engine is offered here rather than up front because this is the
   * informed moment: the user has seen what this one produced, which is the
   * only thing that makes the choice mean anything.
   */
  const redoShot = useCallback(
    async (nodeId: string, familyId?: string) => {
      if (!runId || running) return;
      if (familyId) {
        const current = workflowRef.current;
        const patched = current ? retargetShotModel(current, nodeId, catalog, familyId) : undefined;
        if (patched) {
          workflowRef.current = patched;
          // Persisted before the resume, which reads the graph back from the
          // row: an in-memory patch would be forgotten by the next resume.
          try {
            await setWorkflowRunDefinition(runId, patched);
          } catch {
            setRunError("That engine could not be recorded for this shot.");
            return;
          }
        }
      }
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      setRunning(true);
      setRunError(undefined);
      setVerdict(undefined);
      try {
        await resumeWorkflowRun(runId, {
          signal: controller.signal,
          redoNodeIds: [nodeId],
          onUpdate: (result) =>
            setProgress((current) => new Map(current).set(result.nodeId, result)),
        });
      } catch (redoError) {
        if (!(redoError instanceof DOMException && redoError.name === "AbortError")) {
          setRunError(redoError instanceof Error ? redoError.message : "That retake failed.");
        }
      } finally {
        setRunning(false);
      }
    },
    [runId, running, catalog],
  );

  /**
   * Ask a model to watch the cut and say which shots let the others down.
   *
   * One frame per shot rather than the film: it is what a supervisor actually
   * looks at, it costs a fraction of a video call, and the picture is what
   * drifts. Best-effort, like every judge: no opinion is not an error.
   */
  const review = useCallback(async () => {
    const model = pickJudgeModel(modelsOfType(catalog, "text"));
    if (!model || judging) {
      if (!model) setError(t("No model on this account can look at pictures."));
      return;
    }
    setJudging(true);
    setError(undefined);
    try {
      const subjects = [];
      for (const shot of madeShots) {
        if (!shot.src) continue;
        try {
          const frame = await extractFrameAt(shot.src, 1);
          subjects.push({ label: shot.label, imageDataUri: frame.dataUrl });
        } catch {
          // A shot whose frame will not decode is left out rather than
          // stopping the review of the ones that will.
        }
      }
      const result = await judge(
        {
          subjects,
          brief: note?.title?.trim() || undefined,
          lens: "the cut as a whole: continuity, rhythm, and whether any shot lets the others down",
        },
        model,
      );
      setVerdict(result);
      if (!result) setError(t("The judge had nothing to say this time."));
    } finally {
      setJudging(false);
    }
  }, [catalog, judging, madeShots, note]);

  const startOver = useCallback(async () => {
    if (note) await forgetShotList(note.id).catch(() => undefined);
    setNote(undefined);
    setDraft("");
    setRow(null);
    setPlan(undefined);
    setRunId(undefined);
    setProgress(new Map());
    setRunError(undefined);
    setError(undefined);
  }, [note]);

  const shotProgress = useMemo(() => {
    const nodes = [...progress.values()];
    return {
      done: nodes.filter((node) => node.status === "done").length,
      total: compiled?.workflow?.nodes.length ?? 0,
      failed: nodes.filter((node) => node.status === "error").length,
    };
  }, [progress, compiled]);

  return (
    <div className="studio-generation film-studio">
      {picking ? (
        <NotePicker
          onClose={() => setPicking(false)}
          onPick={(picked) => {
            setNote(picked);
            setPicking(false);
          }}
        />
      ) : null}

      {error ? <p className="studio-error">{error}</p> : null}
      {runError ? <p className="studio-error">{runError}</p> : null}

      {stage === "describe" ? (
        <div className="film-describe">
          <EmptyState
            icon={<IconClapboard size={22} />}
            title={t("What's your film?")}
            description={t(
              "Write what happens, in a few sentences. Sub Rosa reads it as shots, draws whoever is in it, and makes it.",
            )}
          />
          <textarea
            className="studio-input studio-textarea"
            rows={6}
            value={draft}
            aria-label={t("What happens")}
            placeholder={t(
              "Nera waits under the rain in the alley. She hears something behind her and turns. 'Get in the car.' She runs towards the light at the far end.",
            )}
            onChange={(event) => setDraft(event.target.value)}
          />
          {plan && !plan.breakable ? <p className="studio-queue-hint">{plan.reason}</p> : null}
          <div className="studio-card-actions">
            <button
              type="button"
              className="studio-primary-button"
              disabled={busy || (!note && draft.trim().length === 0)}
              onClick={() => void readIt()}
            >
              {busy ? t("Reading it...") : t("Read it")}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setPicking(true)}>
              {t("Use a note I wrote")}
            </button>
          </div>
          {note ? (
            <p className="studio-queue-hint">
              {t('From "{title}".', { title: note.title || t("Untitled") })}
            </p>
          ) : null}
          {films.length > 0 ? (
            <div className="film-previous">
              {/* A reading is paid for. Leaving this tab used to lose the way
                  back to one, which meant paying for it twice. */}
              <p className="studio-picker-section-title">{t("Films you started")}</p>
              <ul>
                {films.map((film) => (
                  <li key={film.noteId}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() =>
                        setNote({ id: film.noteId, title: film.title } as NoteListItemDto)
                      }
                    >
                      {film.title || t("Untitled film")}
                      <em>
                        {film.status === "ready"
                          ? film.shotCount === 1
                            ? t(" 1 shot")
                            : t(" {count} shots", { count: film.shotCount })
                          : film.status === "failed"
                            ? t(" stopped")
                            : t(" still reading")}
                      </em>
                    </button>
                    {/* Forgetting a reading, not the note: a script that was
                        read badly should not sit in this list forever, and
                        the note itself is the user's writing. */}
                    <button
                      type="button"
                      className="studio-icon-button"
                      aria-label={t("Forget the reading of {name}", {
                        name: film.title || t("this film"),
                      })}
                      onClick={async () => {
                        await forgetShotList(film.noteId).catch(() => undefined);
                        setFilms((current) =>
                          current.filter((entry) => entry.noteId !== film.noteId),
                        );
                      }}
                    >
                      <span aria-hidden>x</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {stage === "reading" ? (
        <div className="film-describe">
          <Spinner aria-label={t("Reading the script")} />
          <p className="studio-queue-hint">
            {t("Reading it as shots. This keeps going if you close the app.")}
          </p>
        </div>
      ) : null}

      {stage === "review" ? (
        <div className="film-review">
          <p className="studio-picker-section-title">
            {shots.length === 1 ? t("1 shot") : t("{count} shots", { count: shots.length })},{" "}
            {t("{count} spoken", { count: shots.filter((shot) => shot.dialogue.trim()).length })}
          </p>

          {uncast.length > 0 ? (
            <div className="script-casting">
              <p>
                <strong>
                  {uncast.length === 1 ? t("1 name") : t("{count} names", { count: uncast.length })}
                </strong>{" "}
                {uncast.length === 1
                  ? t(
                      "has no face yet, so it is redrawn from scratch in every shot and will not look the same twice.",
                    )
                  : t(
                      "have no face yet, so they are redrawn from scratch in every shot and will not look the same twice.",
                    )}
              </p>
              <ul className="script-cast-list">
                {uncast.map((member) => (
                  <li key={member.name}>
                    <span>
                      {member.name}
                      <em> {member.traits || member.kind}</em>
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={castingName !== undefined}
                      onClick={() => void castOne(member)}
                    >
                      {castingName === member.name ? t("Drawing...") : t("Draw")}
                    </button>
                  </li>
                ))}
              </ul>
              {uncast.length > 1 ? (
                <button
                  type="button"
                  className="studio-primary-button"
                  disabled={castingName !== undefined}
                  onClick={() => void castEveryone()}
                >
                  {t("Draw all {count}", { count: uncast.length })}
                  {referenceCost === undefined
                    ? ""
                    : t(" ({credits} cr)", { credits: (referenceCost * uncast.length).toFixed(0) })}
                </button>
              ) : null}
            </div>
          ) : null}

          <ol className="script-shots">
            {shots.map((shot, index) => (
              <li key={`${shot.scene}-${index}-${shot.action.slice(0, 24)}`}>
                <span className="script-shot-scene">{shot.scene || t("Scene")}</span>
                <span>{shot.action}</span>
                {shot.dialogue ? <em>“{shot.dialogue}”</em> : null}
              </li>
            ))}
          </ol>

          {compiled?.refusal ? (
            <p className="studio-error">{compiled.refusal}</p>
          ) : (
            <p
              className={
                isTight(compiled?.estimateCredits ?? 0, balance)
                  ? "studio-error"
                  : "studio-queue-hint"
              }
            >
              {t("About {credits} credits, at least", {
                credits: compiled?.estimateCredits.toFixed(0) ?? "",
              })}
              {balance === undefined
                ? ""
                : t(" of the {balance} you have", { balance: Math.floor(balance) })}
              .
              {isTight(compiled?.estimateCredits ?? 0, balance)
                ? ` ${t("Renders with no published price are not in that figure, so this one could run out part way. Fewer shots would be safer.")}`
                : ""}
            </p>
          )}
          <p className="film-crew">
            {t("Shot on")}{" "}
            <button type="button" onClick={() => setShowOptions(true)}>
              {chosen.family?.label ?? t("no video model")}
            </button>
            {chosen.family?.costCredits === undefined
              ? ""
              : t(" ({credits} cr a shot)", { credits: chosen.family.costCredits.toFixed(0) })}
            {chosen.voice ? (
              <>
                , {t("spoken by")}{" "}
                <button type="button" onClick={() => setShowOptions(true)}>
                  {chosen.voice.name}
                </button>
              </>
            ) : null}
            {withScore && chosen.music ? (
              <>
                , {t("scored by")}{" "}
                <button type="button" onClick={() => setShowOptions(true)}>
                  {chosen.music.name}
                </button>
              </>
            ) : null}
            .
          </p>
          {compiled?.warnings.map((line) => (
            <p key={line} className="film-warning">
              {line}
            </p>
          ))}
          {compiled?.notes.map((line) => (
            <p key={line} className="studio-queue-hint">
              {line}
            </p>
          ))}

          <div className="studio-card-actions">
            <button
              type="button"
              className="studio-primary-button"
              disabled={!compiled?.workflow}
              onClick={() => void makeIt()}
            >
              {t("Make it")}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowOptions((open) => !open)}
            >
              {showOptions ? t("Hide options") : t("Options")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void startOver()}>
              {t("Start over")}
            </button>
          </div>

          {showOptions ? (
            <div className="film-options">
              <StudioField
                label={t("Shoot on")}
                hint={t("One engine for the whole film. Only some can carry a face between shots.")}
              >
                <Select
                  value={videoModelId || null}
                  placeholder={
                    families[0]
                      ? t("Cheapest ({name})", { name: families[0].label })
                      : t("Cheapest")
                  }
                  ariaLabel={t("Video family")}
                  onChange={setVideoModelId}
                  options={families.map((family) => ({
                    value: family.representativeId,
                    label: `${family.label}${
                      family.costCredits === undefined
                        ? ""
                        : ` ${t("({credits} cr a shot)", { credits: family.costCredits.toFixed(0) })}`
                    }${family.holdsFaces ? ", holds faces" : ""}`,
                  }))}
                />
              </StudioField>
              <StudioField label={t("Voices")} hint={t("Who speaks the dialogue")}>
                <Select
                  value={ttsModelId || null}
                  placeholder={
                    chosen.voice
                      ? t("Most voices ({name})", { name: chosen.voice.name })
                      : t("No voice model")
                  }
                  ariaLabel={t("Voice model")}
                  onChange={setTtsModelId}
                  options={voiceModels.map((entry) => ({
                    value: entry.id,
                    label: entry.voices?.length
                      ? `${entry.name} (${entry.voices.length} voices)`
                      : entry.name,
                  }))}
                />
              </StudioField>
              {withScore ? (
                <StudioField label={t("Score")} hint={t("Who writes the music")}>
                  <Select
                    value={musicModelId || null}
                    placeholder={chosen.music ? chosen.music.name : t("No music model")}
                    ariaLabel={t("Music model")}
                    onChange={setMusicModelId}
                    options={musicModels.map((entry) => ({
                      value: entry.id,
                      label: entry.name,
                    }))}
                  />
                </StudioField>
              ) : null}
              <StudioField label={t("Aspect ratio")}>
                <input
                  className="studio-input"
                  value={aspectRatio}
                  aria-label={t("Aspect ratio")}
                  onChange={(event) => setAspectRatio(event.target.value)}
                />
              </StudioField>
              <StudioField
                label={t("Spend ceiling")}
                hint={
                  balance === undefined
                    ? t("Nothing is made above this")
                    : t("Nothing is made above this. You have {credits}.", {
                        credits: Math.floor(balance),
                      })
                }
              >
                <input
                  className="studio-input"
                  inputMode="decimal"
                  value={String(envelope)}
                  aria-label={t("Spend ceiling")}
                  onChange={(event) => {
                    ceilingTouched.current = true;
                    const value = Number(event.target.value.replace(",", "."));
                    setEnvelope(Number.isFinite(value) ? Math.max(0, value) : 0);
                  }}
                />
              </StudioField>
              <StudioField label={t("Score")}>
                <Switch checked={withScore} onCheckedChange={setWithScore} />
              </StudioField>
            </div>
          ) : null}
        </div>
      ) : null}

      {stage === "making" ? (
        <div className="film-making">
          {/* The one wait in the app with a real denominator: a film knows how
           * many steps it has, so the bar is measured rather than estimated. */}
          <Darkroom
            className="film-darkroom"
            seed={note?.id ?? "film"}
            phase="processing"
            label={t("Making your film")}
            progress={shotProgress.total > 0 ? shotProgress.done / shotProgress.total : undefined}
            meta={
              shotProgress.failed > 0
                ? t("{done} of {total} steps, {failed} failed", {
                    done: shotProgress.done,
                    total: shotProgress.total,
                    failed: shotProgress.failed,
                  })
                : t("{done} of {total} steps", {
                    done: shotProgress.done,
                    total: shotProgress.total,
                  })
            }
            actions={
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => abortRef.current?.abort()}
              >
                {t("Stop")}
              </button>
            }
          />
          <p className="studio-queue-hint">
            {t("Renders keep going if you close the app. Come back and it picks up.")}
          </p>
        </div>
      ) : null}

      {stage === "done" ? (
        <div className="film-done">
          {film?.src ? (
            // biome-ignore lint/a11y/useMediaCaption: a generated film has no track
            <video className="studio-video-player" controls playsInline src={film.src} />
          ) : null}
          <p className="studio-picker-section-title">
            {t("{title} is ready.", { title: note?.title?.trim() || t("Your film") })}
          </p>
          <div className="studio-card-actions">
            {runId && onOpenProduction ? (
              <button
                type="button"
                className="studio-primary-button"
                onClick={() => onOpenProduction(runId)}
              >
                {t("Finish it")}
              </button>
            ) : null}
            <button type="button" className="btn btn-secondary" onClick={() => void startOver()}>
              {t("Make another")}
            </button>
          </div>
          <p className="studio-queue-hint">
            {t(
              '"Finish it" opens the cut in Assemble: play it, move a line, or export a timeline for a real editor.',
            )}
          </p>

          <button
            type="button"
            className="btn btn-secondary"
            disabled={judging || running}
            onClick={() => void review()}
          >
            {judging ? t("Watching it...") : t("Review the cut")}
          </button>
          {verdict ? (
            <div className="studio-verdict" data-passes={verdict.passes}>
              <p className="studio-verdict-score">
                {verdict.score}/10 {verdict.summary}
              </p>
            </div>
          ) : null}

          <ul className="film-shot-strip">
            {madeShots.map((shot) => {
              const weak = verdict?.weakest.find((item) => item.label === shot.label);
              return (
                <li key={shot.nodeId} data-weak={Boolean(weak)}>
                  {shot.src ? (
                    // biome-ignore lint/a11y/useMediaCaption: a generated shot has no track
                    <video src={shot.src} muted playsInline preload="metadata" controls />
                  ) : (
                    <span className="film-shot-placeholder">{shot.index + 1}</span>
                  )}
                  {weak ? <span className="film-shot-why">{weak.why}</span> : null}
                  <button
                    type="button"
                    className={weak ? "btn btn-secondary" : "btn btn-ghost"}
                    disabled={running}
                    onClick={() => void redoShot(shot.nodeId)}
                  >
                    {running
                      ? t("Working...")
                      : retakeCost === undefined
                        ? t("Do it again")
                        : t("Do it again ({credits} cr)", { credits: retakeCost.toFixed(0) })}
                  </button>
                  <Select
                    value={null}
                    placeholder={t("On another engine")}
                    ariaLabel={t("Remake shot {index} on another engine", {
                      index: shot.index + 1,
                    })}
                    disabled={running}
                    onChange={(value) => void redoShot(shot.nodeId, value)}
                    options={families
                      .filter((family) => family.stem !== chosen.family?.stem)
                      .map((family) => ({
                        value: family.representativeId,
                        label: `${family.label}${
                          family.costCredits === undefined
                            ? ""
                            : ` (${family.costCredits.toFixed(0)} cr)`
                        }`,
                      }))}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
