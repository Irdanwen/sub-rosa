// The composer: one source image, a pack, and the images it makes. Shared by
// the desktop tab and the phone screen; `layout` only changes how it is laid
// out. Everything paid goes through durable jobs (lib/studio/compose/jobs.ts),
// so leaving the screen loses nothing: the images land in their gallery
// folder whether or not this view is still open.

import { useCallback, useEffect, useMemo, useState } from "react";
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
  dismissComposeFailure,
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
}: {
  catalog: MediaCatalog;
  source: StudioArtifact;
  layout: "desktop" | "phone";
  onChangeSource: () => void;
  /** Open one result among the others, in the shell's own viewer. */
  onOpenResult?: (artifact: StudioArtifact, results: StudioArtifact[]) => void;
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

  // Results arrive one job at a time, from whichever observer filed them.
  useEffect(() => {
    if (!group) return;
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<ComposeResultDetail>).detail;
      if (detail?.group !== group) return;
      setWaiting((current) => {
        const next = new Set(current);
        next.delete(detail.jobId);
        return next;
      });
      setResultIds((current) => [...current, ...detail.artifactIds]);
    };
    const onFailed = () => {
      const current = readComposeFailures(group);
      setFailures(current);
      setWaiting((pending) => {
        const next = new Set(pending);
        for (const failure of current) next.delete(failure.jobId);
        return next;
      });
    };
    window.addEventListener(COMPOSE_RESULT_EVENT, onResult);
    window.addEventListener(COMPOSE_FAILED_EVENT, onFailed);
    return () => {
      window.removeEventListener(COMPOSE_RESULT_EVENT, onResult);
      window.removeEventListener(COMPOSE_FAILED_EVENT, onFailed);
    };
  }, [group]);

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
    try {
      const started = await startComposition({
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
      setGroup(started.group);
      setWaiting(new Set(started.jobs.map((job) => job.id)));
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

  const pending = waiting.size * (plan.mode === "sheet" ? SHEET_CELLS : 1);
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
        <h3>{t("What to make from it")}</h3>
        <div className="compose-packs" role="group" aria-label={t("Pack")}>
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
        </div>

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
              {t("Frame")}
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
            {results.map((artifact) => (
              <ResultTile
                key={artifact.id}
                artifact={artifact}
                onOpen={onOpenResult ? () => onOpenResult(artifact, results) : undefined}
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
