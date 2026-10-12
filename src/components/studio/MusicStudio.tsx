// Music on the desk (ADR-0110): async queue + poll, like video, with
// per-model input rules (lyrics required / optional / forbidden) and
// duration-bracket pricing.

import { t } from "../../lib/i18n";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { registerDownloadedArtifact } from "../../lib/studio/artifacts";
import { useMediaJob } from "../../lib/studio/async-job";
import {
  acceptedDuration,
  estimateCostCredits,
  musicCapabilities,
  musicModels,
  musicQueueBody,
  musicRequestMissing,
} from "../../lib/studio/catalog";
import { modelSubtitle } from "../../lib/studio/model-subtitle";
import { musicPaths, retrieveBody } from "../../lib/studio/paths";
import { estimateRenderMs, renderEtaKey } from "../../lib/studio/render-eta";
import type { MediaCatalog, StudioArtifact } from "../../lib/studio/types";
import { Switch } from "../ui/Switch";
import { AudioScene } from "./desk/AudioScene";
import { Filmstrip } from "./desk/Filmstrip";
import { StudioDesk } from "./desk/StudioDesk";
import { useJobWait } from "./desk/useJobWait";
import { JobFailureNotice } from "./JobFailureNotice";
import { SliderField, StudioField } from "./controls";
import { Dock, DockComposer } from "./stage/Dock";
import { ModelPickerChip } from "./stage/ModelPicker";

// Carpe Diem streams the finished track as the retrieve body (one shot);
// Venice answers JSON with an `audio_url`. Both shapes must be accepted.
const AUDIO_URL_FIELDS = ["audio_url", "url"];

