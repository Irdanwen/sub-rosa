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
import { listBibleEntries, type BibleEntry } from "../../lib/studio/bible";
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

function parseShots(row: ShotListDto | null | undefined): Shot[] {
  if (!row?.shotsJson) return [];
  try {
    const parsed: unknown = JSON.parse(row.shotsJson);
    return Array.isArray(parsed) ? (parsed as Shot[]) : [];
  } catch {
    return [];
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

  const shots = useMemo(() => parseShots(row), [row]);

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
    const unknown = new Set<string>();
    for (const shot of shots) {
      for (const name of [...shot.characters, shot.location]) {
        const key = name.trim().toLowerCase();
        if (!key) continue;
        if (known.has(key)) used.add(known.get(key)?.name ?? key);
        else unknown.add(name.trim());
      }
    }
    return { used: [...used], unknown: [...unknown] };
  }, [shots, bible]);

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
                  <p className="studio-error">
                    Not in your bible: {casting.unknown.join(", ")}. Those are rendered from scratch
                    each time, so they will not look the same twice. Add them to the bible, or spell
                    them in the note the way the bible does, and read it again.
                  </p>
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
