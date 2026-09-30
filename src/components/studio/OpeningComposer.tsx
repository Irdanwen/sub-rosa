import { useState } from "react";
import { t } from "../../lib/i18n";
import { artifactSrc } from "../../lib/studio/artifacts";
import {
  BIBLE_ROLE_LABELS,
  type BibleKind,
  type BibleRef,
  type BibleRole,
} from "../../lib/studio/bible/types";
import { imageEditModels } from "../../lib/studio/catalog";
import { openingImageModel } from "../../lib/studio/project-production";
import type { ProjectBibleEntry, ProjectDocument, ProjectShot } from "../../lib/studio/projects";
import { rewriteTargetModel } from "../../lib/studio/studio-rewrite";
import type { MediaCatalog, StudioArtifact } from "../../lib/studio/types";
import { AiRewrite } from "./AiRewrite";
import { MediaModelPicker, mediaModelOption } from "./MediaModelPicker";

/** What the operator composes at most (`/image/multi-edit`). */
export const MAX_OPENING_INPUTS = 3;

/**
 * The reference an entry brings to a composition, best first. A character
 * brings its sheet when it has one: the whole character in one of three
 * inputs (ADR-0066).
 */
const COMPOSE_ROLES: Record<BibleKind, readonly BibleRole[]> = {
  character: ["sheet", "portrait", "profile"],
  location: ["wide", "medium", "detail"],
  prop: ["detail", "portrait"],
  look: ["wide", "medium", "detail"],
};

export function composeReference(
  entry: ProjectBibleEntry,
  artifacts: readonly StudioArtifact[],
): BibleRef | undefined {
  const usable = entry.refs.filter((ref) =>
    artifacts.some((artifact) => artifact.id === ref.artifactId && artifact.kind === "image"),
  );
  for (const role of COMPOSE_ROLES[entry.kind]) {
    const hit = usable
      .filter((ref) => ref.role === role)
      .sort((left, right) => left.ordinal - right.ordinal)[0];
    if (hit) return hit;
  }
  return undefined;
}

/** Who or what an input image is, for its label and for the AI prompt. */
function describeInput(artifactId: string, bible: readonly ProjectBibleEntry[]) {
  for (const entry of bible) {
    const ref = entry.refs.find((item) => item.artifactId === artifactId);
    if (ref) return { label: entry.name, kind: entry.kind as string, role: ref.role };
  }
  return { label: t("Gallery image"), kind: "image", role: undefined };
}

/**
 * Composing the opening frame of a shot from up to three images: a
 * character, a place, an object, and a prompt that says how they meet.
 *
 * Offered whatever the shot's mode. Picking a frame for a shot that cannot
 * start from one moves it to image to video, and says so.
 */
