// From a script to a film.
//
// The gesture the whole local production path exists for: pick a note, let it
// be read as shots, and hand the result to the canvas as a workflow.
//
// The two halves are deliberately separate. Breaking the script down is a
// durable row on the note (`src-tauri/src/shotlist`) that survives being
// closed and resumes part by part. Compiling is instant, free, and local
// (`lib/studio/workflow/compile`) - so it can be re-run with a different
// ceiling, a different aspect, with or without a score, until the figure is
// one the user agrees to, without spending anything to find out.
//
// Nothing here can start a render. It produces a graph, and the canvas's own
// confirmation handshake stands between that graph and the money.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type BibleEntry,
  type BibleKind,
  listBibleEntries,
  saveBibleEntry,
} from "../../lib/studio/bible";
import { generateReference, portraitCostCredits } from "../../lib/studio/bible/portrait";
import {
  buildShotList,
  forgetShotList,
  type NoteListItemDto,
  shotList,
  shotListPlan,
  type ShotListDto,
  type ShotListPlanDto,
  SHOT_LIST_EVENT,
} from "../../lib/tauri";
import { compileShotList, routeModels, type Shot } from "../../lib/studio/workflow/compile";
import { modelsOfType } from "../../lib/studio/catalog";
import type { Workflow } from "../../lib/studio/workflow/schema";
import { validateWorkflow } from "../../lib/studio/workflow/validator";
import type { MediaCatalog } from "../../lib/studio/types";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { Switch } from "../ui/Switch";
import { NotePicker } from "./NotePicker";
import { StudioField } from "./controls";

/** What a production may spend before this refuses to build it. */
const DEFAULT_ENVELOPE_CREDITS = 100;

/** Somebody or somewhere the script names, described by the reading. */
interface CastMember {
  name: string;
  kind: BibleKind;
  traits: string;
}

/**
 * A reading, in either shape it can have on disk.
 *
 * The object carrying a cast is what the current prompt produces; a bare array
 * of shots is what every reading stored before the cast existed looks like,
 * and what a model returns when it ignores half the instruction.
 */
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

