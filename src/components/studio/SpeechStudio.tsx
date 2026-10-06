// Speech studio: text to speech as a first-class surface (not just the
// workflow node). Two rails (ADR-0076): a `tts` model answers in one call; a
// speaking model of the music queue (ElevenLabs TTS v3/v4, Seed Audio) is a
// durable job Rust polls, downloads and announces.

import { t } from "../../lib/i18n";
import { IconVoice2 } from "central-icons/IconVoice2";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { registerDownloadedArtifact, saveArtifactFromBase64 } from "../../lib/studio/artifacts";
import { useMediaJob } from "../../lib/studio/async-job";
import { estimateCostCredits, speechModels } from "../../lib/studio/catalog";
import { estimateRenderMs, renderEtaKey } from "../../lib/studio/render-eta";
import {
  AUDIO_TAGS,
  acceptedSpeed,
  acceptedVoice,
  estimatedSpeechSeconds,
  generateSpeech,
  insertTag,
  queuedSpeechJob,
  rememberedVoiceIds,
  rememberVoiceId,
  speechCapabilities,
  type SpeechFormat,
} from "../../lib/studio/speech";
import type { MediaCatalog } from "../../lib/studio/types";
import { EmptyState } from "../ui/EmptyState";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { Darkroom } from "./Darkroom";
import { GalleryStrip } from "./GalleryStrip";
import { JobFailureNotice } from "./JobFailureNotice";
import { GenerationLayout } from "./GenerationLayout";
import {
  CostHint,
  effectiveOption,
  ModelSelect,
  PillGroup,
  SliderField,
  StudioField,
} from "./controls";

export function SpeechStudio({ catalog }: { catalog: MediaCatalog }) {
  const models = useMemo(() => speechModels(catalog), [catalog]);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId) ?? models[0];
  const caps = useMemo(() => speechCapabilities(model), [model]);

  const [voice, setVoice] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const listedVoice = effectiveOption(caps.voices, voice) || caps.defaultVoice || "";
  // A provider Voice ID, where the model takes one, wins over the list.
  const effectiveVoice = acceptedVoice(
    caps,
    caps.customVoiceId && voiceId.trim() ? voiceId : listedVoice,
  );

  const [text, setText] = useState("");
  const [speed, setSpeed] = useState<number | undefined>(undefined);
  const effectiveSpeed = acceptedSpeed(caps, speed);
  const [format, setFormat] = useState<SpeechFormat>("mp3");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [galleryEpoch, setGalleryEpoch] = useState(0);
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
  });
  const waiting =
    job.state.phase === "queueing" ||
    job.state.phase === "queued" ||
    job.state.phase === "processing"
      ? job.state
      : undefined;
  const working = busy || Boolean(waiting);
  const estimate = useMemo(() => estimateRenderMs(renderEtaKey("speech", model?.id)), [model?.id]);

  const input = text.trim().slice(0, caps.inputLimit);
  const costCredits = model
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
      await saveArtifactFromBase64(base64, format, {
        kind: "speech",
        model: model.id,
        prompt: input,
      });
      setGalleryEpoch((epoch) => epoch + 1);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : t("The narration failed."));
      }
    } finally {
      setBusy(false);
    }
  }, [model, input, working, caps, voiceId, job, catalog, effectiveVoice, effectiveSpeed, format]);

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

  const controls = (
    <>
      <StudioField label={t("Model")}>
        <ModelSelect
          models={models}
          value={model?.id ?? null}
          onChange={setModelId}
          ariaLabel={t("Speech model")}
        />
      </StudioField>
      {caps.voices.length > 0 ? (
        <StudioField label={t("Voice")}>
          <Select
            value={listedVoice || null}
            placeholder={t("Choose a voice")}
            ariaLabel={t("Voice")}
            onChange={setVoice}
            options={caps.voices.map((entry) => ({ value: entry, label: entry }))}
          />
        </StudioField>
      ) : null}
      {caps.customVoiceId ? (
        <StudioField
          label={t("Your ElevenLabs voice")}
          hint={t("Paste a Voice ID from your ElevenLabs library")}
        >
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
      <StudioField
        label={t("Text")}
        hint={`${Math.min(text.length, caps.inputLimit)} / ${caps.inputLimit}`}
      >
        <textarea
          ref={textRef}
          className="studio-textarea"
          rows={7}
          value={text}
          maxLength={caps.inputLimit}
          placeholder={t("Type or paste the text to narrate")}
          onChange={(event) => setText(event.target.value)}
        />
      </StudioField>
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

  const action = busy ? (
    <div className="studio-progress">
      <Spinner aria-hidden />
      <span>{t("Narrating your text")}</span>
      <button type="button" className="btn btn-secondary" onClick={cancel}>
        {t("Cancel")}
      </button>
    </div>
  ) : waiting ? (
    <button type="button" className="btn btn-secondary" onClick={job.cancel}>
      {t("Stop waiting")}
    </button>
  ) : (
    <button
      type="button"
      className="studio-primary-button"
      disabled={!canSubmit}
      onClick={() => void generate()}
    >
      <span>{t("Generate speech")}</span>
      <CostHint credits={costCredits} />
    </button>
  );

  return (
    <GenerationLayout controls={controls} action={action}>
      {waiting ? (
        <Darkroom
          variant="audio"
          seed={(model?.id ?? "") + input}
          phase={waiting.phase}
          elapsedMs={waiting.phase === "queueing" ? undefined : waiting.elapsedMs}
          estimateMs={estimate}
          label={waiting.phase === "processing" ? t("Recording your voice-over") : undefined}
          meta={model?.id}
        />
      ) : null}
      {job.state.phase === "failed" ? (
        <JobFailureNotice
          message={job.state.message}
          status={job.state.status}
          model={model?.id}
          onRetry={job.canRetry ? job.retry : undefined}
        />
      ) : null}
      {error ? <p className="studio-error">{error}</p> : null}
      <GalleryStrip
        kind="speech"
        epoch={galleryEpoch}
        empty={
          !working ? (
            <EmptyState
              icon={<IconVoice2 size={22} />}
              title={t("No narrations yet")}
              description={t(
                "Type some text, pick a voice, and generate. Short texts render in seconds.",
              )}
            />
          ) : null
        }
      />
    </GenerationLayout>
  );
}