export function OpeningComposer({
  shot,
  document,
  artifacts,
  catalog,
  mode,
  opensFromFrame,
  writingModelId,
  busy,
  update,
  onPickGallery,
  onQuote,
}: {
  shot: ProjectShot;
  document: ProjectDocument;
  artifacts: StudioArtifact[];
  catalog: MediaCatalog;
  mode: ProjectShot["mode"];
  /** Whether the shot, as set, renders from an opening frame. */
  opensFromFrame: boolean;
  writingModelId?: string;
  busy: boolean;
  update: (patch: Partial<ProjectShot>) => void;
  onPickGallery: () => void;
  onQuote: () => void;
}) {
  const [open, setOpen] = useState(
    shot.imageReferenceIds.length > 0 || shot.imageCandidates.length > 0,
  );
  const [switched, setSwitched] = useState(false);
  const inputs = shot.imageReferenceIds;
  const full = inputs.length >= MAX_OPENING_INPUTS;
  const model = openingImageModel(shot, catalog);
  const fromBible = document.bible
    .map((entry) => ({ entry, ref: composeReference(entry, artifacts) }))
    .filter(
      (option): option is { entry: ProjectBibleEntry; ref: BibleRef } =>
        option.ref !== undefined && !inputs.includes(option.ref.artifactId),
    );
  const setInputs = (imageReferenceIds: string[]) => update({ imageReferenceIds });
  const choose = (id: string) => {
    const patch: Partial<ProjectShot> = { openingArtifactId: id };
    if (!opensFromFrame) {
      Object.assign(patch, { mode: "image", modelId: undefined, continues: false });
      setSwitched(true);
    }
    update(patch);
  };
  const slots = inputs.map((id) => describeInput(id, document.bible));

  return (
    <details
      className="project-composer"
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary>{t("Compose the opening image")}</summary>
      <p className="project-muted">
        {t(
          "Combine up to three images: a character, a place, an object. A character sheet counts as one and carries the whole character.",
        )}
      </p>
      <ol className="project-slots">
        {inputs.map((id, index) => {
          const artifact = artifacts.find((item) => item.id === id);
          const slot = slots[index];
          return (
            <li key={id} className="project-reference">
              {artifact ? (
                <img src={artifactSrc(artifact)} alt={slot.label} />
              ) : (
                <span>{t("Missing file")}</span>
              )}
              <strong>{t("Image {number}", { number: index + 1 })}</strong>
              <span>
                {slot.role && slot.role !== "voice"
                  ? t("{name}, {role}", { name: slot.label, role: BIBLE_ROLE_LABELS[slot.role] })
                  : slot.label}
              </span>
              <div className="project-actions">
                <button
                  type="button"
                  disabled={busy || index === 0}
                  onClick={() => {
                    const next = [...inputs];
                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                    setInputs(next);
                  }}
                >
                  {t("Move up")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setInputs(inputs.filter((item) => item !== id))}
                >
                  {t("Remove")}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="project-actions">
        <select
          aria-label={t("Add from the bible")}
          value=""
          disabled={busy || full || fromBible.length === 0}
          onChange={(event) => {
            const artifactId = event.target.value;
            if (artifactId && !full) setInputs([...inputs, artifactId]);
          }}
        >
          <option value="">
            {fromBible.length ? t("Add from the bible") : t("No bible image to add")}
          </option>
          {fromBible.map(({ entry, ref }) => (
            <option key={ref.id} value={ref.artifactId}>
              {t("{name}, {role}", { name: entry.name, role: BIBLE_ROLE_LABELS[ref.role] })}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || full}
          onClick={onPickGallery}
        >
          {t("Add from gallery")}
        </button>
      </div>
      <MediaModelPicker
        options={imageEditModels(catalog).map(mediaModelOption)}
        value={model?.id ?? ""}
        onChange={(imageModelId) => update({ imageModelId })}
        ariaLabel={t("Image composition model")}
      />
      <div className="project-field">
        <span className="project-field-heading">{t("Opening image prompt")}</span>
        <AiRewrite
          label={t("Opening image prompt")}
          value={shot.imagePrompt}
          disabled={busy}
          field={
            <textarea
              aria-label={t("Opening image prompt")}
              rows={4}
              value={shot.imagePrompt}
              placeholder={t("Say where each image goes and what is happening")}
              onChange={(event) => update({ imagePrompt: event.target.value })}
            />
          }
          onAccept={(imagePrompt) => update({ imagePrompt })}
          hint={t("Written in English, the language these image models follow best.")}
          request={() =>
            inputs.length
              ? {
                  kind: "composition",
                  text: shot.imagePrompt,
                  modelId: writingModelId,
                  context: {
                    targetModel: rewriteTargetModel(model),
                    title: shot.title,
                    action: shot.action,
                    camera: shot.camera,
                    aspectRatio: document.settings.aspectRatio,
                    slots: slots.map(({ label, kind, role }) => ({ label, kind, role })),
                    entries: document.bible
                      .filter((entry) => slots.some((slot) => slot.label === entry.name))
                      .map((entry) => ({
                        name: entry.name,
                        kind: entry.kind,
                        traits: entry.traits,
                      })),
                  },
                }
              : undefined
          }
        />
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || !inputs.length || inputs.length > MAX_OPENING_INPUTS}
        onClick={onQuote}
      >
        {t("Quote opening image")}
      </button>
      {switched ? (
        <p className="project-warning" role="status">
          {t("This shot now starts from this image, so it switched to image to video.")}
        </p>
      ) : null}
      <div className="project-reference-grid">
        {shot.imageCandidates.map((id) => {
          const candidate = artifacts.find((item) => item.id === id);
          return candidate ? (
            <button
              type="button"
              className="project-reference"
              key={id}
              disabled={busy}
              aria-pressed={shot.openingArtifactId === id}
              onClick={() => choose(id)}
            >
              <img src={artifactSrc(candidate)} alt={t("Opening image candidate")} />
              <span>
                {shot.openingArtifactId === id
                  ? t("Selected")
                  : opensFromFrame
                    ? t("Use this image")
                    : t("Start the shot from this image")}
              </span>
            </button>
          ) : null;
        })}
      </div>
      {mode === "reference" && !opensFromFrame ? (
        <p className="project-muted">
          {t(
            "This reference model does not start from an image. Choosing one moves the shot to image to video.",
          )}
        </p>
      ) : null}
    </details>
  );
}
