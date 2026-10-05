import { IconExpandSimple } from "central-icons/IconExpandSimple";
import { type CSSProperties, useState } from "react";
import { intlLocale, t } from "../../lib/i18n";
import { artifactSrc } from "../../lib/studio/artifacts";
import { acceptsOpeningFrameWithReferences, videoDirection } from "../../lib/studio/catalog";
import { maxVideoReferences } from "../../lib/studio/seedance";
import { effectiveVideoConstraints } from "../../lib/studio/model-constraints";
import { resolveShotDuration, shotReferences } from "../../lib/studio/workflow/compile";
import { composeProjectShot, shotVideoModel } from "../../lib/studio/project-production";
import { shotLints } from "../../lib/studio/prompt/lint";
import {
  newShot,
  shotSignature,
  type ProjectDocument,
  type ProjectShot,
} from "../../lib/studio/projects";
import {
  rewriteReferences,
  rewriteTargetModel,
  SHOT_REWRITE_VERSION,
} from "../../lib/studio/studio-rewrite";
import { formatElapsed } from "../../lib/studio/async-job";
import { darkroomSeed, darkroomVars } from "../../lib/studio/darkroom";
import type { LiveRender } from "../../lib/studio/project-activity";
import { estimateRenderMs } from "../../lib/studio/render-eta";
import { Darkroom } from "./Darkroom";
import type { MediaCatalog, StudioArtifact } from "../../lib/studio/types";
import { AiRewrite } from "./AiRewrite";
import { GalleryPicker } from "./GalleryPicker";
import { OpeningComposer } from "./OpeningComposer";
import { MediaModelPicker, mediaModelOption } from "./MediaModelPicker";
import { MediaViewer } from "./MediaViewer";
import { ShotCameraFields, ShotLineFields, ShotSoundFields } from "./ShotDirectionFields";
import { ShotPromptPreview } from "./ShotPromptPreview";

/** "16:9" as a number, or undefined for anything that is not a ratio. */
export function ratioOf(value: string | undefined): number | undefined {
  const [width, height] = (value ?? "").split(":").map(Number);
  return width > 0 && height > 0 ? width / height : undefined;
}

