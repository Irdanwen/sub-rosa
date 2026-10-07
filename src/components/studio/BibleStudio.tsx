// The bible: the persistent identities of a production - characters,
// locations, props, and the look.
//
// The Studio could always attach reference images to a single render, and
// nothing made them survive it, so the same character was re-uploaded by hand
// every session and drifted a little each time. This is where a character is
// named once. Everything downstream then gets it for free: every reference
// slot in the Studio offers the bible through the shared gallery picker
// (ADR-0020), and the prompt builder restates a character's invariant traits
// on every shot, which is what keeps a face the same face across clips that
// were generated separately.
//
// A reference is a pointer at a gallery artifact, never a copy of it. The
// gallery is reconciled against the disk, so a pointer can legitimately end up
// aiming at nothing - which is reported here, and nowhere else, because this
// is the only surface where the user can do something about it.

import { t } from "../../lib/i18n";
import { IconCirclePerson } from "central-icons/IconCirclePerson";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  artifactSrc,
  listArtifacts,
  registerDownloadedArtifact,
  saveArtifactFromBase64,
} from "../../lib/studio/artifacts";
import { useMediaJobQueue } from "../../lib/studio/async-job";
import {
  addBibleRef,
  BIBLE_KIND_LABELS,
  BIBLE_KINDS,
  BIBLE_ROLE_LABELS,
  type BibleEntry,
  type BibleKind,
  type BibleRole,
  deleteBibleEntry,
  listBibleEntries,
  missingRefs,
  removeBibleRef,
  reorderBibleRefs,
  resolveRef,
  ROLES_BY_KIND,
  saveBibleEntry,
} from "../../lib/studio/bible";
import { estimateCostCredits, modelsOfType, speechModels } from "../../lib/studio/catalog";
import { canGenerate, generateReference, pickPortraitModel } from "../../lib/studio/bible/portrait";
import { STUDIO_IMAGE_RECOVERED_EVENT } from "../../lib/studio/image-job-recovery";
import {
  defaultSpeechModel,
  generateSpeech,
  queuedSpeechJob,
  speechCapabilities,
} from "../../lib/studio/speech";
import type { MediaCatalog, StudioArtifact } from "../../lib/studio/types";
import { EmptyState } from "../ui/EmptyState";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { GalleryPicker } from "./GalleryPicker";
import { GenerationLayout } from "./GenerationLayout";
import { PillGroup, StudioField } from "./controls";
import { MediaModelPicker, mediaModelOption } from "./MediaModelPicker";

/**
 * What an audition says.
 *
 * Deliberately a line with some shape to it rather than "hello": a voice is
 * chosen on how it handles a beat, and every voice sounds fine saying one word.
 */
const AUDITION_LINE = "I told you not to come back here. Not tonight.";

/** How many voices to try at once. Enough to compare, few enough to listen to. */
const AUDITION_COUNT = 4;

interface Draft {
  id?: string;
  kind: BibleKind;
  name: string;
  traits: string;
  note: string;
}

const EMPTY_DRAFT: Draft = { kind: "character", name: "", traits: "", note: "" };

