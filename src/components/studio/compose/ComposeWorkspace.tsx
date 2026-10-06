// The composer: one source image, a pack, and the images it makes. Shared by
// the desktop tab and the phone screen; `layout` only changes how it is laid
// out. Everything paid goes through durable jobs (lib/studio/compose/jobs.ts),
// so leaving the screen loses nothing: the images land in their gallery
// folder whether or not this view is still open.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useArtifactPreview } from "../../../lib/artifact-media";
import { friendlyErrorMessage } from "../../../lib/errors";
import { t } from "../../../lib/i18n";
import { listArtifacts } from "../../../lib/studio/artifacts";
import { estimateCostCredits, imageEditModels } from "../../../lib/studio/catalog";
import {
  COMPOSE_FAILED_EVENT,
  COMPOSE_RESULT_EVENT,
  type ComposeFailure,
  type ComposeResultDetail,
  composeContextOf,
  dismissComposeFailure,
  inFlightCompositions,
  readComposeFailures,
} from "../../../lib/studio/compose/jobs";
import {
  type ComposePack,
  composePacks,
  customPack,
  SHEET_CELLS,
  sheetable,
} from "../../../lib/studio/compose/packs";
import {
  type ComposeMode,
  planComposition,
  startComposition,
} from "../../../lib/studio/compose/plan";
import { defaultRetouchModel, editCaps } from "../../../lib/studio/retouch/request";
import type { MediaCatalog, StudioArtifact } from "../../../lib/studio/types";
import { Spinner } from "../../ui/Spinner";
import "./compose.css";

