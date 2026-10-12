// Speech studio: text to speech as a first-class surface (not just the
// workflow node). Two rails (ADR-0076): a `tts` model answers in one call; a
// speaking model of the music queue (ElevenLabs TTS v3/v4, Seed Audio) is a
// durable job Rust polls, downloads and announces.

import { t } from "../../lib/i18n";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { registerDownloadedArtifact, saveArtifactFromBase64 } from "../../lib/studio/artifacts";
import { useMediaJob } from "../../lib/studio/async-job";
import { estimateCostCredits, speechModels } from "../../lib/studio/catalog";
import { clonedVoiceRef } from "../../lib/studio/cloned-voices";
import { useClonedVoices } from "../../lib/studio/use-cloned-voices";
import { estimateRenderMs, renderEtaKey } from "../../lib/studio/render-eta";
import {
  AUDIO_TAGS,
  acceptedFormat,
  acceptedSpeed,
  acceptedVoice,
  defaultSpeechModel,
  estimatedSpeechSeconds,
  generateSpeech,
  insertTag,
  queuedSpeechJob,
  rememberedVoiceIds,
  rememberVoiceId,
  speechCapabilities,
  type SpeechFormat,
} from "../../lib/studio/speech";
import { modelSubtitle } from "../../lib/studio/model-subtitle";
import type { MediaCatalog, StudioArtifact } from "../../lib/studio/types";
import { ClonedVoiceDialog } from "./ClonedVoiceDialog";
import { AudioScene } from "./desk/AudioScene";
import { Filmstrip } from "./desk/Filmstrip";
import { StudioDesk } from "./desk/StudioDesk";
import { useJobWait } from "./desk/useJobWait";
import { JobFailureNotice } from "./JobFailureNotice";
import { effectiveOption, PillGroup, SliderField, StudioField } from "./controls";
import { Dock, DockComposer } from "./stage/Dock";
import { DockSelectChip } from "./stage/DockChip";
import { ModelPickerChip } from "./stage/ModelPicker";