export function BibleStudio({
  catalog,
  onMakeAFilm,
}: {
  catalog: MediaCatalog;
  /**
   * Take the user to where a film actually gets made.
   *
   * A bible is not a thing you make for its own sake, and nothing on this tab
   * said what it was for or where to go next - so somebody who had just named
   * a cast was left staring at a list.
   */
  onMakeAFilm?: () => void;
}) {
  const [entries, setEntries] = useState<BibleEntry[]>([]);
  const [artifacts, setArtifacts] = useState<StudioArtifact[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [attaching, setAttaching] = useState<{ entryId: string; role: BibleRole } | undefined>(
    undefined,
  );
  const [auditioning, setAuditioning] = useState<string | undefined>(undefined);
  const [drawing, setDrawing] = useState<string | undefined>(undefined);
  const [referenceModelId, setReferenceModelId] = useState("");
  const [auditions, setAuditions] = useState<Array<{ voice: string; artifact: StudioArtifact }>>(
    [],
  );
  const abortRef = useRef<AbortController | undefined>(undefined);

  const reload = useCallback(async () => {
    const [loadedEntries, loadedArtifacts] = await Promise.all([
      listBibleEntries().catch(() => [] as BibleEntry[]),
      listArtifacts().catch(() => [] as StudioArtifact[]),
    ]);
    setEntries(loadedEntries);
    setArtifacts(loadedArtifacts);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    const onRecovered = () => void reload();
    window.addEventListener(STUDIO_IMAGE_RECOVERED_EVENT, onRecovered);
    return () => window.removeEventListener(STUDIO_IMAGE_RECOVERED_EVENT, onRecovered);
  }, [reload]);
  useEffect(() => () => abortRef.current?.abort(), []);

  // Which engine auditions. A voice is a pair - an engine and one of its
  // voices - and a kept one speaks on the engine it was heard on (ADR-0076).
  // Opens on a one-call engine, so an audition plays in seconds.
  const [voiceModelId, setVoiceModelId] = useState("");
  const voiceEngines = useMemo(() => speechModels(catalog), [catalog]);
  const ttsModel =
    voiceEngines.find((model) => model.id === voiceModelId) ?? defaultSpeechModel(voiceEngines);
  const engineName = useCallback(
    (modelId: string | undefined) =>
      voiceEngines.find((model) => model.id === modelId)?.name ?? modelId ?? "",
    [voiceEngines],
  );
  /** Queued auditions in flight, by the prompt their job carries, so a take
   * that lands is filed under its character and voice. Not persisted: after a
   * restart a take still lands in the gallery, where it can be attached. */
  const queuedAuditions = useRef(new Map<string, { entryId: string; voice: string }>());
  const auditionQueue = useMediaJobQueue("speech", (file, finished) => {
    const artifact = registerDownloadedArtifact(file, {
      kind: "speech",
      model: finished.model,
      prompt: finished.prompt,
    });
    const take = queuedAuditions.current.get(finished.prompt);
    if (!take) return;
    queuedAuditions.current.delete(finished.prompt);
    setAuditions((current) => [...current, { voice: take.voice, artifact }]);
    void reload();
  });
  const [queuedFor, setQueuedFor] = useState<string | undefined>(undefined);
  // Only this surface's auditions count: the queue also carries narrations
  // started from the speech tab.
  const ourTakes = auditionQueue.jobs.filter((entry) =>
    queuedAuditions.current.has(entry.job.prompt),
  );
  const queueBusy = ourTakes.some(
    (entry) => entry.phase === "queued" || entry.phase === "processing",
  );
  const queueFailure = ourTakes.find((entry) => entry.phase === "failed");
  const auditioningNow = auditioning ?? (queueBusy ? queuedFor : undefined);
  // Said on the button rather than after the fact: drawing spends.
  const referenceModel =
    modelsOfType(catalog, "image").find((model) => model.id === referenceModelId) ??
    pickPortraitModel(catalog);
  const referenceCost = referenceModel
    ? estimateCostCredits(referenceModel, { multiplier: catalog.priceMultiplier })
    : undefined;

  const save = useCallback(async () => {
    if (!draft.name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await saveBibleEntry(draft);
      setDraft(EMPTY_DRAFT);
      await reload();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "That could not be saved.");
    } finally {
      setBusy(false);
    }
  }, [draft, busy, reload]);

  const attach = useCallback(
    async (artifact: StudioArtifact) => {
      if (!attaching) return;
      try {
        await addBibleRef({
          entryId: attaching.entryId,
          artifactId: artifact.id,
          role: attaching.role,
          label: artifact.prompt?.slice(0, 80),
        });
        await reload();
      } catch (attachError) {
        setError(
          attachError instanceof Error ? attachError.message : "That could not be attached.",
        );
      } finally {
        setAttaching(undefined);
      }
    },
    [attaching, reload],
  );

  /**
   * Draw a reference rather than sending the user to find one.
   *
   * This is the cold start closed: a character's face used to have to exist
   * before the character did, and nothing said so, so the honest first step of
   * making a film was three prompts in another tab.
   */
  const draw = useCallback(
    async (entry: BibleEntry, role: BibleRole, replacing?: string) => {
      if (!catalog) return;
      setDrawing(`${entry.id}:${role}`);
      setError(undefined);
      setNotice(undefined);
      try {
        await generateReference(entry, role, catalog, { modelId: referenceModel?.id });
        // Replacing, not stacking: "I do not like this one" is a different
        // gesture from "here is another angle", and drawing twice used to be
        // read as the second. The old one goes only once the new one exists.
        if (replacing) await removeBibleRef(replacing);
        await reload();
      } catch (drawError) {
        setError(drawError instanceof Error ? drawError.message : "That could not be drawn.");
      } finally {
        setDrawing(undefined);
      }
    },
    [catalog, reload, referenceModel?.id],
  );

  const move = useCallback(
    async (entry: BibleEntry, refId: string, delta: -1 | 1) => {
      const ids = entry.refs.map((reference) => reference.id);
      const index = ids.indexOf(refId);
      const target = index + delta;
      if (index === -1 || target < 0 || target >= ids.length) return;
      const next = [...ids];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      await reorderBibleRefs(entry.id, next);
      await reload();
    },
    [reload],
  );

  /**
   * Audition a few voices on the same line, and keep the one that fits.
   *
   * Generated and left in the gallery rather than played and thrown away: the
   * one that is kept becomes the character's voice donor, and the others are
   * ordinary speech artifacts the user can delete. Nothing is a special case.
   */
  const audition = useCallback(
    async (entry: BibleEntry) => {
      const caps = speechCapabilities(ttsModel);
      const voices = caps.voices.filter((voice) => voice !== "Describe in prompt");
      if (!ttsModel || voices.length === 0) {
        setError(t("No voices are available on this account."));
        return;
      }
      if (caps.rail === "queue") {
        // Durable renders: each voice is its own job, and the takes arrive as
        // they finish, even if the window closes in between.
        setQueuedFor(entry.id);
        setAuditions([]);
        setError(undefined);
        for (const voice of voices.slice(0, AUDITION_COUNT)) {
          const prompt = `${entry.name} audition, ${voice}`;
          queuedAuditions.current.set(prompt, { entryId: entry.id, voice });
          const job = queuedSpeechJob(catalog, caps, {
            model: ttsModel,
            text: AUDITION_LINE,
            voice,
          });
          await auditionQueue.start({ ...job, prompt });
        }
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setAuditioning(entry.id);
      setAuditions([]);
      setError(undefined);
      try {
        const picked = voices.slice(0, AUDITION_COUNT);
        const results: Array<{ voice: string; artifact: StudioArtifact }> = [];
        for (const voice of picked) {
          const { base64 } = await generateSpeech({
            model: ttsModel.id,
            input: AUDITION_LINE,
            voice,
            signal: controller.signal,
          });
          const artifact = await saveArtifactFromBase64(base64, "mp3", {
            kind: "speech",
            model: ttsModel.id,
            prompt: `${entry.name} audition, ${voice}`,
          });
          results.push({ voice, artifact });
          setAuditions([...results]);
        }
        await reload();
      } catch (auditionError) {
        if (!(auditionError instanceof DOMException && auditionError.name === "AbortError")) {
          setError(
            auditionError instanceof Error ? auditionError.message : t("The audition failed."),
          );
        }
      } finally {
        setAuditioning(undefined);
      }
    },
    [ttsModel, reload, catalog, auditionQueue],
  );

  const keepVoice = useCallback(
    async (entryId: string, artifact: StudioArtifact, voice: string) => {
      await addBibleRef({ entryId, artifactId: artifact.id, role: "voice", label: voice });
      setAuditions([]);
      setNotice(t("Kept {voice}.", { voice }));
      await reload();
    },
    [reload],
  );

  const controls = (
    <>
      <StudioField label={t("Reference image model")}>
        <MediaModelPicker
          value={referenceModel?.id ?? ""}
          options={modelsOfType(catalog, "image").map(mediaModelOption)}
          onChange={setReferenceModelId}
          ariaLabel={t("Reference image model")}
        />
      </StudioField>
      <StudioField label={t("Voice engine")} hint={t("Where characters' voices are auditioned")}>
        <MediaModelPicker
          value={ttsModel?.id ?? ""}
          options={voiceEngines.map(mediaModelOption)}
          onChange={setVoiceModelId}
          ariaLabel={t("Voice engine")}
        />
      </StudioField>
      <StudioField label={t("Kind")}>
        <PillGroup
          ariaLabel={t("Kind")}
          value={draft.kind}
          onChange={(value) => setDraft((current) => ({ ...current, kind: value as BibleKind }))}
          options={BIBLE_KINDS.map((kind) => ({ value: kind, label: BIBLE_KIND_LABELS[kind] }))}
        />
      </StudioField>
      <StudioField label={t("Name")}>
        <input
          className="studio-input"
          type="text"
          value={draft.name}
          aria-label={t("Name")}
          placeholder={draft.kind === "location" ? t("The alley") : t("Nera")}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
      </StudioField>
      <StudioField
        label={t("Invariant traits")}
        hint={t("Restated on every shot. Keep it to what must not drift.")}
      >
        <textarea
          className="studio-input studio-textarea"
          rows={2}
          value={draft.traits}
          aria-label={t("Invariant traits")}
          placeholder={t("green coat, scar over the left brow, a head shorter than Kell")}
          onChange={(event) => setDraft((current) => ({ ...current, traits: event.target.value }))}
        />
      </StudioField>
      <StudioField label={t("Notes")} hint={t("For you. Never sent to a model.")}>
        <textarea
          className="studio-input studio-textarea"
          rows={2}
          value={draft.note}
          aria-label={t("Notes")}
          onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
        />
      </StudioField>
    </>
  );

  const action = (
    <button
      type="button"
      className="studio-primary-button"
      disabled={!draft.name.trim() || busy}
      onClick={() => void save()}
    >
      {draft.id ? t("Save changes") : t("Add to the bible")}
    </button>
  );

  return (
    <GenerationLayout controls={controls} action={action}>
      {error ? <p className="studio-error">{error}</p> : null}
      {notice ? <p className="studio-queue-hint">{notice}</p> : null}
      {attaching ? (
        <GalleryPicker
          offerBible={false}
          title={t("Pick a {role}", { role: BIBLE_ROLE_LABELS[attaching.role].toLowerCase() })}
          description={t("Anything already in your gallery can stand in for this.")}
          kinds={attaching.role === "voice" ? ["speech", "music"] : ["image"]}
          resolveData={false}
          onClose={() => setAttaching(undefined)}
          onPick={(_data, artifact) => void attach(artifact)}
        />
      ) : null}
      {entries.length === 0 ? (
        <EmptyState
          icon={<IconCirclePerson size={22} />}
          title={t("Nothing in the bible yet")}
          description={t(
            "Name a character or a location once and attach a few references. Then write your film as a note, and the Studio turns it into shots that hold on to the faces you named.",
          )}
        />
      ) : (
        <>
          {/* The next step, said on the tab where the question is asked. A
              bible is not a thing you make for its own sake, and the button
              that uses it lives three tabs away. */}
          <div className="bible-next">
            <p>
              <strong>{t("Now write the film as a note.")}</strong>{" "}
              {t(
                "Call your characters and places exactly what you called them here - the names are how they get recognised - then bring the note back and it becomes shots.",
              )}
            </p>
            {onMakeAFilm ? (
              <button type="button" className="studio-primary-button" onClick={onMakeAFilm}>
                {t("Make a film from a note")}
              </button>
            ) : null}
          </div>
          <ul className="bible-list">
            {entries.map((entry) => {
              const missing = missingRefs(entry, artifacts);
              return (
                <li key={entry.id} className="bible-entry">
                  <div className="bible-entry-head">
                    <div>
                      <h3 className="bible-entry-name">{entry.name}</h3>
                      <p className="bible-entry-kind">{BIBLE_KIND_LABELS[entry.kind]}</p>
                      {entry.traits ? <p className="bible-entry-traits">{entry.traits}</p> : null}
                    </div>
                    <div className="studio-card-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() =>
                          setDraft({
                            id: entry.id,
                            kind: entry.kind,
                            name: entry.name,
                            traits: entry.traits,
                            note: entry.note,
                          })
                        }
                      >
                        {t("Edit")}
                      </button>
                      {entry.kind === "character" ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={auditioningNow !== undefined}
                          onClick={() => void audition(entry)}
                        >
                          {auditioningNow === entry.id ? t("Auditioning...") : t("Audition voices")}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={async () => {
                          await deleteBibleEntry(entry.id);
                          await reload();
                        }}
                      >
                        {t("Delete")}
                      </button>
                    </div>
                  </div>

                  {auditioningNow === entry.id ||
                  (auditions.length > 0 && draft.id !== entry.id) ? (
                    <div className="bible-auditions">
                      {auditioningNow === entry.id ? (
                        <Spinner aria-label={t("Auditioning")} />
                      ) : null}
                      {queueFailure && queuedFor === entry.id ? (
                        <p className="studio-error">
                          {queueFailure.message ?? t("The audition failed.")}
                        </p>
                      ) : null}
                      {auditions.map((take) => (
                        <div key={take.artifact.id} className="bible-audition">
                          <span>
                            {t("{voice} on {engine}", {
                              voice: take.voice,
                              engine: engineName(take.artifact.model),
                            })}
                          </span>
                          {/* biome-ignore lint/a11y/useMediaCaption: a voice take has no track */}
                          <audio controls src={artifactSrc(take.artifact)} />
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => void keepVoice(entry.id, take.artifact, take.voice)}
                          >
                            {t("Keep this voice")}
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <div className="bible-refs">
                    {entry.refs.map((reference, index) => {
                      const artifact = resolveRef(reference, artifacts);
                      return (
                        <div key={reference.id} className="bible-ref" data-missing={!artifact}>
                          {artifact && artifact.kind === "image" ? (
                            <img src={artifactSrc(artifact)} alt={reference.label || entry.name} />
                          ) : (
                            <span className="bible-ref-file">
                              {artifact ? artifact.fileName : t("missing")}
                            </span>
                          )}
                          <span className="bible-ref-role">
                            {reference.role === "voice" && artifact
                              ? t("{role}: {voice} on {engine}", {
                                  role: BIBLE_ROLE_LABELS[reference.role],
                                  voice: reference.label,
                                  engine: engineName(artifact.model),
                                })
                              : BIBLE_ROLE_LABELS[reference.role]}
                          </span>
                          <span className="studio-card-actions">
                            <button
                              type="button"
                              className="studio-icon-button"
                              aria-label={t("Move {name} reference {index} earlier", {
                                name: entry.name,
                                index: index + 1,
                              })}
                              disabled={index === 0}
                              onClick={() => void move(entry, reference.id, -1)}
                            >
                              <span aria-hidden>↑</span>
                            </button>
                            {canGenerate(reference.role) ? (
                              <button
                                type="button"
                                className="studio-icon-button"
                                aria-label={t("Redraw {name} reference {index}", {
                                  name: entry.name,
                                  index: index + 1,
                                })}
                                disabled={drawing !== undefined}
                                onClick={() => void draw(entry, reference.role, reference.id)}
                              >
                                <span aria-hidden>↻</span>
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="studio-icon-button"
                              aria-label={t("Remove {name} reference {index}", {
                                name: entry.name,
                                index: index + 1,
                              })}
                              onClick={async () => {
                                await removeBibleRef(reference.id);
                                await reload();
                              }}
                            >
                              <span aria-hidden>x</span>
                            </button>
                          </span>
                        </div>
                      );
                    })}
                    <div className="bible-ref-actions">
                      <Select
                        value={null}
                        placeholder={
                          drawing?.startsWith(`${entry.id}:`)
                            ? t("Drawing...")
                            : referenceCost === undefined
                              ? t("Draw a reference")
                              : t("Draw a reference ({credits} cr)", { credits: referenceCost })
                        }
                        ariaLabel={t("Draw a reference for {name}", { name: entry.name })}
                        onChange={(role) => void draw(entry, role as BibleRole)}
                        options={ROLES_BY_KIND[entry.kind]
                          .filter(canGenerate)
                          .map((role) => ({ value: role, label: BIBLE_ROLE_LABELS[role] }))}
                      />
                      <Select
                        value={null}
                        placeholder={t("Use one I have")}
                        ariaLabel={t("Attach a reference to {name}", { name: entry.name })}
                        onChange={(role) =>
                          setAttaching({ entryId: entry.id, role: role as BibleRole })
                        }
                        options={ROLES_BY_KIND[entry.kind].map((role) => ({
                          value: role,
                          label: BIBLE_ROLE_LABELS[role],
                        }))}
                      />
                    </div>
                  </div>

                  {missing.length > 0 ? (
                    <p className="studio-queue-hint">
                      {missing.length === 1
                        ? t(
                            "1 reference points at a file that is no longer in your gallery. Attach it again, or remove it.",
                          )
                        : t(
                            "{count} references point at files that are no longer in your gallery. Attach them again, or remove them.",
                            { count: missing.length },
                          )}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </GenerationLayout>
  );
}
