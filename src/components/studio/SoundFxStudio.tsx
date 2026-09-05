// Sound-effects studio: short foley and ambience from a one-line description.
// Rides the same async music queue as the music studio - only the model set,
// the input rules, and the copy differ.

import { t } from "../../lib/i18n";
import { IconSoundFx } from "central-icons/IconSoundFx";
import { useCallback, useMemo, useState } from "react";
import { registerDownloadedArtifact } from "../../lib/studio/artifacts";
import { useMediaJob } from "../../lib/studio/async-job";
import {
  estimateCostCredits,
  musicCapabilities,
  soundEffectsModels,
} from "../../lib/studio/catalog";
import { musicPaths, retrieveBody } from "../../lib/studio/paths";
import { estimateRenderMs, renderEtaKey } from "../../lib/studio/render-eta";
import type { MediaCatalog } from "../../lib/studio/types";
import { EmptyState } from "../ui/EmptyState";
import { Switch } from "../ui/Switch";
import { Darkroom } from "./Darkroom";
import { GalleryStrip } from "./GalleryStrip";
import { JobFailureNotice } from "./JobFailureNotice";
import { GenerationLayout } from "./GenerationLayout";
import { CostHint, ModelSelect, SliderField, StudioField } from "./controls";

/** Effects are described in a line, not a paragraph - and some backends cut
 * long descriptions anyway. */
export const SFX_PROMPT_LIMIT = 250;

const AUDIO_URL_FIELDS = ["audio_url", "url"];

export function SoundFxStudio({ catalog }: { catalog: MediaCatalog }) {
  const models = useMemo(() => soundEffectsModels(catalog), [catalog]);
  const paths = musicPaths(catalog.backend);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId) ?? models[0];
  const caps = musicCapabilities(model?.id ?? "");

  const [prompt, setPrompt] = useState("");
  // Auto duration lets the model size the effect to the description; the
  // slider only appears (and is only sent) when the user takes over.
  const [autoDuration, setAutoDuration] = useState(true);
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [galleryEpoch, setGalleryEpoch] = useState(0);

  // The file is already in the gallery directory (Rust downloaded it, possibly
  // while the app was closed); indexing it is all that is left.
  const job = useMediaJob("sfx", (artifact, finished) => {
    registerDownloadedArtifact(artifact, {
      kind: "sfx",
      model: finished.model,
      prompt: finished.prompt,
    });
    setGalleryEpoch((epoch) => epoch + 1);
  });

  const duration = caps.durationSeconds
    ? Math.min(Math.max(durationSeconds, caps.durationSeconds.min), caps.durationSeconds.max)
    : durationSeconds;
  const costCredits = model
    ? estimateCostCredits(model, {
        durationSeconds: autoDuration ? undefined : duration,
        multiplier: catalog.priceMultiplier,
      })
    : undefined;

  const busy =
    job.state.phase === "queueing" ||
    job.state.phase === "queued" ||
    job.state.phase === "processing";
  /** The same three phases, narrowed, so the darkroom can read the clock off
   * the ones that have one. */
  const waiting =
    job.state.phase === "queueing" ||
    job.state.phase === "queued" ||
    job.state.phase === "processing"
      ? job.state
      : undefined;
  const estimate = useMemo(() => estimateRenderMs(renderEtaKey("sfx", modelId)), [modelId]);
  const canSubmit = Boolean(model && prompt.trim()) && !busy;

  const start = useCallback(() => {
    if (!model || !prompt.trim()) return;
    const body: Record<string, unknown> = {
      model: model.id,
      prompt: prompt.trim().slice(0, SFX_PROMPT_LIMIT),
    };
    if (!autoDuration) body.duration_seconds = duration;
    void job.start({
      kind: "sfx",
      model: model.id,
      prompt: prompt.trim(),
      extension: "mp3",
      queuePath: paths.queue,
      queueBody: body,
      retrieve: (queueId) => ({
        path: paths.retrieve,
        body: retrieveBody(queueId, model.id),
      }),
      urlFields: AUDIO_URL_FIELDS,
    });
  }, [model, prompt, autoDuration, duration, job, paths]);

  const controls = (
    <>
      <StudioField label={t("Model")}>
        <ModelSelect
          models={models}
          value={model?.id ?? null}
          onChange={setModelId}
          ariaLabel={t("Sound effect model")}
        />
      </StudioField>
      <StudioField
        label={t("Description")}
        hint={`${Math.min(prompt.length, SFX_PROMPT_LIMIT)} / ${SFX_PROMPT_LIMIT}`}
      >
        <textarea
          className="studio-textarea"
          rows={3}
          value={prompt}
          maxLength={SFX_PROMPT_LIMIT}
          placeholder={t("A heavy wooden door creaks open")}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </StudioField>
      <StudioField label={t("Auto duration")} hint={t("Let the model pick")}>
        <Switch
          checked={autoDuration}
          onCheckedChange={setAutoDuration}
          aria-label={t("Auto duration")}
        />
      </StudioField>
      {!autoDuration && caps.durationSeconds ? (
        <SliderField
          label={t("Duration")}
          min={caps.durationSeconds.min}
          max={caps.durationSeconds.max}
          step={caps.durationSeconds.step}
          value={duration}
          onChange={setDurationSeconds}
          format={(value) => `${value}s`}
        />
      ) : null}
    </>
  );

  // While a render is in flight the wait itself is on the output side, in the
  // darkroom, so the controls column keeps only the thing there is left to do.
  const action = busy ? (
    <button type="button" className="btn btn-secondary" onClick={job.cancel}>
      {t("Stop waiting")}
    </button>
  ) : (
    <button type="button" className="studio-primary-button" disabled={!canSubmit} onClick={start}>
      <span>{t("Generate effect")}</span>
      <CostHint credits={costCredits} />
    </button>
  );

  return (
    <GenerationLayout controls={controls} action={action}>
      {waiting ? (
        <Darkroom
          variant="audio"
          seed={modelId + prompt}
          phase={waiting.phase}
          elapsedMs={waiting.phase === "queueing" ? undefined : waiting.elapsedMs}
          estimateMs={estimate}
          label={waiting.phase === "processing" ? t("Rendering your effect") : undefined}
          meta={modelId}
        />
      ) : null}
      {job.state.phase === "failed" ? (
        <JobFailureNotice
          message={job.state.message}
          status={job.state.status}
          model={modelId}
          onRetry={job.canRetry ? job.retry : undefined}
        />
      ) : null}
      <GalleryStrip
        kind="sfx"
        epoch={galleryEpoch}
        empty={
          !busy ? (
            <EmptyState
              icon={<IconSoundFx size={22} />}
              title={t("No sound effects yet")}
              description={t(
                "Describe a short sound: a door creak, rain on glass, a sci-fi whoosh.",
              )}
            />
          ) : null
        }
      />
    </GenerationLayout>
  );
}
