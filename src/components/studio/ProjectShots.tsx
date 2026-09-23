import { useState } from "react";
import { t } from "../../lib/i18n";
import { artifactSrc } from "../../lib/studio/artifacts";
import { imageEditModels, requiresOpeningFrame, videoDirection } from "../../lib/studio/catalog";
import { maxVideoReferences } from "../../lib/studio/seedance";
import { effectiveVideoConstraints } from "../../lib/studio/model-constraints";
import {
  newShot,
  shotSignature,
  type ProjectDocument,
  type ProjectShot,
} from "../../lib/studio/projects";
import type { MediaCatalog, StudioArtifact } from "../../lib/studio/types";
import { GalleryPicker } from "./GalleryPicker";
import { MediaModelPicker, mediaModelOption } from "./MediaModelPicker";

export function ProjectShots({
  document,
  onChange,
  artifacts,
  catalog,
  onGenerate,
  onImage,
  onBible,
  busy,
}: {
  document: ProjectDocument;
  onChange: (shots: ProjectShot[]) => void;
  artifacts: StudioArtifact[];
  catalog: MediaCatalog;
  onGenerate: (id: string) => void;
  onImage: (id: string) => void;
  onBible: () => void;
  busy: boolean;
}) {
  const [selected, setSelected] = useState(document.shots[0]?.id);
  const [picker, setPicker] = useState<
    "opening" | "ending" | "reference" | "imageReference" | null
  >(null);
  const [referenceError, setReferenceError] = useState("");
  const [removed, setRemoved] = useState<{ shot: ProjectShot; index: number }>();
  const shot = document.shots.find((item) => item.id === selected) ?? document.shots[0];
  const index = document.shots.findIndex((item) => item.id === shot?.id);
  const update = (patch: Partial<ProjectShot>) => {
    if (shot)
      onChange(document.shots.map((item) => (item.id === shot.id ? { ...item, ...patch } : item)));
  };
  const add = (duplicate = false) => {
    const next =
      duplicate && shot
        ? {
            ...structuredClone(shot),
            id: crypto.randomUUID(),
            takeIds: [],
            activeTakeId: undefined,
            renderedSignature: undefined,
          }
        : newShot(document.shots.length);
    const shots = [...document.shots];
    shots.splice(index + 1, 0, next);
    onChange(shots);
    setSelected(next.id);
  };
  const move = (offset: number) => {
    const shots = [...document.shots];
    [shots[index], shots[index + offset]] = [shots[index + offset], shots[index]];
    onChange(shots);
  };
  const mode = shot?.mode ?? "text";
  const models = catalog.models.filter(
    (model) =>
      !model.offline &&
      ["video", "imageToVideo", "referenceToVideo"].includes(model.mediaType) &&
      videoDirection(model) === (mode === "continuation" ? "image" : mode),
  );
  const model = models.find(
    (item) => item.id === (shot?.modelId || document.settings.videoModelId),
  );
  const constraints = model ? effectiveVideoConstraints(model) : undefined;
  const referenceLimit = maxVideoReferences(model);
  const addReference = (field: "imageReferenceIds" | "referenceArtifactIds", id: string) => {
    if (!shot) return;
    const references = shot[field] ?? [];
    if (references.includes(id)) return;
    const limit = field === "imageReferenceIds" ? 3 : referenceLimit;
    if (references.length >= limit) {
      setReferenceError(t("Choose at most {count} reference images.", { count: limit }));
      return;
    }
    setReferenceError("");
    update({ [field]: [...references, id] });
  };
  const preview = artifacts.find(
    (item) => item.id === (shot?.activeTakeId || shot?.openingArtifactId),
  );
  const imagePreview = (id: string, onRemove: () => void) => {
    const artifact = artifacts.find((item) => item.id === id);
    return (
      <div className="project-reference" key={id}>
        {artifact ? (
          <img src={artifactSrc(artifact)} alt={artifact.prompt || artifact.fileName} />
        ) : (
          <span>{t("Missing file")}</span>
        )}
        <button type="button" onClick={onRemove}>
          {t("Remove")}
        </button>
      </div>
    );
  };
  const openingComposer = shot ? (
    <details open>
      <summary>{t("Create from reference images")}</summary>
      <div className="project-reference-grid">
        {shot.imageReferenceIds.map((id) =>
          imagePreview(id, () =>
            update({ imageReferenceIds: shot.imageReferenceIds.filter((item) => item !== id) }),
          ),
        )}
      </div>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={shot.imageReferenceIds.length >= 3}
        onClick={() => setPicker("imageReference")}
      >
        {mode === "reference" ? t("Add image for opening composition") : t("Add reference image")}
      </button>
      <MediaModelPicker
        options={imageEditModels(catalog).map(mediaModelOption)}
        value={shot.imageModelId}
        onChange={(imageModelId) => update({ imageModelId })}
        ariaLabel={t("Image composition model")}
      />
      <label className="project-field">
        {t("Image prompt")}
        <textarea
          aria-label={t("Image prompt")}
          rows={4}
          value={shot.imagePrompt}
          onChange={(event) => update({ imagePrompt: event.target.value })}
        />
      </label>
      <button
        type="button"
        className="btn btn-primary"
        disabled={!shot.imageReferenceIds.length || shot.imageReferenceIds.length > 3}
        onClick={() => onImage(shot.id)}
      >
        {t("Quote opening image")}
      </button>
      <div className="project-reference-grid">
        {shot.imageCandidates.map((id) => {
          const candidate = artifacts.find((item) => item.id === id);
          return candidate ? (
            <button
              type="button"
              className="project-reference"
              key={id}
              aria-pressed={shot.openingArtifactId === id}
              onClick={() => update({ openingArtifactId: id })}
            >
              <img src={artifactSrc(candidate)} alt={t("Opening image candidate")} />
              <span>{shot.openingArtifactId === id ? t("Selected") : t("Use this image")}</span>
            </button>
          ) : null;
        })}
      </div>
    </details>
  ) : null;
  return (
    <div className="project-shots">
      <aside className="project-shot-list project-panel">
        <div className="project-actions">
          <h2>{t("Shots")}</h2>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => add()}>
            {t("Add shot")}
          </button>
        </div>
        {document.shots.map((item, number) => {
          const thumbnail = artifacts.find((artifact) => artifact.id === item.openingArtifactId);
          return (
            <button
              key={item.id}
              type="button"
              className="project-shot-row"
              aria-pressed={shot?.id === item.id}
              onClick={() => {
                setSelected(item.id);
                setReferenceError("");
              }}
            >
              <span className="project-shot-number">{number + 1}</span>
              {thumbnail ? (
                <img src={artifactSrc(thumbnail)} alt="" />
              ) : (
                <span className="project-shot-placeholder" />
              )}
              <span>
                <strong>{item.title}</strong>
                <small>
                  {item.duration || t("Default duration")} ·{" "}
                  {item.takeIds.length
                    ? t("{count} takes", { count: item.takeIds.length })
                    : t("Not generated")}
                </small>
              </span>
            </button>
          );
        })}
        {removed ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => {
              const shots = [...document.shots];
              shots.splice(removed.index, 0, removed.shot);
              onChange(shots);
              setRemoved(undefined);
            }}
          >
            {t("Undo removal")}
          </button>
        ) : null}
      </aside>
      {shot ? (
        <>
          <section className="project-shot-center">
            <div className="project-actions">
              <h2>{shot.title}</h2>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => add(true)}
              >
                {t("Duplicate")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy || index === 0}
                onClick={() => move(-1)}
              >
                {t("Move up")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy || index === document.shots.length - 1}
                onClick={() => move(1)}
              >
                {t("Move down")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => {
                  setRemoved({ shot, index });
                  onChange(document.shots.filter((item) => item.id !== shot.id));
                }}
              >
                {t("Remove")}
              </button>
            </div>
            <div className="project-monitor">
              {preview?.kind === "video" ? (
                // biome-ignore lint/a11y/useMediaCaption: generated takes have no caption track
                <video key={preview.id} controls preload="metadata" src={artifactSrc(preview)} />
              ) : preview ? (
                <img src={artifactSrc(preview)} alt={shot.title} />
              ) : (
                <div className="project-empty">
                  <h3>{t("Your shot starts here")}</h3>
                  <p>
                    {t("Describe it, choose how to generate it, then compare your takes here.")}
                  </p>
                </div>
              )}
            </div>
            {shot.renderedSignature && shot.renderedSignature !== shotSignature(shot, document) ? (
              <p className="project-warning">
                {t("Settings changed. Your previous takes are preserved.")}
              </p>
            ) : null}
            <fieldset disabled={busy}>
              <label className="project-field">
                {t("Video prompt")}
                <textarea
                  aria-label={t("Video prompt")}
                  rows={5}
                  value={shot.prompt ?? shot.action}
                  onChange={(event) => update({ prompt: event.target.value })}
                  placeholder={t("Describe the action and camera movement")}
                />
              </label>
              <div className="project-two-columns">
                <label className="project-field">
                  {t("Action")}
                  <textarea
                    aria-label={t("Action")}
                    value={shot.action}
                    onChange={(event) => update({ action: event.target.value })}
                  />
                </label>
                <label className="project-field">
                  {t("Camera")}
                  <textarea
                    aria-label={t("Camera")}
                    value={shot.camera}
                    onChange={(event) => update({ camera: event.target.value })}
                  />
                </label>
              </div>
              <details>
                <summary>{t("Dialogue and speaker")}</summary>
                <label className="project-field">
                  {t("Speaker")}
                  <input
                    value={shot.speaker}
                    onChange={(event) => update({ speaker: event.target.value })}
                  />
                </label>
                <label className="project-field">
                  {t("Dialogue")}
                  <textarea
                    aria-label={t("Dialogue")}
                    value={shot.dialogue}
                    onChange={(event) => update({ dialogue: event.target.value })}
                  />
                </label>
              </details>
            </fieldset>
            <div className="project-actions">
              <h3>{t("Takes")}</h3>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => onGenerate(shot.id)}
              >
                {t("Quote a new take")}
              </button>
            </div>
            <div className="project-takes">
              {shot.takeIds.map((id, number) => {
                const take = artifacts.find((item) => item.id === id);
                return (
                  <button
                    key={id}
                    type="button"
                    disabled={busy || !take}
                    className="project-take"
                    aria-pressed={shot.activeTakeId === id}
                    onClick={() => update({ activeTakeId: id })}
                  >
                    {t("Take {number}", { number: number + 1 })}
                    <small>{take?.model ?? t("Missing file")}</small>
                    {shot.activeTakeId === id ? <span>{t("Selected")}</span> : null}
                  </button>
                );
              })}
            </div>
          </section>
          <aside className="project-inspector project-panel">
            {referenceError ? (
              <p role="alert" className="project-error">
                {referenceError}
              </p>
            ) : null}
            <fieldset disabled={busy}>
              <label className="project-field">
                {t("Shot title")}
                <input
                  value={shot.title}
                  onChange={(event) =>
                    update({ title: event.target.value, scene: event.target.value })
                  }
                />
              </label>
              <label className="project-field">
                {t("Generation mode")}
                <select
                  value={mode}
                  onChange={(event) => {
                    const next = event.target.value as ProjectShot["mode"];
                    update({ mode: next, continues: next === "continuation" });
                    setReferenceError("");
                  }}
                >
                  <option value="text">{t("Text to video")}</option>
                  <option value="image">{t("Image to video (ITV)")}</option>
                  <option value="reference">{t("References to video (RTV)")}</option>
                  <option value="continuation">{t("Continue the preceding shot")}</option>
                </select>
              </label>
              <MediaModelPicker
                value={shot.modelId || document.settings.videoModelId}
                options={models.map(mediaModelOption)}
                onChange={(modelId) => update({ modelId })}
                ariaLabel={t("Video model")}
                placeholder={t("Choose a compatible model")}
              />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => update({ modelId: undefined })}
              >
                {t("Use project model")}
              </button>
              <label className="project-field">
                {t("Generation duration")}
                <select
                  value={shot.duration ?? ""}
                  onChange={(event) => update({ duration: event.target.value || undefined })}
                >
                  <option value="">{t("Model default")}</option>
                  {shot.duration !== undefined &&
                  !constraints?.durations?.includes(String(shot.duration)) ? (
                    <option value={shot.duration}>{shot.duration}</option>
                  ) : null}
                  {constraints?.durations?.map((duration) => (
                    <option key={duration} value={duration}>
                      {duration}
                    </option>
                  ))}
                </select>
              </label>
              <label className="project-field">
                {t("Resolution")}
                <select
                  value={shot.resolution ?? ""}
                  onChange={(event) => update({ resolution: event.target.value || undefined })}
                >
                  <option value="">{t("Model default")}</option>
                  {shot.resolution && !constraints?.resolutions?.includes(shot.resolution) ? (
                    <option value={shot.resolution}>{shot.resolution}</option>
                  ) : null}
                  {constraints?.resolutions?.map((resolution) => (
                    <option key={resolution} value={resolution}>
                      {resolution}
                    </option>
                  ))}
                </select>
              </label>
              {mode === "image" ? (
                <>
                  <h3>{t("Opening image")}</h3>
                  {shot.openingArtifactId
                    ? imagePreview(shot.openingArtifactId, () =>
                        update({ openingArtifactId: undefined }),
                      )
                    : null}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setPicker("opening")}
                  >
                    {t("Choose opening image")}
                  </button>
                  {openingComposer}
                  <details>
                    <summary>{t("Ending image")}</summary>
                    {shot.endingArtifactId
                      ? imagePreview(shot.endingArtifactId, () =>
                          update({ endingArtifactId: undefined }),
                        )
                      : null}
                    <button type="button" onClick={() => setPicker("ending")}>
                      {t("Choose ending image")}
                    </button>
                  </details>
                </>
              ) : null}
              {mode === "reference" ? (
                <>
                  {requiresOpeningFrame(model?.id) ? (
                    <>
                      <h3>{t("Opening image")}</h3>
                      {shot.openingArtifactId
                        ? imagePreview(shot.openingArtifactId, () =>
                            update({ openingArtifactId: undefined }),
                          )
                        : null}
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setPicker("opening")}
                      >
                        {t("Choose opening image")}
                      </button>
                      {openingComposer}
                    </>
                  ) : null}
                  <h3>{t("Video references")}</h3>
                  <p className="project-muted">
                    {t("These guide identity and style. They are not an opening frame.")}
                  </p>
                  <div className="project-reference-grid">
                    {(shot.referenceArtifactIds ?? []).map((id) =>
                      imagePreview(id, () =>
                        update({
                          referenceArtifactIds: shot.referenceArtifactIds?.filter(
                            (item) => item !== id,
                          ),
                        }),
                      ),
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={(shot.referenceArtifactIds?.length ?? 0) >= referenceLimit}
                    onClick={() => setPicker("reference")}
                  >
                    {t("Add reference image")}
                  </button>
                </>
              ) : null}
              {mode !== "image" && shot.endingArtifactId ? (
                <div>
                  <p className="project-warning">
                    {t("An ending image requires image-to-video mode.")}
                  </p>
                  {imagePreview(shot.endingArtifactId, () =>
                    update({ endingArtifactId: undefined }),
                  )}
                </div>
              ) : null}
              {mode === "continuation" ? (
                <p className="project-muted">
                  {t(
                    "This shot starts from a handoff frame of the preceding shot. Reordering changes the predecessor.",
                  )}
                </p>
              ) : null}
              <h3>{t("Project bible")}</h3>
              {document.bible.map((entry) => (
                <div key={entry.id} className="project-bible-link">
                  <label>
                    <input
                      type="checkbox"
                      checked={
                        entry.kind === "location"
                          ? shot.location === entry.name
                          : shot.characters.includes(entry.name)
                      }
                      onChange={(event) =>
                        entry.kind === "location"
                          ? update({ location: event.target.checked ? entry.name : "" })
                          : update({
                              characters: event.target.checked
                                ? [...shot.characters, entry.name]
                                : shot.characters.filter((name) => name !== entry.name),
                            })
                      }
                    />
                    {entry.name}
                  </label>
                  {entry.refs
                    .filter((ref) => ref.role !== "voice")
                    .map((ref) => (
                      <button
                        key={ref.id}
                        type="button"
                        className="btn btn-ghost"
                        disabled={
                          (mode !== "image" && mode !== "reference") ||
                          !artifacts.some(
                            (artifact) =>
                              artifact.id === ref.artifactId && artifact.kind === "image",
                          ) ||
                          (mode === "image"
                            ? shot.imageReferenceIds.includes(ref.artifactId) ||
                              shot.imageReferenceIds.length >= 3
                            : (shot.referenceArtifactIds ?? []).includes(ref.artifactId) ||
                              (shot.referenceArtifactIds?.length ?? 0) >= referenceLimit)
                        }
                        onClick={() =>
                          addReference(
                            mode === "image" ? "imageReferenceIds" : "referenceArtifactIds",
                            ref.artifactId,
                          )
                        }
                      >
                        {t("Use reference")}
                      </button>
                    ))}
                </div>
              ))}
              <button type="button" className="btn btn-secondary" onClick={onBible}>
                {t("Edit project bible")}
              </button>
            </fieldset>
          </aside>
        </>
      ) : (
        <div className="project-empty">
          <h2>{t("Build your film one shot at a time")}</h2>
          <p>{t("Add a shot manually or break your script into shots.")}</p>
          <button type="button" className="btn btn-primary" onClick={() => add()}>
            {t("Add shot")}
          </button>
        </div>
      )}
      {picker && shot ? (
        <GalleryPicker
          resolveData={false}
          offerBible={false}
          onClose={() => setPicker(null)}
          onPick={(_, artifact) => {
            if (picker === "opening") update({ openingArtifactId: artifact.id });
            if (picker === "ending") update({ endingArtifactId: artifact.id });
            if (picker === "reference") addReference("referenceArtifactIds", artifact.id);
            if (picker === "imageReference") addReference("imageReferenceIds", artifact.id);
          }}
        />
      ) : null}
    </div>
  );
}