export function ProjectShots({
  document,
  onChange,
  artifacts,
  catalog,
  onGenerate,
  onImage,
  onBible,
  writingModelId,
  busy,
  live = [],
  now = Date.now(),
  fresh,
}: {
  document: ProjectDocument;
  onChange: (shots: ProjectShot[]) => void;
  artifacts: StudioArtifact[];
  catalog: MediaCatalog;
  onGenerate: (id: string) => void;
  onImage: (id: string) => void;
  onBible: () => void;
  /** The text model the AI rewrites write with. The app's when absent. */
  writingModelId?: string;
  busy: boolean;
  /** What is being made right now, for the waits shown where it will land. */
  live?: readonly LiveRender[];
  now?: number;
  /** Files that just arrived, revealed once. */
  fresh?: ReadonlySet<string>;
}) {
  const [selected, setSelected] = useState(document.shots[0]?.id);
  const [picker, setPicker] = useState<
    "opening" | "ending" | "reference" | "imageReference" | null
  >(null);
  const [referenceError, setReferenceError] = useState("");
  const [removed, setRemoved] = useState<{ shot: ProjectShot; index: number }>();
  const [viewing, setViewing] = useState<number>();
  // The take's own shape once it is known: a clip rendered at another ratio
  // than the project's must not be letterboxed inside a frame of the wrong one.
  const [measured, setMeasured] = useState<{ id: string; ratio: number }>();
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
  /** The take being made for a shot, else its opening image being composed. */
  const waitFor = (shotId: string | undefined) =>
    live.find((item) => item.target.kind === "take" && item.target.shotId === shotId) ??
    live.find((item) => item.target.kind === "opening" && item.target.shotId === shotId);
  const wait = waitFor(shot?.id);
  const mode = shot?.mode ?? "text";
  const modelsFor = (itemMode: ProjectShot["mode"]) =>
    catalog.models.filter(
      (model) =>
        !model.offline &&
        ["video", "imageToVideo", "referenceToVideo"].includes(model.mediaType) &&
        videoDirection(model) === (itemMode === "continuation" ? "image" : itemMode),
    );
  const modelOf = (item: ProjectShot | undefined) => shotVideoModel(item, document, catalog);
  const models = modelsFor(mode);
  const model = modelOf(shot);
  const timing = shot ? resolveShotDuration(shot, model) : undefined;
  const composed = shot ? composeProjectShot(shot, document, catalog) : undefined;
  // Prompts AI wrote with an earlier method. One written by hand is the
  // person's own and is never offered for replacement.
  const olderPrompts = document.shots.filter(
    (item) =>
      item.prompt?.trim() && item.promptOptimizedFor && item.promptVersion !== SHOT_REWRITE_VERSION,
  );
  const olderPrompt = shot ? olderPrompts.includes(shot) : false;
  /** "5 s", said the way a person reads it. */
  const secondsLabel = (seconds: number) =>
    t("{seconds} s", { seconds: seconds.toLocaleString(intlLocale()) });
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
  // Every take of the shot, then its opening image, in the order they were made.
  const viewable = [...(shot?.takeIds ?? []), shot?.openingArtifactId]
    .map((id) => artifacts.find((item) => item.id === id))
    .filter((item): item is StudioArtifact => !!item)
    .map((artifact) => ({
      artifact,
      title:
        artifact.id === shot?.openingArtifactId && !shot.takeIds.includes(artifact.id)
          ? t("{title}: opening image", { title: shot.title })
          : t("{title}: take {number}", {
              title: shot?.title ?? "",
              number: (shot?.takeIds.indexOf(artifact.id) ?? 0) + 1,
            }),
    }));
  const monitorRatio =
    (preview && measured?.id === preview.id ? measured.ratio : undefined) ??
    ratioOf(document.settings.aspectRatio) ??
    16 / 9;
  const openViewer = () => {
    const at = viewable.findIndex((item) => item.artifact.id === preview?.id);
    if (at !== -1) setViewing(at);
  };
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
  return (
    <div className="project-shots">
      <aside className="project-shot-list project-panel">
        <div className="project-actions">
          <h2>{t("Shots")}</h2>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => add()}>
            {t("Add shot")}
          </button>
        </div>
        {olderPrompts.length > 0 ? (
          <p className="project-warning">
            {olderPrompts.length === 1
              ? t("One prompt was written with the previous method.")
              : t("{count} prompts were written with the previous method.", {
                  count: olderPrompts.length,
                })}{" "}
            <button
              type="button"
              className="project-field-reset"
              disabled={busy}
              onClick={() =>
                onChange(
                  document.shots.map((item) =>
                    olderPrompts.includes(item)
                      ? {
                          ...item,
                          prompt: undefined,
                          promptOptimizedFor: undefined,
                          promptSeconds: undefined,
                          promptVersion: undefined,
                        }
                      : item,
                  ),
                )
              }
            >
              {t("Use the composed prompts")}
            </button>
          </p>
        ) : null}
        {document.shots.map((item, number) => {
          const thumbnail = artifacts.find((artifact) => artifact.id === item.openingArtifactId);
          const rowWait = waitFor(item.id);
          const rowTiming = resolveShotDuration(item, modelOf(item));
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
              {rowWait ? (
                <span
                  className="project-shot-placeholder project-shot-developing"
                  style={darkroomVars(darkroomSeed(`${item.id}${item.prompt ?? item.action}`))}
                />
              ) : thumbnail ? (
                <img src={artifactSrc(thumbnail)} alt="" />
              ) : (
                <span className="project-shot-placeholder" />
              )}
              <span>
                <strong>{item.title}</strong>
                <small>
                  {rowWait
                    ? rowWait.phase === "queued"
                      ? t("Queued · {time}", { time: formatElapsed(now - rowWait.startedAt) })
                      : t("Rendering · {time}", { time: formatElapsed(now - rowWait.startedAt) })
                    : `${rowTiming.automatic ? t("{duration}, automatic", { duration: secondsLabel(rowTiming.seconds) }) : secondsLabel(rowTiming.seconds)} · ${
                        item.takeIds.length
                          ? item.takeIds.length === 1
                            ? t("1 take")
                            : t("{count} takes", { count: item.takeIds.length })
                          : t("Not generated")
                      }`}
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
              if (document.shots.some((shot) => shot.id === removed.shot.id)) {
                setRemoved(undefined);
                return;
              }
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
            <div
              className="project-monitor"
              data-empty={!preview && !wait}
              style={
                {
                  "--monitor-ratio": wait
                    ? (ratioOf(document.settings.aspectRatio) ?? 16 / 9)
                    : monitorRatio,
                } as CSSProperties
              }
            >
              {wait ? (
                <Darkroom
                  seed={`${shot.id}${shot.prompt ?? shot.action}`}
                  phase={wait.phase}
                  elapsedMs={now - wait.startedAt}
                  estimateMs={estimateRenderMs(wait.etaKey)}
                  progress={wait.progress}
                  aspectRatio={document.settings.aspectRatio}
                  label={
                    wait.phase === "queued"
                      ? undefined
                      : wait.target.kind === "take"
                        ? t("Rendering take {number}", { number: shot.takeIds.length + 1 })
                        : t("Composing the opening image")
                  }
                />
              ) : preview?.kind === "video" ? (
                // biome-ignore lint/a11y/useMediaCaption: generated takes have no caption track
                <video
                  key={preview.id}
                  className={fresh?.has(preview.id) ? "project-reveal" : undefined}
                  controls
                  preload="metadata"
                  src={artifactSrc(preview)}
                  onLoadedMetadata={(event) => {
                    const { videoWidth, videoHeight } = event.currentTarget;
                    if (videoWidth && videoHeight)
                      setMeasured({ id: preview.id, ratio: videoWidth / videoHeight });
                  }}
                />
              ) : preview ? (
                <img
                  key={preview.id}
                  className={fresh?.has(preview.id) ? "project-reveal" : undefined}
                  src={artifactSrc(preview)}
                  alt={shot.title}
                  onLoad={(event) => {
                    const { naturalWidth, naturalHeight } = event.currentTarget;
                    if (naturalWidth && naturalHeight)
                      setMeasured({ id: preview.id, ratio: naturalWidth / naturalHeight });
                  }}
                  onDoubleClick={openViewer}
                />
              ) : (
                <div className="project-empty">
                  <h3>{t("Your shot starts here")}</h3>
                  <p>
                    {t("Describe it, choose how to generate it, then compare your takes here.")}
                  </p>
                </div>
              )}
              {preview && !wait ? (
                <button
                  type="button"
                  className="project-monitor-expand"
                  aria-label={t("Enlarge")}
                  title={t("Enlarge")}
                  onClick={openViewer}
                >
                  <IconExpandSimple size={16} />
                </button>
              ) : null}
            </div>
            {shot.renderedSignature && shot.renderedSignature !== shotSignature(shot, document) ? (
              <p className="project-warning">
                {t("Settings changed. Your previous takes are preserved.")}
              </p>
            ) : null}
            <fieldset disabled={busy}>
              <div className="project-two-columns">
                <label className="project-field">
                  {t("Action")}
                  <textarea
                    aria-label={t("Action")}
                    value={shot.action}
                    onChange={(event) => update({ action: event.target.value })}
                  />
                </label>
                <ShotCameraFields shot={shot} document={document} update={update} />
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
                <ShotLineFields shot={shot} update={update} />
              </details>
              <ShotSoundFields shot={shot} update={update} />
              {composed ? (
                <ShotPromptPreview
                  composed={composed}
                  lints={shotLints(shot, document.filmDirection)}
                  overridden={Boolean(shot.prompt?.trim())}
                  modelName={model?.name}
                />
              ) : null}
              <div className="project-field">
                <span className="project-field-heading">{t("Video prompt")}</span>
                <AiRewrite
                  label={t("Video prompt")}
                  value={shot.prompt ?? ""}
                  disabled={busy}
                  field={
                    <textarea
                      aria-label={t("Video prompt")}
                      rows={5}
                      value={shot.prompt ?? ""}
                      onChange={(event) => update({ prompt: event.target.value || undefined })}
                      placeholder={t(
                        "Leave empty to render the composed prompt, or improve it with AI.",
                      )}
                    />
                  }
                  status={
                    olderPrompt ? (
                      <span className="ai-field-stale">
                        {t("Written with the previous method.")}{" "}
                        <button
                          type="button"
                          className="project-field-reset"
                          onClick={() =>
                            update({
                              prompt: undefined,
                              promptOptimizedFor: undefined,
                              promptSeconds: undefined,
                              promptVersion: undefined,
                            })
                          }
                        >
                          {t("Use the composed prompt")}
                        </button>
                      </span>
                    ) : shot.promptOptimizedFor ? (
                      shot.promptOptimizedFor === model?.id ? (
                        shot.promptSeconds !== undefined &&
                        timing &&
                        shot.promptSeconds !== timing.seconds ? (
                          <span className="ai-field-stale">
                            {t(
                              "This prompt was paced for {previous}. Improve it again for {seconds}.",
                              {
                                previous: secondsLabel(shot.promptSeconds),
                                seconds: secondsLabel(timing.seconds),
                              },
                            )}
                          </span>
                        ) : (
                          <span className="project-badge">
                            {shot.promptSeconds !== undefined
                              ? t("Optimized for {model}, paced for {seconds}", {
                                  model: model.name,
                                  seconds: secondsLabel(shot.promptSeconds),
                                })
                              : t("Optimized for {model}", { model: model.name })}
                          </span>
                        )
                      ) : (
                        <span className="ai-field-stale">
                          {t(
                            "This prompt was written for {previous}. Improve it again for {model}.",
                            {
                              previous:
                                catalog.models.find((item) => item.id === shot.promptOptimizedFor)
                                  ?.name ?? shot.promptOptimizedFor,
                              model: model?.name ?? t("the selected model"),
                            },
                          )}
                        </span>
                      )
                    ) : null
                  }
                  onAccept={(prompt) =>
                    update({
                      prompt: prompt || undefined,
                      promptOptimizedFor: prompt ? model?.id : undefined,
                      promptSeconds: prompt ? timing?.seconds : undefined,
                      promptVersion: prompt ? SHOT_REWRITE_VERSION : undefined,
                    })
                  }
                  hint={
                    composed?.dialogue.mode === "native" && composed.dialogue.language !== "en"
                      ? t(
                          "Written in English, except the line the model speaks in its own language.",
                        )
                      : t("Written in English, the language these video models follow best.")
                  }
                  request={() =>
                    shot.prompt?.trim() || shot.action.trim() || shot.title.trim()
                      ? {
                          kind: "shotPrompt",
                          text: shot.prompt ?? "",
                          modelId: writingModelId,
                          context: {
                            composed: composed?.text,
                            dialogueMode: composed?.dialogue.mode,
                            targetModel: rewriteTargetModel(model),
                            mode,
                            title: shot.title,
                            action: shot.action,
                            camera: shot.camera,
                            speaker: shot.speaker,
                            dialogue: shot.dialogue,
                            // Always the seconds the take will run, even when the shot
                            // leaves the choice to the model and its motion.
                            duration: timing ? String(timing.seconds) : undefined,
                            aspectRatio: document.settings.aspectRatio,
                            entries: document.bible
                              .filter((entry) =>
                                entry.kind === "location"
                                  ? entry.name === shot.location
                                  : shot.characters.includes(entry.name),
                              )
                              .map((entry) => ({
                                name: entry.name,
                                kind: entry.kind,
                                traits: entry.traits,
                              })),
                            // The images this take will actually receive, so
                            // the prompt names each one the way the model
                            // reads it rather than guessing from the order.
                            references:
                              mode === "reference"
                                ? rewriteReferences(
                                    model,
                                    shotReferences(shot, document.bible, model),
                                  )
                                : undefined,
                          },
                        }
                      : undefined
                  }
                />
              </div>
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
              {wait?.target.kind === "take" ? (
                <div className="project-take" data-pending="true" aria-busy="true">
                  {t("Take {number}", { number: shot.takeIds.length + 1 })}
                  <small>{wait.phase === "queued" ? t("Queued") : t("Rendering")}</small>
                </div>
              ) : null}
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
                    update({
                      mode: next,
                      continues: next === "continuation",
                      modeSource: undefined,
                    });
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
                value={model?.id ?? shot.modelId ?? document.settings.videoModelId}
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
                  <option value="">
                    {t("Automatic: {duration}", {
                      duration: secondsLabel(
                        resolveShotDuration({ ...shot, duration: undefined }, model).seconds,
                      ),
                    })}
                  </option>
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
                  {acceptsOpeningFrameWithReferences(model?.id) ? (
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
              {mode !== "continuation" ? (
                <OpeningComposer
                  shot={shot}
                  document={document}
                  artifacts={artifacts}
                  catalog={catalog}
                  mode={mode}
                  opensFromFrame={
                    mode === "image" ||
                    (mode === "reference" && acceptsOpeningFrameWithReferences(model?.id))
                  }
                  writingModelId={writingModelId}
                  busy={busy}
                  update={update}
                  onPickGallery={() => setPicker("imageReference")}
                  onQuote={() => onImage(shot.id)}
                />
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
      {viewing !== undefined && viewable.length ? (
        <MediaViewer
          items={viewable}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(undefined)}
          actions={(artifact) =>
            shot?.takeIds.includes(artifact.id) ? (
              <button
                type="button"
                disabled={busy || shot.activeTakeId === artifact.id}
                onClick={() => update({ activeTakeId: artifact.id })}
              >
                {shot.activeTakeId === artifact.id ? t("Selected") : t("Select this take")}
              </button>
            ) : null
          }
        />
      ) : null}
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