export function ComposeWorkspace({
  catalog,
  source,
  layout,
  onChangeSource,
  onOpenResult,
  hiddenIds,
}: {
  catalog: MediaCatalog;
  source: StudioArtifact;
  layout: "desktop" | "phone";
  onChangeSource: () => void;
  /** Open one result among the others, in the shell's own viewer. */
  onOpenResult?: (artifact: StudioArtifact, results: StudioArtifact[]) => void;
  /** Results deleted since they arrived, which the grid must not show. */
  hiddenIds?: ReadonlySet<string>;
}) {
  const models = useMemo(
    () => imageEditModels(catalog).filter((model) => !model.offline),
    [catalog],
  );
  const [modelId, setModelId] = useState(() => defaultRetouchModel(catalog)?.id ?? "");
  const model = models.find((entry) => entry.id === modelId) ?? models[0];
  const caps = useMemo(() => editCaps(model), [model]);
  const unitCost = model ? estimateCostCredits(model) : undefined;

  const packs = useMemo(composePacks, []);
  const [packId, setPackId] = useState(packs[0]?.id ?? "custom");
  const [customText, setCustomText] = useState("");
  const pack: ComposePack =
    packId === "custom"
      ? customPack(customText)
      : (packs.find((entry) => entry.id === packId) ?? packs[0]);
  const [mode, setMode] = useState<ComposeMode>("separate");
  const [aspectRatio, setAspectRatio] = useState("");
  const plan = planComposition(pack, mode, caps, unitCost);
  const framed = pack.shots.some((shot) => shot.aspectRatio);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [group, setGroup] = useState<string>();
  const [waiting, setWaiting] = useState<Set<string>>(new Set());
  const [resultIds, setResultIds] = useState<string[]>([]);
  const [results, setResults] = useState<StudioArtifact[]>([]);
  const [failures, setFailures] = useState<ComposeFailure[]>([]);

  /** The composition on screen, read by the listeners synchronously: a job
   * can finish before `startComposition` has returned. */
  const packsHeading = useId();
  const groupRef = useRef<string | undefined>(undefined);
  const settledRef = useRef<Set<string>>(new Set());
  /** How the composition on screen was sent, not how the form reads now. */
  const [sentMode, setSentMode] = useState<ComposeMode>("separate");

  // Results arrive one job at a time, from whichever observer filed them.
  useEffect(() => {
    const settle = (jobId: string) => {
      settledRef.current.add(jobId);
      setWaiting((current) => {
        if (!current.has(jobId)) return current;
        const next = new Set(current);
        next.delete(jobId);
        return next;
      });
    };
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<ComposeResultDetail>).detail;
      if (!detail || detail.group !== groupRef.current) return;
      settle(detail.jobId);
      setResultIds((current) => [...new Set([...current, ...detail.artifactIds])]);
    };
    const onFailed = () => {
      const current = groupRef.current;
      if (!current) return;
      const found = readComposeFailures(current);
      setFailures(found);
      for (const failure of found) settle(failure.jobId);
    };
    window.addEventListener(COMPOSE_RESULT_EVENT, onResult);
    window.addEventListener(COMPOSE_FAILED_EVENT, onFailed);
    return () => {
      window.removeEventListener(COMPOSE_RESULT_EVENT, onResult);
      window.removeEventListener(COMPOSE_FAILED_EVENT, onFailed);
    };
  }, []);

  // Coming back to an image whose composition is still rendering picks it up
  // again, instead of offering to pay for a second one.
  useEffect(() => {
    let cancelled = false;
    void inFlightCompositions().then((jobs) => {
      if (cancelled || groupRef.current) return;
      const mine = jobs
        .map((job) => ({ job, context: composeContextOf(job) }))
        .filter((entry) => entry.context?.sourceId === source.id);
      // The list comes newest first.
      const latest = mine[0]?.context;
      if (!latest) return;
      groupRef.current = latest.group;
      setGroup(latest.group);
      setSentMode(latest.mode);
      setWaiting(
        new Set(mine.filter((entry) => entry.context?.group === latest.group).map((e) => e.job.id)),
      );
      setFailures(readComposeFailures(latest.group));
      // A job may have finished between the read and now, its result heard
      // by nobody: read again and keep only what is still rendering.
      void inFlightCompositions().then((still) => {
        if (cancelled || groupRef.current !== latest.group) return;
        const live = new Set(still.map((job) => job.id));
        setWaiting((current) => new Set([...current].filter((id) => live.has(id))));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [source.id]);

  useEffect(() => {
    if (resultIds.length === 0) return;
    let cancelled = false;
    void listArtifacts("image").then((images) => {
      if (cancelled) return;
      const byId = new Map(images.map((image) => [image.id, image]));
      setResults(resultIds.flatMap((id) => byId.get(id) ?? []));
    });
    return () => {
      cancelled = true;
    };
  }, [resultIds]);

  const compose = useCallback(async () => {
    if (!model || busy) return;
    setBusy(true);
    setError(undefined);
    setResultIds([]);
    setResults([]);
    setFailures([]);
    const next = crypto.randomUUID();
    groupRef.current = next;
    settledRef.current = new Set();
    setGroup(next);
    setSentMode(plan.mode);
    try {
      const started = await startComposition({
        group: next,
        source,
        pack,
        plan,
        caps,
        unitCost,
        settings: {
          model: model.id,
          resolution: caps.defaultResolution,
          quality: caps.defaultQuality,
          aspectRatio: aspectRatio || undefined,
        },
      });
      setWaiting(
        new Set(started.jobs.map((job) => job.id).filter((id) => !settledRef.current.has(id))),
      );
      if (started.refused)
        setError(
          friendlyErrorMessage(started.refused, t("Some images of the composition were not sent.")),
        );
    } catch (cause) {
      setError(friendlyErrorMessage(cause, t("The composition could not be sent.")));
    } finally {
      setBusy(false);
    }
  }, [model, busy, source, pack, plan, caps, unitCost, aspectRatio]);

  const pending = waiting.size * (sentMode === "sheet" ? SHEET_CELLS : 1);
  const shown = hiddenIds ? results.filter((artifact) => !hiddenIds.has(artifact.id)) : results;
  const canCompose = Boolean(model) && plan.jobs > 0 && !busy && waiting.size === 0;

  return (
    <div className="compose" data-layout={layout}>
      <section className="compose-source">
        <SourcePreview source={source} />
        <button type="button" className="btn btn-ghost" onClick={onChangeSource}>
          {t("Choose another image")}
        </button>
      </section>

      <section className="compose-form">
        <h3 id={packsHeading}>{t("What to make from it")}</h3>
        <fieldset className="compose-packs" aria-labelledby={packsHeading}>
          {[...packs, customPack(customText)].map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={entry.id === packId}
              className="compose-pack"
              onClick={() => setPackId(entry.id)}
            >
              <span className="compose-pack-name">{entry.label}</span>
              <span className="compose-pack-description">{entry.description}</span>
              {entry.id !== "custom" ? (
                <span className="compose-pack-count">
                  {t("{count} images", { count: entry.shots.length })}
                </span>
              ) : null}
            </button>
          ))}
        </fieldset>

        {packId === "custom" ? (
          <label className="compose-field">
            {t("One image per line, nine at most")}
            <textarea
              className="studio-input"
              rows={5}
              value={customText}
              placeholder={t("For example: riding a bicycle in Paris")}
              onChange={(event) => setCustomText(event.currentTarget.value)}
            />
          </label>
        ) : null}

        {sheetable(pack) ? (
          <fieldset className="compose-modes">
            <legend>{t("How to make them")}</legend>
            <label>
              <input
                type="radio"
                name="compose-mode"
                checked={mode === "separate"}
                onChange={() => setMode("separate")}
              />
              <span>
                <strong>{t("One by one")}</strong>
                {t("Full quality, one paid image each.")}
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="compose-mode"
                checked={mode === "sheet"}
                onChange={() => setMode("sheet")}
              />
              <span>
                <strong>{t("On one sheet")}</strong>
                {t("Nine smaller images cut from one paid sheet.")}
              </span>
            </label>
          </fieldset>
        ) : null}

        <div className="compose-settings">
          <label className="compose-field">
            {t("Model")}
            <select
              className="studio-input"
              value={model?.id ?? ""}
              onChange={(event) => setModelId(event.currentTarget.value)}
            >
              {models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          {!framed && plan.mode === "separate" && caps.aspectRatios.length > 0 ? (
            <label className="compose-field">
              {t("Image format")}
              <select
                className="studio-input"
                value={aspectRatio}
                onChange={(event) => setAspectRatio(event.currentTarget.value)}
              >
                <option value="">{t("Like the source")}</option>
                {caps.aspectRatios.map((ratio) => (
                  <option key={ratio} value={ratio}>
                    {ratio}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        {plan.skipped.length > 0 ? (
          <p className="compose-note">
            {t("This model does not offer {frames}, so those are left out.", {
              frames: plan.skipped.map((shot) => shot.aspectRatio ?? shot.label).join(", "),
            })}
          </p>
        ) : null}

        <div className="compose-launch">
          <p className="compose-cost">
            {plan.mode === "sheet"
              ? t("{count} images from one paid sheet", { count: SHEET_CELLS })
              : t("{count} paid images", { count: plan.jobs })}
            {plan.costCredits !== undefined
              ? ` · ${t("about {credits} credits", { credits: plan.costCredits })}`
              : ""}
          </p>
          <button
            type="button"
            className="studio-primary-button"
            disabled={!canCompose}
            onClick={() => void compose()}
          >
            {busy ? <Spinner aria-hidden /> : null}
            {t("Compose")}
          </button>
        </div>
        {error ? (
          <p className="studio-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      {group ? (
        <section className="compose-results" aria-label={t("Results")}>
          <h3>{t("Results")}</h3>
          <p className="compose-note">{t("They are filed together in a folder of the gallery.")}</p>
          <div className="compose-grid">
            {shown.map((artifact) => (
              <ResultTile
                key={artifact.id}
                artifact={artifact}
                onOpen={onOpenResult ? () => onOpenResult(artifact, shown) : undefined}
              />
            ))}
            {Array.from({ length: pending }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
              <div key={`pending-${index}`} className="compose-tile compose-tile-pending">
                <Spinner aria-label={t("Rendering")} />
              </div>
            ))}
          </div>
          {failures.map((failure) => (
            <p key={failure.jobId} className="studio-error" role="alert">
              {failure.label ? `${failure.label}: ` : ""}
              {failure.message}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  dismissComposeFailure(failure.jobId);
                  setFailures(readComposeFailures(group));
                }}
              >
                {t("Dismiss")}
              </button>
            </p>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function SourcePreview({ source }: { source: StudioArtifact }) {
  const src = useArtifactPreview(source);
  return (
    <div className="compose-source-image">
      {src ? <img src={src} alt={source.prompt || t("Source image")} /> : <Spinner />}
    </div>
  );
}

function ResultTile({ artifact, onOpen }: { artifact: StudioArtifact; onOpen?: () => void }) {
  const src = useArtifactPreview(artifact);
  const label = artifact.title || artifact.prompt || t("Generated image");
  return (
    <figure className="compose-tile">
      <button
        type="button"
        className="compose-tile-open"
        aria-label={t("Open {name}", { name: label })}
        disabled={!onOpen}
        onClick={onOpen}
      >
        {src ? <img src={src} alt="" /> : <Spinner aria-hidden />}
      </button>
      <figcaption>{label}</figcaption>
    </figure>
  );
}