export function ScriptToFilm({
  catalog,
  onCompiled,
  onClose,
}: {
  catalog: MediaCatalog;
  /** Hands the compiled graph to the canvas. */
  onCompiled: (workflow: Workflow) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState<NoteListItemDto | undefined>(undefined);
  const [picking, setPicking] = useState(true);
  const [plan, setPlan] = useState<ShotListPlanDto | undefined>(undefined);
  const [row, setRow] = useState<ShotListDto | null>(null);
  const [bible, setBible] = useState<BibleEntry[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Which name is being given a face right now.
  const [castingName, setCastingName] = useState<string | undefined>(undefined);

  const [envelope, setEnvelope] = useState(DEFAULT_ENVELOPE_CREDITS);
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [withScore, setWithScore] = useState(true);
  const [gateBeforeAssemble, setGateBeforeAssemble] = useState(false);
  // Empty means "whatever this account publishes cheapest", which is what
  // `routeModels` decides. Choosing here pins the whole film to one family.
  const [videoModelId, setVideoModelId] = useState("");

  useEffect(() => {
    listBibleEntries()
      .then(setBible)
      .catch(() => undefined);
  }, []);

  // The row is durable, so it changes from outside this component: a run
  // started here keeps going after the dialog is closed and reopened.
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

  /**
   * Which bible entries the script actually reached, and which names it used
   * that the bible has never heard of.
   *
   * The matching is by name, so a script calling her "Nera" and a bible entry
   * called "Nera" hold the same face - and a script calling her "Néra" holds
   * nothing at all, renders every shot from scratch, and says nothing about
   * it. That silence is the single most expensive thing this surface can do,
   * because it is only visible once the shots are paid for.
   */
  const casting = useMemo(() => {
    const known = new Map(bible.map((entry) => [entry.name.trim().toLowerCase(), entry]));
    const used = new Set<string>();
    // A name the bible has never heard of, with what the script used it as -
    // which is what decides whether it gets a face or an establishing shot.
    const unknown = new Map<string, BibleKind>();
    for (const shot of shots) {
      for (const [name, kind] of [
        ...shot.characters.map((who) => [who, "character" as BibleKind] as const),
        [shot.location, "location" as BibleKind] as const,
      ]) {
        const key = name.trim().toLowerCase();
        if (!key) continue;
        if (known.has(key)) used.add(known.get(key)?.name ?? key);
        else if (!unknown.has(key)) unknown.set(key, kind);
      }
    }
    const described = new Map(
      reading.cast.map((member) => [member.name.trim().toLowerCase(), member]),
    );
    const names = new Map<string, CastMember>();
    for (const shot of shots) {
      for (const name of [...shot.characters, shot.location]) {
        const key = name.trim().toLowerCase();
        const kind = unknown.get(key);
        if (!kind || names.has(key)) continue;
        // The reading's own description wins: it read the whole script, and
        // an entry with a face and no traits is half an entry.
        const known = described.get(key);
        names.set(key, {
          name: known?.name?.trim() || name.trim(),
          kind: known?.kind ?? kind,
          traits: known?.traits ?? "",
        });
      }
    }
    return { used: [...used], unknown: [...names.values()] };
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
      gateBeforeAssemble,
    });
  }, [
    shots,
    note,
    bible,
    catalog,
    envelope,
    aspectRatio,
    withScore,
    gateBeforeAssemble,
    videoModelId,
  ]);

  /**
   * Give a name from the script a face, in one gesture.
   *
   * This is the cold start closed at the place it actually bites: the user is
   * looking at their own shot list, the app already knows who is in it, and
   * the alternative was to go and invent three prompts in another tab and come
   * back. The entry and its reference are ordinary rows and an ordinary
   * gallery image - the Bible tab is the same objects, in detail.
   */
  const castOne = useCallback(
    async (member: CastMember) => {
      const { name, kind, traits } = member;
      setCastingName(name);
      setError(undefined);
      try {
        const id = await saveBibleEntry({ kind, name, traits });
        const entry: BibleEntry = {
          id,
          kind,
          name,
          traits,
          note: "",
          refs: [],
          createdAt: "",
          updatedAt: "",
        };
        await generateReference(entry, kind === "location" ? "wide" : "portrait", catalog);
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
    // Sequentially: each one costs, and a failure half way through should
    // leave the ones that worked rather than an unclear partial state.
    for (const person of casting.unknown) {
      await castOne(person);
    }
  }, [casting.unknown, castOne]);

  const breakDown = useCallback(async () => {
    if (!note || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setRow(await buildShotList(note.id));
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : "That could not be read.");
    } finally {
      setBusy(false);
    }
  }, [note, busy]);

  const running = row?.status === "running" || row?.status === "pending";

  return (
    <>
      {picking ? (
        <NotePicker
          onClose={() => {
            setPicking(false);
            if (!note) onClose();
          }}
          onPick={(picked) => {
            setNote(picked);
            setPicking(false);
          }}
        />
      ) : null}
      {note ? (
        <Dialog
          open
          onClose={onClose}
          title="From a script"
          description="Break a note into shots, then hand the film to the canvas."
          width={720}
        >
          <div className="dialog-body">
            <p className="studio-picker-section-title">{note.title || "Untitled note"}</p>

            {row?.status === "failed" ? (
              <p className="studio-error">{row.lastError || "That reading failed."}</p>
            ) : null}
            {error ? <p className="studio-error">{error}</p> : null}
            {plan && !plan.breakable ? <p className="studio-queue-hint">{plan.reason}</p> : null}

            {shots.length === 0 ? (
              <div className="studio-card-actions">
                <button
                  type="button"
                  className="studio-primary-button"
                  disabled={busy || running || !plan?.breakable}
                  onClick={() => void breakDown()}
                >
                  {running ? "Reading it..." : "Break it into shots"}
                </button>
                {running ? <Spinner aria-label="Reading the script" /> : null}
                {plan?.breakable ? (
                  <span className="studio-queue-hint">
                    {plan.modelCalls} pass{plan.modelCalls === 1 ? "" : "es"} over{" "}
                    {plan.scriptChars} characters.
                  </span>
                ) : null}
              </div>
            ) : (
              <>
                <p className="studio-queue-hint">
                  {shots.length} shot{shots.length === 1 ? "" : "s"}.{" "}
                  {shots.filter((shot) => shot.dialogue.trim()).length} spoken.
                </p>
                {casting.used.length > 0 ? (
                  <p className="studio-queue-hint">
                    From your bible: {casting.used.join(", ")}. Their references and their described
                    traits travel with every shot they are in.
                  </p>
                ) : null}
                {casting.unknown.length > 0 ? (
                  <div className="script-casting">
                    <p>
                      <strong>
                        {casting.unknown.length} name
                        {casting.unknown.length === 1 ? "" : "s"} in this script
                      </strong>{" "}
                      {casting.unknown.length === 1 ? "has" : "have"} no face yet, so{" "}
                      {casting.unknown.length === 1 ? "it is" : "they are"} rendered from scratch in
                      every shot and will not look the same twice.
                    </p>
                    <ul className="script-cast-list">
                      {casting.unknown.map((person) => (
                        <li key={person.name}>
                          <span>
                            {person.name}
                            <em> {person.traits || person.kind}</em>
                          </span>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={castingName !== undefined}
                            onClick={() => void castOne(person)}
                          >
                            {castingName === person.name
                              ? "Drawing..."
                              : person.kind === "location"
                                ? "Give it a look"
                                : "Give them a face"}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {casting.unknown.length > 1 ? (
                      <button
                        type="button"
                        className="studio-primary-button"
                        disabled={castingName !== undefined}
                        onClick={() => void castEveryone()}
                      >
                        Cast all {casting.unknown.length}
                        {referenceCost === undefined
                          ? ""
                          : ` (${(referenceCost * casting.unknown.length).toFixed(0)} cr)`}
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
                      <span className="script-shot-motion">
                        {shot.motion}
                        {shot.continues ? " · continues" : ""}
                      </span>
                    </li>
                  ))}
                </ol>

                <StudioField
                  label="Shoot on"
                  hint="One family for the whole film, so the look holds across the cut"
                >
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
                <StudioField label="Spend ceiling" hint="Nothing compiles over this. Credits.">
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
                <StudioField label="Score" hint="Lay a generated track under the film">
                  <Switch checked={withScore} onCheckedChange={setWithScore} />
                </StudioField>
                <StudioField label="Stop before the cut" hint="Look the shots over first">
                  <Switch checked={gateBeforeAssemble} onCheckedChange={setGateBeforeAssemble} />
                </StudioField>

                {compiled?.refusal ? (
                  <p className="studio-error">{compiled.refusal}</p>
                ) : (
                  <p className="studio-queue-hint">
                    About {compiled?.estimateCredits.toFixed(2)} credits, at least. Metered renders
                    are not in that figure.
                  </p>
                )}
                {compiled?.notes.map((note_) => (
                  <p key={note_} className="studio-queue-hint">
                    {note_}
                  </p>
                ))}

                <div className="studio-card-actions">
                  <button
                    type="button"
                    className="studio-primary-button"
                    disabled={!compiled?.workflow}
                    onClick={() => {
                      const workflow = compiled?.workflow;
                      if (!workflow) return;
                      // A graph this refuses to validate is a bug here, not a
                      // run to attempt.
                      const validation = validateWorkflow(workflow);
                      if (!validation.ok) {
                        setError(
                          `That did not compile cleanly: ${validation.errors[0]?.message ?? "unknown"}`,
                        );
                        return;
                      }
                      onCompiled(workflow);
                      onClose();
                    }}
                  >
                    Put it on the canvas
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={async () => {
                      await forgetShotList(note.id);
                      setRow(null);
                    }}
                  >
                    Read it again
                  </button>
                </div>
              </>
            )}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
