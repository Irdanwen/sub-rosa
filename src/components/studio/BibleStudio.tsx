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

import { IconCirclePerson } from "central-icons/IconCirclePerson";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { artifactSrc, listArtifacts, saveArtifactFromBase64 } from "../../lib/studio/artifacts";
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
import { modelsOfType } from "../../lib/studio/catalog";
import { generateSpeech } from "../../lib/studio/speech";
import type { MediaCatalog, StudioArtifact } from "../../lib/studio/types";
import { EmptyState } from "../ui/EmptyState";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { GalleryPicker } from "./GalleryPicker";
import { GenerationLayout } from "./GenerationLayout";
import { PillGroup, StudioField } from "./controls";

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
  useEffect(() => () => abortRef.current?.abort(), []);

  const ttsModel = useMemo(() => modelsOfType(catalog, "tts")[0], [catalog]);

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
      const voices = ttsModel?.voices ?? [];
      if (!ttsModel || voices.length === 0) {
        setError("No voices are available on this account.");
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
          setError(auditionError instanceof Error ? auditionError.message : "The audition failed.");
        }
      } finally {
        setAuditioning(undefined);
      }
    },
    [ttsModel, reload],
  );

  const keepVoice = useCallback(
    async (entryId: string, artifact: StudioArtifact, voice: string) => {
      await addBibleRef({ entryId, artifactId: artifact.id, role: "voice", label: voice });
      setAuditions([]);
      setNotice(`Kept ${voice}.`);
      await reload();
    },
    [reload],
  );

  const controls = (
    <>
      <StudioField label="Kind">
        <PillGroup
          ariaLabel="Kind"
          value={draft.kind}
          onChange={(value) => setDraft((current) => ({ ...current, kind: value as BibleKind }))}
          options={BIBLE_KINDS.map((kind) => ({ value: kind, label: BIBLE_KIND_LABELS[kind] }))}
        />
      </StudioField>
      <StudioField label="Name">
        <input
          className="studio-input"
          type="text"
          value={draft.name}
          aria-label="Name"
          placeholder={draft.kind === "location" ? "The alley" : "Nera"}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
      </StudioField>
      <StudioField
        label="Invariant traits"
        hint="Restated on every shot. Keep it to what must not drift."
      >
        <textarea
          className="studio-input studio-textarea"
          rows={2}
          value={draft.traits}
          aria-label="Invariant traits"
          placeholder="green coat, scar over the left brow, a head shorter than Kell"
          onChange={(event) => setDraft((current) => ({ ...current, traits: event.target.value }))}
        />
      </StudioField>
      <StudioField label="Notes" hint="For you. Never sent to a model.">
        <textarea
          className="studio-input studio-textarea"
          rows={2}
          value={draft.note}
          aria-label="Notes"
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
      {draft.id ? "Save changes" : "Add to the bible"}
    </button>
  );

  return (
    <GenerationLayout controls={controls} action={action}>
      {error ? <p className="studio-error">{error}</p> : null}
      {notice ? <p className="studio-queue-hint">{notice}</p> : null}
      {attaching ? (
        <GalleryPicker
          offerBible={false}
          title={`Pick a ${BIBLE_ROLE_LABELS[attaching.role].toLowerCase()}`}
          description="Anything already in your gallery can stand in for this."
          kinds={attaching.role === "voice" ? ["speech", "music"] : ["image"]}
          resolveData={false}
          onClose={() => setAttaching(undefined)}
          onPick={(_data, artifact) => void attach(artifact)}
        />
      ) : null}
      {entries.length === 0 ? (
        <EmptyState
          icon={<IconCirclePerson size={22} />}
          title="Nothing in the bible yet"
          description="Name a character or a location once and attach a few references. Then write your film as a note, and the Studio turns it into shots that hold on to the faces you named."
        />
      ) : (
        <>
          {/* The next step, said on the tab where the question is asked. A
              bible is not a thing you make for its own sake, and the button
              that uses it lives three tabs away. */}
          <div className="bible-next">
            <p>
              <strong>Now write the film as a note.</strong> Call your characters and places exactly
              what you called them here - the names are how they get recognised - then bring the
              note back and it becomes shots.
            </p>
            {onMakeAFilm ? (
              <button type="button" className="studio-primary-button" onClick={onMakeAFilm}>
                Make a film from a note
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
                        Edit
                      </button>
                      {entry.kind === "character" ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={auditioning !== undefined}
                          onClick={() => void audition(entry)}
                        >
                          {auditioning === entry.id ? "Auditioning..." : "Audition voices"}
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
                        Delete
                      </button>
                    </div>
                  </div>

                  {auditioning === entry.id || (auditions.length > 0 && draft.id !== entry.id) ? (
                    <div className="bible-auditions">
                      {auditioning === entry.id ? <Spinner aria-label="Auditioning" /> : null}
                      {auditions.map((take) => (
                        <div key={take.artifact.id} className="bible-audition">
                          <span>{take.voice}</span>
                          {/* biome-ignore lint/a11y/useMediaCaption: a voice take has no track */}
                          <audio controls src={artifactSrc(take.artifact)} />
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => void keepVoice(entry.id, take.artifact, take.voice)}
                          >
                            Keep this voice
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
                              {artifact ? artifact.fileName : "missing"}
                            </span>
                          )}
                          <span className="bible-ref-role">
                            {BIBLE_ROLE_LABELS[reference.role]}
                          </span>
                          <span className="studio-card-actions">
                            <button
                              type="button"
                              className="studio-icon-button"
                              aria-label={`Move ${entry.name} reference ${index + 1} earlier`}
                              disabled={index === 0}
                              onClick={() => void move(entry, reference.id, -1)}
                            >
                              <span aria-hidden>↑</span>
                            </button>
                            <button
                              type="button"
                              className="studio-icon-button"
                              aria-label={`Remove ${entry.name} reference ${index + 1}`}
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
                    <Select
                      value={null}
                      placeholder="Attach a reference"
                      ariaLabel={`Attach a reference to ${entry.name}`}
                      onChange={(role) =>
                        setAttaching({ entryId: entry.id, role: role as BibleRole })
                      }
                      options={ROLES_BY_KIND[entry.kind].map((role) => ({
                        value: role,
                        label: BIBLE_ROLE_LABELS[role],
                      }))}
                    />
                  </div>

                  {missing.length > 0 ? (
                    <p className="studio-queue-hint">
                      {missing.length} reference{missing.length === 1 ? "" : "s"} point at files
                      that are no longer in your gallery. Attach them again, or remove them.
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