export function MusicStudio({
  catalog,
  tools,
  onOpenGallery,
}: {
  catalog: MediaCatalog;
  tools?: ReactNode;
  onOpenGallery?: () => void;
}) {
  const models = useMemo(() => musicModels(catalog), [catalog]);
  const paths = musicPaths(catalog.backend);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId);
  const caps = musicCapabilities(model ?? modelId);

  const [prompt, setPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [instrumental, setInstrumental] = useState(false);
  const [writeLyrics, setWriteLyrics] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState<number | undefined>(undefined);
  const [galleryEpoch, setGalleryEpoch] = useState(0);
  const [tracks, setTracks] = useState<StudioArtifact[]>([]);
  const [landed, setLanded] = useState<{ path: string } | undefined>(undefined);
  const [reveal, setReveal] = useState(false);

  // Rust already wrote the file into the gallery directory (it may have landed
  // while the app was closed); all that is left is indexing it.
  const job = useMediaJob("music", (artifact, finished) => {
    registerDownloadedArtifact(artifact, {
      kind: "music",
      model: finished.model,
      prompt: finished.prompt,
    });
    setGalleryEpoch((epoch) => epoch + 1);
    setLanded({ path: artifact.path });
    setReveal(true);
  });

  // Derived, never stored: a length picked on one model is snapped to what the
  // next one accepts, and an untouched slider opens on the model's default.
  const duration = acceptedDuration(caps, durationSeconds);
  const instrumentalOn = caps.instrumental && instrumental;
  const writeLyricsOn = caps.lyricsOptimizer === true && writeLyrics && !instrumentalOn;
  const costCredits = model
    ? estimateCostCredits(model, {
        durationSeconds: duration,
        multiplier: catalog.priceMultiplier,
      })
    : undefined;

  const lyricsMissing =
    musicRequestMissing(caps, {
      lyrics,
      instrumental: instrumentalOn,
      writeLyrics: writeLyricsOn,
    }) === "lyrics";
  const waiting =
    job.state.phase === "queueing" ||
    job.state.phase === "queued" ||
    job.state.phase === "processing"
      ? job.state
      : undefined;
  const busy = Boolean(waiting);
  const estimate = useMemo(() => estimateRenderMs(renderEtaKey("music", modelId)), [modelId]);
  const wait = useJobWait(modelId + prompt, waiting, estimate, t("Composing your track"));
  const canSubmit = Boolean(model && prompt.trim()) && !lyricsMissing && !busy;

  const start = useCallback(() => {
    if (!model || !prompt.trim()) return;
    const body = musicQueueBody(caps, {
      model: model.id,
      prompt,
      lyrics,
      instrumental: instrumentalOn,
      writeLyrics: writeLyricsOn,
      durationSeconds: duration,
    });
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
  }, [model, prompt, caps, instrumentalOn, writeLyricsOn, lyrics, duration, job, paths]);

  const inspector = (
    <>
      {caps.instrumental ? (
        <StudioField label={t("Instrumental")} hint={t("No vocals")}>
          <Switch
            checked={instrumental}
            onCheckedChange={setInstrumental}
            aria-label={t("Instrumental only")}
          />
        </StudioField>
      ) : null}
      {caps.lyricsOptimizer && !instrumentalOn ? (
        <StudioField label={t("Write the lyrics for me")} hint={t("From your prompt")}>
          <Switch
            checked={writeLyrics}
            onCheckedChange={setWriteLyrics}
            aria-label={t("Write the lyrics for me")}
          />
        </StudioField>
      ) : null}
      {caps.lyrics !== "none" && !instrumentalOn && !writeLyricsOn ? (
        <StudioField
          label={t("Lyrics")}
          hint={caps.lyrics === "required" ? t("Required for this model") : t("Optional")}
        >
          <textarea
            className="studio-textarea"
            rows={6}
            value={lyrics}
            maxLength={caps.lyricsLimit}
            placeholder={t("Verse 1: …\nChorus: …")}
            onChange={(event) => setLyrics(event.target.value)}
          />
        </StudioField>
      ) : null}
      {caps.durationSeconds && duration !== undefined ? (
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

  return (
    <StudioDesk
      tools={tools}
      scene={
        <>
          <AudioScene
            landed={landed}
            newest={tracks[0]}
            wait={wait}
            reveal={reveal}
            onRevealEnd={() => setReveal(false)}
            hint={t("Describe a track. It will play here.")}
          />
          {busy ? (
            <div className="studio-desk-scene-actions">
              <button type="button" className="stage-dock-action" onClick={job.cancel}>
                {t("Stop waiting")}
              </button>
            </div>
          ) : null}
        </>
      }
      notice={
        job.state.phase === "failed" ? (
          <JobFailureNotice
            className="stage-notice"
            retryClassName="stage-dock-action"
            message={job.state.message}
            status={job.state.status}
            model={modelId}
            onRetry={job.canRetry ? job.retry : undefined}
          />
        ) : undefined
      }
      dock={
        <Dock>
          <DockComposer
            value={prompt}
            onChange={setPrompt}
            maxLength={caps.promptLimit}
            placeholder={t("Genre, mood, tempo, instruments")}
            ariaLabel={t("Prompt")}
            cost={costCredits}
            canSend={canSubmit}
            busy={busy}
            onSend={start}
            sendLabel={t("Generate music")}
            blocker={
              lyricsMissing && prompt.trim()
                ? {
                    text: t("This model needs lyrics, or switch to instrumental."),
                    actions: caps.instrumental
                      ? [{ label: t("Instrumental"), onAction: () => setInstrumental(true) }]
                      : undefined,
                  }
                : undefined
            }
            tools={
              <ModelPickerChip
                label={t("Music model")}
                selectedId={model?.id ?? ""}
                entries={models.map((entry) => ({
                  id: entry.id,
                  name: entry.name,
                  subtitle: modelSubtitle(entry),
                }))}
                onSelect={setModelId}
              />
            }
          />
        </Dock>
      }
      inspector={inspector}
      strip={
        <Filmstrip
          kinds={["music"]}
          epoch={galleryEpoch}
          pending={busy ? 1 : 0}
          onArtifactsChanged={setTracks}
          onOpenGallery={onOpenGallery}
          onReusePrompt={(artifact) => setPrompt(artifact.prompt)}
        />
      }
    />
  );
}
