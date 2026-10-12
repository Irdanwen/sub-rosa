// Sound effects on the desk (ADR-0110): short foley and ambience from a
// one-line description. Rides the same async music queue as the music desk -
// only the model set, the input rules, and the copy differ.

import { t } from "../../lib/i18n";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { registerDownloadedArtifact } from "../../lib/studio/artifacts";
import { useMediaJob } from "../../lib/studio/async-job";
import {
  acceptedDuration,
  estimateCostCredits,
  musicCapabilities,
  musicQueueBody,
  soundEffectsModels,
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

/** Effects are described in a line, not a paragraph - and some backends cut
 * long descriptions anyway. */
export const SFX_PROMPT_LIMIT = 250;

const AUDIO_URL_FIELDS = ["audio_url", "url"];

export function SoundFxStudio({
  catalog,
  tools,
  onOpenGallery,
}: {
  catalog: MediaCatalog;
  tools?: ReactNode;
  onOpenGallery?: () => void;
}) {
  const models = useMemo(() => soundEffectsModels(catalog), [catalog]);
  const paths = musicPaths(catalog.backend);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId) ?? models[0];
  const caps = musicCapabilities(model);

  const [prompt, setPrompt] = useState("");
  // Auto duration lets the model size the effect to the description; the
  // slider only appears (and is only sent) when the user takes over.
  const [autoDuration, setAutoDuration] = useState(true);
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [loop, setLoop] = useState(false);
  const [galleryEpoch, setGalleryEpoch] = useState(0);
  const [effects, setEffects] = useState<StudioArtifact[]>([]);
  const [landed, setLanded] = useState<{ path: string } | undefined>(undefined);
  const [reveal, setReveal] = useState(false);

  // The file is already in the gallery directory (Rust downloaded it, possibly
  // while the app was closed); indexing it is all that is left.
  const job = useMediaJob("sfx", (artifact, finished) => {
    registerDownloadedArtifact(artifact, {
      kind: "sfx",
      model: finished.model,
      prompt: finished.prompt,
    });
    setGalleryEpoch((epoch) => epoch + 1);
    setLanded({ path: artifact.path });
    setReveal(true);
  });

  const duration = acceptedDuration(caps, durationSeconds) ?? durationSeconds;
  const loopOn = caps.loop === true && loop;
  const costCredits = model
    ? estimateCostCredits(model, {
        durationSeconds: autoDuration ? undefined : duration,
        multiplier: catalog.priceMultiplier,
      })
    : undefined;

  const waiting =
    job.state.phase === "queueing" ||
    job.state.phase === "queued" ||
    job.state.phase === "processing"
      ? job.state
      : undefined;
  const busy = Boolean(waiting);
  const estimate = useMemo(() => estimateRenderMs(renderEtaKey("sfx", modelId)), [modelId]);
  const wait = useJobWait(modelId + prompt, waiting, estimate, t("Rendering your effect"));
  const canSubmit = Boolean(model && prompt.trim()) && !busy;

  const start = useCallback(() => {
    if (!model || !prompt.trim()) return;
    const body = musicQueueBody(caps, {
      model: model.id,
      prompt: prompt.trim().slice(0, SFX_PROMPT_LIMIT),
      durationSeconds: duration,
      autoDuration,
      loop: loopOn,
    });
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
  }, [model, caps, prompt, autoDuration, duration, loopOn, job, paths]);

  const inspector = (
    <>
      {caps.loop ? (
        <StudioField label={t("Seamless loop")} hint={t("The end flows back into the start")}>
          <Switch checked={loop} onCheckedChange={setLoop} aria-label={t("Seamless loop")} />
        </StudioField>
      ) : null}
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

  return (
    <StudioDesk
      tools={tools}
      scene={
        <>
          <AudioScene
            landed={landed}
            newest={effects[0]}
            wait={wait}
            reveal={reveal}
            onRevealEnd={() => setReveal(false)}
            hint={t("Describe a sound. It will play here.")}
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
            maxLength={SFX_PROMPT_LIMIT}
            placeholder={t("A heavy wooden door creaks open")}
            ariaLabel={t("Description")}
            cost={costCredits}
            canSend={canSubmit}
            busy={busy}
            onSend={start}
            sendLabel={t("Generate effect")}
            tools={
              <ModelPickerChip
                label={t("Sound effect model")}
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
          kinds={["sfx"]}
          epoch={galleryEpoch}
          pending={busy ? 1 : 0}
          onArtifactsChanged={setEffects}
          onOpenGallery={onOpenGallery}
          onReusePrompt={(artifact) => setPrompt(artifact.prompt)}
        />
      }
    />
  );
}
