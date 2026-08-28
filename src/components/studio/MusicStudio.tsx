// Music studio: async queue + poll, like video, with per-model input rules
// (lyrics required / optional / forbidden) and duration-bracket pricing.

import { IconAudio } from "central-icons/IconAudio";
import { useCallback, useMemo, useState } from "react";
import { registerDownloadedArtifact } from "../../lib/studio/artifacts";
import { useMediaJob } from "../../lib/studio/async-job";
import { estimateCostCredits, musicCapabilities, musicModels } from "../../lib/studio/catalog";
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

// Carpe Diem streams the finished track as the retrieve body (one shot);
// Venice answers JSON with an `audio_url`. Both shapes must be accepted.
const AUDIO_URL_FIELDS = ["audio_url", "url"];

export function MusicStudio({ catalog }: { catalog: MediaCatalog }) {
  const models = useMemo(() => musicModels(catalog), [catalog]);
  const paths = musicPaths(catalog.backend);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId);
  const caps = musicCapabilities(modelId);

  const [prompt, setPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [instrumental, setInstrumental] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState(60);
  const [galleryEpoch, setGalleryEpoch] = useState(0);

  // Rust already wrote the file into the gallery directory (it may have landed
  // while the app was closed); all that is left is indexing it.
  const job = useMediaJob("music", (artifact, finished) => {
    registerDownloadedArtifact(artifact, {
      kind: "music",
      model: finished.model,
      prompt: finished.prompt,
    });
    setGalleryEpoch((epoch) => epoch + 1);
  });

  const duration = caps.durationSeconds
    ? Math.min(Math.max(durationSeconds, caps.durationSeconds.min), caps.durationSeconds.max)
    : undefined;
  const costCredits = model
    ? estimateCostCredits(model, {
        durationSeconds: duration,
        multiplier: catalog.priceMultiplier,
      })
    : undefined;

  const lyricsMissing = caps.lyrics === "required" && !instrumental && !lyrics.trim();
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
  const estimate = useMemo(() => estimateRenderMs(renderEtaKey("music", modelId)), [modelId]);
  const canSubmit = Boolean(model && prompt.trim()) && !lyricsMissing && !busy;

  const start = useCallback(() => {
    if (!model || !prompt.trim()) return;
    const body: Record<string, unknown> = { model: model.id, prompt: prompt.trim() };
    if (caps.lyrics !== "none" && !instrumental && lyrics.trim()) {
      body.lyrics_prompt = lyrics.trim();
    }
    if (caps.instrumental && caps.lyrics !== "none" && instrumental) {
      body.force_instrumental = true;
    }
    if (duration !== undefined) body.duration_seconds = duration;
    void job.start({
      kind: "music",
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
  }, [model, prompt, caps, instrumental, lyrics, duration, job, paths]);

  const controls = (
    <>
      <StudioField label="Model">
        <ModelSelect
          models={models}
          value={modelId || null}
          onChange={setModelId}
          ariaLabel="Music model"
        />
      </StudioField>
      <StudioField label="Prompt">
        <textarea
          className="studio-textarea"
          rows={4}
          value={prompt}
          placeholder="Genre, mood, tempo, instruments"
          onChange={(event) => setPrompt(event.target.value)}
        />
      </StudioField>
      {caps.lyrics !== "none" ? (
        <>
          {caps.instrumental ? (
            <StudioField label="Instrumental" hint="No vocals">
              <Switch
                checked={instrumental}
                onCheckedChange={setInstrumental}
                aria-label="Instrumental only"
              />
            </StudioField>
          ) : null}
          {!instrumental ? (
            <StudioField
              label="Lyrics"
              hint={caps.lyrics === "required" ? "Required for this model" : "Optional"}
            >
              <textarea
                className="studio-textarea"
                rows={5}
                value={lyrics}
                placeholder={"Verse 1: …\nChorus: …"}
                onChange={(event) => setLyrics(event.target.value)}
              />
            </StudioField>
          ) : null}
        </>
      ) : null}
      {caps.durationSeconds && duration !== undefined ? (
        <SliderField
          label="Duration"
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
      Stop waiting
    </button>
  ) : (
    <button type="button" className="studio-primary-button" disabled={!canSubmit} onClick={start}>
      <span>Generate music</span>
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
          label={waiting.phase === "processing" ? "Composing your track" : undefined}
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
      {lyricsMissing && prompt.trim() ? (
        <p className="studio-error">This model needs lyrics, or switch to instrumental.</p>
      ) : null}
      <GalleryStrip
        kind="music"
        epoch={galleryEpoch}
        empty={
          !busy ? (
            <EmptyState
              icon={<IconAudio size={22} />}
              title="No tracks yet"
              description="Describe a genre and mood, then generate. Tracks usually take 20 to 90 seconds."
            />
          ) : null
        }
      />
    </GenerationLayout>
  );
}
