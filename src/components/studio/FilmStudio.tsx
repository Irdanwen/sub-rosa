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

import { IconClapboard } from "central-icons/IconClapboard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type BibleEntry,
  type BibleKind,
  listBibleEntries,
  saveBibleEntry,
} from "../../lib/studio/bible";
import { generateReference, portraitCostCredits } from "../../lib/studio/bible/portrait";
import { compileShotList, routeModels, type Shot } from "../../lib/studio/workflow/compile";
import { modelsOfType } from "../../lib/studio/catalog";
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
import { runAndSaveWorkflow } from "../../lib/studio/workflow-run";
import type { MediaCatalog } from "../../lib/studio/types";
import {
  buildShotList,
  createNote,
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
import { Switch } from "../ui/Switch";
import { NotePicker } from "./NotePicker";
import { StudioField } from "./controls";

/** What a production may spend unless the user says otherwise. */
const DEFAULT_ENVELOPE_CREDITS = 200;

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
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [envelope, setEnvelope] = useState(DEFAULT_ENVELOPE_CREDITS);
  const [withScore, setWithScore] = useState(true);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Map<string, NodeRunResult>>(new Map());
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [runError, setRunError] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    listBibleEntries()
      .then(setBible)
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
      withScore,
    });
  }, [shots, note, bible, catalog, envelope, aspectRatio, videoModelId, withScore]);

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
      setError(`That did not compile cleanly: ${validation.errors[0]?.message ?? "unknown"}`);
      return;
    }
    const saved: Workflow = {
      ...createWorkflow(workflow.name),
      nodes: workflow.nodes,
      edges: workflow.edges,
    };
    saveWorkflow(saved);

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
            title="What's your film?"
            description="Write what happens, in a few sentences. Sub Rosa reads it as shots, draws whoever is in it, and makes it."
          />
          <textarea
            className="studio-input studio-textarea"
            rows={6}
            value={draft}
            aria-label="What happens"
            placeholder="Nera waits under the rain in the alley. She hears something behind her and turns. 'Get in the car.' She runs towards the light at the far end."
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
              {busy ? "Reading it..." : "Read it"}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setPicking(true)}>
              Use a note I wrote
            </button>
          </div>
          {note ? <p className="studio-queue-hint">From "{note.title || "Untitled"}".</p> : null}
        </div>
      ) : null}

      {stage === "reading" ? (
        <div className="film-describe">
          <Spinner aria-label="Reading the script" />
          <p className="studio-queue-hint">
            Reading it as shots. This keeps going if you close the app.
          </p>
        </div>
      ) : null}

      {stage === "review" ? (
        <div className="film-review">
          <p className="studio-picker-section-title">
            {shots.length} shot{shots.length === 1 ? "" : "s"},{" "}
            {shots.filter((shot) => shot.dialogue.trim()).length} spoken
          </p>

          {uncast.length > 0 ? (
            <div className="script-casting">
              <p>
                <strong>
                  {uncast.length} name{uncast.length === 1 ? "" : "s"}
                </strong>{" "}
                {uncast.length === 1 ? "has" : "have"} no face yet, so{" "}
                {uncast.length === 1 ? "it is" : "they are"} redrawn from scratch in every shot and
                will not look the same twice.
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
                      {castingName === member.name ? "Drawing..." : "Draw"}
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
                  Draw all {uncast.length}
                  {referenceCost === undefined
                    ? ""
                    : ` (${(referenceCost * uncast.length).toFixed(0)} cr)`}
                </button>
              ) : null}
            </div>
          ) : null}

          <ol className="script-shots">
            {shots.map((shot, index) => (
              <li key={`${shot.scene}-${index}-${shot.action.slice(0, 24)}`}>
                <span className="script-shot-scene">{shot.scene || "Scene"}</span>
                <span>{shot.action}</span>
                {shot.dialogue ? <em>“{shot.dialogue}”</em> : null}
              </li>
            ))}
          </ol>

          {compiled?.refusal ? (
            <p className="studio-error">{compiled.refusal}</p>
          ) : (
            <p className="studio-queue-hint">
              About {compiled?.estimateCredits.toFixed(0)} credits, at least.
            </p>
          )}
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
              Make it
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowOptions((open) => !open)}
            >
              {showOptions ? "Hide options" : "Options"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void startOver()}>
              Start over
            </button>
          </div>

          {showOptions ? (
            <div className="film-options">
              <StudioField label="Shoot on" hint="One family for the whole film">
                <Select
                  value={videoModelId || null}
                  placeholder={
                    routeModels(catalog).text?.name
                      ? `Cheapest (${routeModels(catalog).text?.name})`
                      : "Cheapest"
                  }
                  ariaLabel="Video family"
                  onChange={setVideoModelId}
                  options={modelsOfType(catalog, "video").map((entry) => ({
                    value: entry.id,
                    label: entry.name,
                  }))}
                />
              </StudioField>
              <StudioField label="Aspect ratio">
                <input
                  className="studio-input"
                  value={aspectRatio}
                  aria-label="Aspect ratio"
                  onChange={(event) => setAspectRatio(event.target.value)}
                />
              </StudioField>
              <StudioField label="Spend ceiling" hint="Nothing is made above this">
                <input
                  className="studio-input"
                  inputMode="decimal"
                  value={String(envelope)}
                  aria-label="Spend ceiling"
                  onChange={(event) => {
                    const value = Number(event.target.value.replace(",", "."));
                    setEnvelope(Number.isFinite(value) ? Math.max(0, value) : 0);
                  }}
                />
              </StudioField>
              <StudioField label="Score">
                <Switch checked={withScore} onCheckedChange={setWithScore} />
              </StudioField>
            </div>
          ) : null}
        </div>
      ) : null}

      {stage === "making" ? (
        <div className="film-making">
          <Spinner aria-label="Making the film" />
          <p className="studio-picker-section-title">
            {shotProgress.done} of {shotProgress.total} steps
            {shotProgress.failed > 0 ? `, ${shotProgress.failed} failed` : ""}
          </p>
          <p className="studio-queue-hint">
            Renders keep going if you close the app. Come back and it picks up.
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => abortRef.current?.abort()}
          >
            Stop
          </button>
        </div>
      ) : null}

      {stage === "done" ? (
        <div className="film-done">
          {film?.src ? (
            // biome-ignore lint/a11y/useMediaCaption: a generated film has no track
            <video className="studio-video-player" controls playsInline src={film.src} />
          ) : null}
          <p className="studio-picker-section-title">
            {note?.title?.trim() || "Your film"} is ready.
          </p>
          <div className="studio-card-actions">
            {runId && onOpenProduction ? (
              <button
                type="button"
                className="studio-primary-button"
                onClick={() => onOpenProduction(runId)}
              >
                Finish it
              </button>
            ) : null}
            <button type="button" className="btn btn-secondary" onClick={() => void startOver()}>
              Make another
            </button>
          </div>
          <p className="studio-queue-hint">
            "Finish it" opens the cut in Assemble: play it, move a line, or export a timeline for a
            real editor.
          </p>
        </div>
      ) : null}
    </div>
  );
}
