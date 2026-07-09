// Music studio: async queue + poll, like video, with per-model input rules
// (lyrics required / optional / forbidden) and duration-bracket pricing.

import { IconAudio } from "central-icons/IconAudio";
import { useCallback, useEffect, useMemo, useState } from "react";
import { saveArtifactFromResult } from "../../lib/studio/artifacts";
import {
  fileResultFrom,
  formatElapsed,
  type MediaFileResult,
  pendingJobs,
  removePersistedJob,
  useMediaJob,
  type PersistedJob,
} from "../../lib/studio/async-job";
import { estimateCostCredits, modelsOfType, musicCapabilities } from "../../lib/studio/catalog";
import { musicPaths, retrieveBody } from "../../lib/studio/paths";
import type { MediaCatalog } from "../../lib/studio/types";
import { EmptyState } from "../ui/EmptyState";
import { Spinner } from "../ui/Spinner";
import { Switch } from "../ui/Switch";
import { GalleryStrip } from "./GalleryStrip";
import { GenerationLayout } from "./GenerationLayout";
import { CostHint, ModelSelect, SliderField, StudioField } from "./controls";

// Carpe Diem streams the finished track as the retrieve body (one shot);
// Venice answers JSON with an `audio_url`. Both shapes must be accepted.
const audioResultFrom = fileResultFrom("audio_url", "url");

export function MusicStudio({ catalog }: { catalog: MediaCatalog }) {
  const models = useMemo(() => modelsOfType(catalog, "music"), [catalog]);
  const paths = musicPaths(catalog.backend);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId);
  const caps = musicCapabilities(modelId);

  const [prompt, setPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [instrumental, setInstrumental] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState(60);
  const [resumable, setResumable] = useState<PersistedJob[]>([]);
  const [galleryEpoch, setGalleryEpoch] = useState(0);

  const job = useMediaJob<MediaFileResult>(async (result, finished) => {
    await saveArtifactFromResult(result, "mp3", {
      kind: "music",
      model: finished.model,
      prompt: finished.prompt,
    });
    setGalleryEpoch((epoch) => epoch + 1);
  });

  useEffect(() => {
    setResumable(pendingJobs("music"));
  }, []);

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
      getResult: audioResultFrom,
    });
  }, [model, prompt, caps, instrumental, lyrics, duration, job, paths]);

  const resume = useCallback(
    (pending: PersistedJob) => {
      setResumable((jobs) => jobs.filter((entry) => entry.id !== pending.id));
      void job.resume(pending, audioResultFrom);
    },
    [job],
  );

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

  const action = busy ? (
    <div className="studio-progress">
      <Spinner aria-hidden />
      <span>
        {job.state.phase === "queued"
          ? "Queued, waiting for a slot"
          : job.state.phase === "processing"
            ? "Composing your track"
            : "Submitting"}
        {job.state.phase === "queued" || job.state.phase === "processing"
          ? ` - ${formatElapsed(job.state.elapsedMs)}`
          : ""}
      </span>
      <button type="button" className="btn btn-secondary" onClick={job.cancel}>
        Stop waiting
      </button>
    </div>
  ) : (
    <button type="button" className="studio-primary-button" disabled={!canSubmit} onClick={start}>
      <span>Generate music</span>
      <CostHint credits={costCredits} />
    </button>
  );

  return (
    <GenerationLayout controls={controls} action={action}>
      {job.state.phase === "failed" ? <p className="studio-error">{job.state.message}</p> : null}
      {lyricsMissing && prompt.trim() ? (
        <p className="studio-error">This model needs lyrics, or switch to instrumental.</p>
      ) : null}
      {resumable.map((pending) => (
        <div key={pending.id} className="studio-resume">
          <span>
            A track from an earlier session may still be rendering: "{pending.prompt.slice(0, 80)}"
          </span>
          <span className="studio-card-actions">
            <button type="button" className="btn btn-secondary" onClick={() => resume(pending)}>
              Check on it
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                removePersistedJob(pending.id);
                setResumable((jobs) => jobs.filter((entry) => entry.id !== pending.id));
              }}
            >
              Dismiss
            </button>
          </span>
        </div>
      ))}
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