export function SpeechStudio({
  catalog,
  tools,
  onOpenGallery,
}: {
  catalog: MediaCatalog;
  tools?: ReactNode;
  onOpenGallery?: () => void;
}) {
  const models = useMemo(() => speechModels(catalog), [catalog]);
  const [modelId, setModelId] = useState("");
  const model = models.find((entry) => entry.id === modelId) ?? defaultSpeechModel(models);
  const caps = useMemo(() => speechCapabilities(model), [model]);

  const [voice, setVoice] = useState("");
  const [voiceId, setVoiceId] = useState("");
  // Voices the person made from a sample, on the engine that clones (ADR-0077).
  const cloned = useClonedVoices(model?.id, caps.cloning !== undefined);
  const [voicesOpen, setVoicesOpen] = useState(false);
  const voiceOptions = [
    ...cloned.options,
    ...caps.voices.map((entry) => ({ value: entry, label: entry })),
  ];
  const listedVoice =
    effectiveOption(
      voiceOptions.map((option) => option.value),
      voice,
    ) ||
    caps.defaultVoice ||
    "";
  // A provider Voice ID, where the model takes one, wins over the list.
  const effectiveVoice = acceptedVoice(
    caps,
    caps.customVoiceId && voiceId.trim() ? voiceId : listedVoice,
  );

  const [text, setText] = useState("");
  const [speed, setSpeed] = useState<number | undefined>(undefined);
  const effectiveSpeed = acceptedSpeed(caps, speed);
  // The format the model answers in: the one chosen when it takes it, else
  // its own default (Chatterbox HD answers only wav).
  const [chosenFormat, setFormat] = useState<SpeechFormat | undefined>(undefined);
  const format = acceptedFormat(caps, chosenFormat);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [galleryEpoch, setGalleryEpoch] = useState(0);
  const [narrations, setNarrations] = useState<StudioArtifact[]>([]);
  const [landed, setLanded] = useState<{ path: string } | undefined>(undefined);
  const [reveal, setReveal] = useState(false);
  const land = useCallback((path: string) => {
    setLanded({ path });
    setReveal(true);
  }, []);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const rememberedIds = useMemo(() => rememberedVoiceIds(), []);

  useEffect(() => () => abortRef.current?.abort(), []);

  // The queue rail: Rust already wrote the file into the gallery directory.
  const job = useMediaJob("speech", (artifact, finished) => {
    registerDownloadedArtifact(artifact, {
      kind: "speech",
      model: finished.model,
      prompt: finished.prompt,
    });
    setGalleryEpoch((epoch) => epoch + 1);
    land(artifact.path);
  });
  const waiting =
    job.state.phase === "queueing" ||
    job.state.phase === "queued" ||
    job.state.phase === "processing"
      ? job.state
      : undefined;
  const working = busy || Boolean(waiting);
  const estimate = useMemo(() => estimateRenderMs(renderEtaKey("speech", model?.id)), [model?.id]);
  // The one-call rail has no job row; its wait starts when the request does.
  const [narratingSince, setNarratingSince] = useState<number | undefined>(undefined);
  useEffect(() => setNarratingSince(busy ? Date.now() : undefined), [busy]);
  const queuedWait = useJobWait(
    (model?.id ?? "") + text.slice(0, 64),
    waiting,
    estimate,
    t("Recording your voice-over"),
  );
  const wait =
    queuedWait ??
    (narratingSince !== undefined
      ? {
          seed: (model?.id ?? "") + text.slice(0, 64),
          phase: "processing" as const,
          startedAt: narratingSince,
          estimateMs: estimate,
          label: t("Narrating your text"),
        }
      : undefined);

  const input = text.trim().slice(0, caps.inputLimit);
  // No price before there is a text: "~0 credits" read as free.
  const costCredits =
    model && input
      ? estimateCostCredits(model, {
          characters: input.length,
          durationSeconds: estimatedSpeechSeconds(input.length),
          multiplier: catalog.priceMultiplier,
        })
      : undefined;
  const canSubmit = Boolean(model && input) && !working;

  const generate = useCallback(async () => {
    if (!model || !input || working) return;
    setError(null);
    if (caps.customVoiceId && voiceId.trim()) rememberVoiceId(voiceId);
    if (caps.rail === "queue") {
      void job.start(
        queuedSpeechJob(catalog, caps, {
          model,
          text: input,
          voice: effectiveVoice,
          speed: effectiveSpeed,
        }),
      );
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      const { base64 } = await generateSpeech({
        model: model.id,
        input,
        voice: effectiveVoice,
        speed: effectiveSpeed,
        format,
        signal: controller.signal,
      });
      const saved = await saveArtifactFromBase64(base64, format, {
        kind: "speech",
        model: model.id,
        prompt: input,
      });
      setGalleryEpoch((epoch) => epoch + 1);
      land(saved.path);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : t("The narration failed."));
      }
    } finally {
      setBusy(false);
    }
  }, [
    model,
    input,
    working,
    caps,
    voiceId,
    job,
    catalog,
    effectiveVoice,
    effectiveSpeed,
    format,
    land,
  ]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const addTag = useCallback(
    (tag: string) => {
      const area = textRef.current;
      const at = area ? area.selectionStart : text.length;
      const next = insertTag(text, tag, at);
      setText(next.text.slice(0, caps.inputLimit));
      requestAnimationFrame(() => {
        area?.focus();
        area?.setSelectionRange(next.caret, next.caret);
      });
    },
    [text, caps.inputLimit],
  );

  const inspector = (
    <>
      {caps.cloning && model ? (
        <StudioField label={t("Your voices")} hint={t("Made from a sample of your own voice")}>
          <button type="button" className="btn btn-secondary" onClick={() => setVoicesOpen(true)}>
            {cloned.voices.length > 0 ? t("Manage your voices") : t("Make your voice")}
          </button>
          <ClonedVoiceDialog
            open={voicesOpen}
            onClose={() => setVoicesOpen(false)}
            model={model}
            cloning={caps.cloning}
            voices={cloned.voices}
            onChanged={(created) => {
              void cloned.reload();
              if (created) {
                setVoice(clonedVoiceRef(created.id));
                setVoicesOpen(false);
              }
            }}
          />
        </StudioField>
      ) : null}
      {caps.customVoiceId ? (
        <StudioField label={t("Your ElevenLabs voice")} hint={t("From your ElevenLabs library")}>
          <input
            className="studio-input"
            value={voiceId}
            list="studio-voice-ids"
            spellCheck={false}
            autoComplete="off"
            placeholder={t("Voice ID (optional)")}
            aria-label={t("ElevenLabs Voice ID")}
            onChange={(event) => setVoiceId(event.target.value)}
          />
          <datalist id="studio-voice-ids">
            {rememberedIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </StudioField>
      ) : null}
      {caps.audioTags ? (
        <StudioField label={t("Expression")} hint={t("Performed, not read aloud")}>
          <div className="studio-pills">
            {AUDIO_TAGS.map((tag) => (
              <button key={tag} type="button" className="studio-pill" onClick={() => addTag(tag)}>
                {tag}
              </button>
            ))}
          </div>
        </StudioField>
      ) : null}
      {caps.speed && effectiveSpeed !== undefined ? (
        <SliderField
          label={t("Speed")}
          min={caps.speed.min}
          max={caps.speed.max}
          step={caps.speed.step}
          value={effectiveSpeed}
          onChange={setSpeed}
          format={(value) => `x${Math.round(value * 100) / 100}`}
        />
      ) : null}
      {caps.formats.length > 0 ? (
        <StudioField label={t("Format")}>
          <PillGroup
            options={caps.formats.map((entry) => ({ value: entry }))}
            value={format}
            onChange={setFormat}
            ariaLabel={t("Audio format")}
          />
        </StudioField>
      ) : null}
    </>
  );

  const voiceLabel = (value: string) =>
    voiceOptions.find((option) => option.value === value)?.label ?? value;

  return (
    <StudioDesk
      tools={tools}
      scene={
        <>
          <AudioScene
            landed={landed}
            newest={narrations[0]}
            wait={wait}
            reveal={reveal}
            onRevealEnd={() => setReveal(false)}
            hint={t("Type a text. Its voice-over will play here.")}
          />
          {working ? (
            <div className="studio-desk-scene-actions">
              <button
                type="button"
                className="stage-dock-action"
                onClick={busy ? cancel : job.cancel}
              >
                {busy ? t("Cancel") : t("Stop waiting")}
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
            model={model?.id}
            onRetry={job.canRetry ? job.retry : undefined}
          />
        ) : error ? (
          <p className="stage-notice" data-tone="error" role="alert">
            {error}
          </p>
        ) : undefined
      }
      dock={
        <Dock>
          <DockComposer
            value={text}
            onChange={setText}
            maxLength={caps.inputLimit}
            placeholder={t("Type or paste the text to narrate")}
            ariaLabel={t("Text")}
            cost={costCredits}
            canSend={canSubmit}
            busy={working}
            onSend={() => void generate()}
            sendLabel={t("Generate speech")}
            fieldRef={textRef}
            tools={
              <>
                <ModelPickerChip
                  label={t("Speech model")}
                  selectedId={model?.id ?? ""}
                  entries={models.map((entry) => ({
                    id: entry.id,
                    name: entry.name,
                    subtitle: modelSubtitle(entry),
                  }))}
                  onSelect={setModelId}
                />
                {voiceOptions.length > 0 ? (
                  <DockSelectChip
                    label={t("Voice")}
                    value={listedVoice}
                    options={voiceOptions.map((option) => option.value)}
                    onChange={setVoice}
                    format={voiceLabel}
                  />
                ) : null}
              </>
            }
          >
            {text.length > caps.inputLimit * 0.8 ? (
              <p className="stage-dock-hint studio-desk-variant">
                {`${Math.min(text.length, caps.inputLimit)} / ${caps.inputLimit}`}
              </p>
            ) : null}
          </DockComposer>
        </Dock>
      }
      inspector={inspector}
      strip={
        <Filmstrip
          kinds={["speech"]}
          epoch={galleryEpoch}
          pending={working ? 1 : 0}
          onArtifactsChanged={setNarrations}
          onOpenGallery={onOpenGallery}
          onReusePrompt={(artifact) => setText(artifact.prompt)}
        />
      }
    />
  );
}
