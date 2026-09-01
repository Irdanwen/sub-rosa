import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMediaJob } from "../../../../lib/studio/async-job";
import {
  estimateCostCredits,
  formatCredits,
  modelsOfType,
  musicCapabilities,
  musicModels,
  soundEffectsModels,
} from "../../../../lib/studio/catalog";
import { musicPaths, retrieveBody } from "../../../../lib/studio/paths";
import { estimateRenderMs, renderEtaKey } from "../../../../lib/studio/render-eta";
import {
  generateSpeech,
  SPEECH_FORMATS,
  SPEECH_INPUT_LIMIT,
  SPEECH_SPEED,
  type SpeechFormat,
} from "../../../../lib/studio/speech";
import type { MediaCatalog } from "../../../../lib/studio/types";
import {
  registerDownloadedArtifact,
  saveArtifactFromBase64,
} from "../../../../lib/studio/artifacts";
import { hapticNotify } from "../../../../lib/haptics";
import { Darkroom } from "../../../studio/Darkroom";
import { JobFailureNotice } from "../../../studio/JobFailureNotice";
import { Spinner } from "../../../ui/Spinner";
import { ModelSheet } from "../../ModelSheet";
import { ModelPickerButton, pickEffective, StudioSetting, StudioToggle } from "./StudioControls";

/** Which of the three sound panels is showing. */
export type AudioMode = "music" | "speech" | "sfx";

/* Carpe Diem streams the finished track as the retrieve body (one shot);
 * Venice answers JSON with an `audio_url`. Both shapes must be accepted. */
const AUDIO_URL_FIELDS = ["audio_url", "url"];

/** Sound-effect prompts are short by nature and the endpoint says so. */
const SFX_PROMPT_LIMIT = 250;

/**
 * The three ways this app makes sound: a track, a voice, an effect.
 *
 * They share a shape -- pick a model, write a prompt, queue a job, poll it --
 * and differ in what each model demands (lyrics required, forbidden, or
 * optional). `AudioPanel` is only the switch between them.
 */
// --- Audio (music / speech / sound effects) -----------------------------------

export function AudioPanel({
  catalog,
  mode,
  onModeChange,
  onGenerated,
}: {
  catalog: MediaCatalog;
  mode: AudioMode;
  onModeChange: (mode: AudioMode) => void;
  onGenerated: () => void;
}) {
  return (
    <div className="mobile-studio-form">
      <div className="mobile-segmented" role="tablist" aria-label="Audio mode">
        {(["music", "speech", "sfx"] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={mode === entry}
            className="mobile-segmented-item"
            data-active={mode === entry ? "true" : undefined}
            onClick={() => onModeChange(entry)}
          >
            {entry === "music" ? "Music" : entry === "speech" ? "Speech" : "Effects"}
          </button>
        ))}
      </div>
      {mode === "music" ? (
        <MusicPanel catalog={catalog} onGenerated={onGenerated} />
      ) : mode === "speech" ? (
        <SpeechPanel catalog={catalog} onGenerated={onGenerated} />
      ) : (
        <SfxPanel catalog={catalog} onGenerated={onGenerated} />
      )}
    </div>
  );
}

export function SpeechPanel({
  catalog,
  onGenerated,
}: {
  catalog: MediaCatalog;
  onGenerated: () => void;
}) {
  const models = useMemo(() => modelsOfType(catalog, "tts"), [catalog]);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId) ?? models[0];
  const voices = model?.voices ?? [];
  const [voice, setVoice] = useState("");
  const effectiveVoice = pickEffective(voices, voice);
  const [text, setText] = useState("");
  const [speed, setSpeed] = useState(SPEECH_SPEED.default);
  const [format, setFormat] = useState<SpeechFormat>("mp3");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => abortRef.current?.abort(), []);

  const generate = useCallback(async () => {
    if (!model || !text.trim() || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      const input = text.trim().slice(0, SPEECH_INPUT_LIMIT);
      const { base64 } = await generateSpeech({
        model: model.id,
        input,
        voice: effectiveVoice || undefined,
        speed,
        format,
        signal: controller.signal,
      });
      await saveArtifactFromBase64(base64, format, {
        kind: "speech",
        model: model.id,
        prompt: input,
      });
      hapticNotify("success");
      onGenerated();
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        hapticNotify("error");
        setError(err instanceof Error ? err.message : "The narration failed.");
      }
    } finally {
      setBusy(false);
    }
  }, [model, text, busy, effectiveVoice, speed, format, onGenerated]);

  return (
    <>
      <ModelPickerButton
        label="Speech model"
        value={model?.name ?? ""}
        onOpen={() => setPickerOpen(true)}
      />
      {voices.length > 0 ? (
        <ModelPickerButton
          label="Voice"
          value={effectiveVoice}
          onOpen={() => setVoicePickerOpen(true)}
        />
      ) : null}
      <textarea
        className="mobile-studio-prompt"
        value={text}
        rows={4}
        maxLength={SPEECH_INPUT_LIMIT}
        placeholder="Text to narrate"
        aria-label="Text to narrate"
        onChange={(event) => setText(event.target.value)}
      />
      <div className="mobile-studio-field">
        <div className="mobile-studio-field-head">
          <span className="mobile-studio-field-label">Speed</span>
          <span className="mobile-studio-field-value">{`x${speed}`}</span>
        </div>
        <input
          type="range"
          className="mobile-studio-slider"
          min={SPEECH_SPEED.min}
          max={SPEECH_SPEED.max}
          step={SPEECH_SPEED.step}
          value={speed}
          aria-label="Speed"
          onChange={(event) => setSpeed(Number(event.target.value))}
        />
      </div>
      <StudioSetting label="Format">
        <div className="mobile-pill-row" role="radiogroup" aria-label="Audio format">
          {SPEECH_FORMATS.map((entry) => (
            <button
              key={entry}
              type="button"
              className="mobile-pill"
              data-active={format === entry ? "true" : undefined}
              onClick={() => setFormat(entry)}
            >
              {entry}
            </button>
          ))}
        </div>
      </StudioSetting>
      <button
        type="button"
        className="mobile-studio-generate"
        disabled={!model || !text.trim() || busy}
        onClick={() => void generate()}
      >
        {busy ? <Spinner /> : "Generate"}
      </button>
      {busy ? (
        <button
          type="button"
          className="mobile-chip-button"
          onClick={() => abortRef.current?.abort()}
        >
          Cancel
        </button>
      ) : null}
      {error ? <p className="mobile-dictation-error">{error}</p> : null}
      {pickerOpen ? (
        <ModelSheet
          title="Speech model"
          entries={models.map((entry) => ({
            id: entry.id,
            name: entry.name,
            subtitle: [entry.tier, entry.privacy].filter(Boolean).join(" · "),
          }))}
          selectedId={model?.id ?? ""}
          onSelect={(id) => {
            if (id) setModelId(id);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
      {voicePickerOpen ? (
        <ModelSheet
          title="Voice"
          entries={voices.map((entry) => ({ id: entry, name: entry, subtitle: "" }))}
          selectedId={effectiveVoice}
          onSelect={(id) => {
            if (id) setVoice(id);
            setVoicePickerOpen(false);
          }}
          onClose={() => setVoicePickerOpen(false)}
        />
      ) : null}
    </>
  );
}

export function SfxPanel({
  catalog,
  onGenerated,
}: {
  catalog: MediaCatalog;
  onGenerated: () => void;
}) {
  const models = useMemo(() => soundEffectsModels(catalog), [catalog]);
  const paths = musicPaths(catalog.backend);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId) ?? models[0];
  const caps = musicCapabilities(model?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [autoDuration, setAutoDuration] = useState(true);
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [pickerOpen, setPickerOpen] = useState(false);

  // The file is already in the gallery directory (Rust downloaded it, possibly
  // while the app was closed); indexing it is all that is left.
  const job = useMediaJob("sfx", (artifact, finished) => {
    registerDownloadedArtifact(artifact, {
      kind: "sfx",
      model: finished.model,
      prompt: finished.prompt,
    });
    hapticNotify("success");
    onGenerated();
  });

  const duration = caps.durationSeconds
    ? Math.min(Math.max(durationSeconds, caps.durationSeconds.min), caps.durationSeconds.max)
    : durationSeconds;
  const cost = model
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
  const estimate = useMemo(() => estimateRenderMs(renderEtaKey("sfx", model?.id)), [model?.id]);

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

  return (
    <>
      <ModelPickerButton
        label="Effect model"
        value={model?.name ?? ""}
        onOpen={() => setPickerOpen(true)}
      />
      <textarea
        className="mobile-studio-prompt"
        value={prompt}
        rows={2}
        maxLength={SFX_PROMPT_LIMIT}
        placeholder="Describe a short sound (a door creak, rain on glass)"
        onChange={(event) => setPrompt(event.target.value)}
      />
      <StudioToggle label="Auto duration" checked={autoDuration} onChange={setAutoDuration} />
      {!autoDuration && caps.durationSeconds ? (
        <div className="mobile-studio-field">
          <div className="mobile-studio-field-head">
            <span className="mobile-studio-field-label">Duration</span>
            <span className="mobile-studio-field-value">{`${duration}s`}</span>
          </div>
          <input
            type="range"
            className="mobile-studio-slider"
            min={caps.durationSeconds.min}
            max={caps.durationSeconds.max}
            step={caps.durationSeconds.step}
            value={duration}
            aria-label="Duration"
            onChange={(event) => setDurationSeconds(Number(event.target.value))}
          />
        </div>
      ) : null}
      <button
        type="button"
        className="mobile-studio-generate"
        disabled={!model || !prompt.trim() || busy}
        onClick={start}
      >
        {busy ? <Spinner /> : "Generate"}
        {!busy && cost !== undefined ? (
          <span className="mobile-studio-cost">{formatCredits(cost)}</span>
        ) : null}
      </button>
      {waiting ? (
        <Darkroom
          compact
          variant="audio"
          seed={`${model?.id ?? ""}${prompt}`}
          phase={waiting.phase}
          elapsedMs={waiting.phase === "queueing" ? undefined : waiting.elapsedMs}
          estimateMs={estimate}
          meta="You can leave this tab; the job resumes."
        />
      ) : null}
      {job.state.phase === "failed" ? (
        <JobFailureNotice
          message={job.state.message}
          status={job.state.status}
          model={model?.id}
          className="mobile-dictation-error"
          retryClassName="mobile-chip-button"
          onRetry={job.canRetry ? job.retry : undefined}
        />
      ) : null}
      {pickerOpen ? (
        <ModelSheet
          title="Effect model"
          entries={models.map((entry) => ({
            id: entry.id,
            name: entry.name,
            subtitle: [entry.tier, entry.privacy].filter(Boolean).join(" · "),
          }))}
          selectedId={model?.id ?? ""}
          onSelect={(id) => {
            if (id) setModelId(id);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </>
  );
}

export function MusicPanel({
  catalog,
  onGenerated,
}: {
  catalog: MediaCatalog;
  onGenerated: () => void;
}) {
  const models = useMemo(() => musicModels(catalog), [catalog]);
  const paths = musicPaths(catalog.backend);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId) ?? models[0];
  const caps = musicCapabilities(model?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [instrumental, setInstrumental] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // The file is already in the gallery directory (Rust downloaded it, possibly
  // while the app was closed); indexing it is all that is left.
  const job = useMediaJob("music", (artifact, finished) => {
    registerDownloadedArtifact(artifact, {
      kind: "music",
      model: finished.model,
      prompt: finished.prompt,
    });
    hapticNotify("success");
    onGenerated();
  });

  const duration = caps.durationSeconds
    ? Math.min(Math.max(60, caps.durationSeconds.min), caps.durationSeconds.max)
    : undefined;
  const cost = model
    ? estimateCostCredits(model, { durationSeconds: duration, multiplier: catalog.priceMultiplier })
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
  const estimate = useMemo(() => estimateRenderMs(renderEtaKey("music", model?.id)), [model?.id]);

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

  return (
    <>
      <ModelPickerButton
        label="Music model"
        value={model?.name ?? ""}
        onOpen={() => setPickerOpen(true)}
      />
      <textarea
        className="mobile-studio-prompt"
        value={prompt}
        rows={2}
        placeholder="Describe the track (style, mood, tempo)"
        onChange={(event) => setPrompt(event.target.value)}
      />
      {caps.lyrics !== "none" ? (
        <>
          {caps.instrumental ? (
            <StudioToggle
              label="Instrumental (no vocals)"
              checked={instrumental}
              onChange={setInstrumental}
            />
          ) : null}
          {!instrumental ? (
            <textarea
              className="mobile-studio-prompt"
              value={lyrics}
              rows={3}
              placeholder={caps.lyrics === "required" ? "Lyrics (required)" : "Lyrics (optional)"}
              onChange={(event) => setLyrics(event.target.value)}
            />
          ) : null}
        </>
      ) : null}
      <button
        type="button"
        className="mobile-studio-generate"
        disabled={!model || !prompt.trim() || lyricsMissing || busy}
        onClick={start}
      >
        {busy ? <Spinner /> : "Generate"}
        {!busy && cost !== undefined ? (
          <span className="mobile-studio-cost">{formatCredits(cost)}</span>
        ) : null}
      </button>
      {waiting ? (
        <Darkroom
          compact
          variant="audio"
          seed={`${model?.id ?? ""}${prompt}`}
          phase={waiting.phase}
          elapsedMs={waiting.phase === "queueing" ? undefined : waiting.elapsedMs}
          estimateMs={estimate}
          label={waiting.phase === "processing" ? "Composing your track" : undefined}
          meta="You can leave this tab; the job resumes."
        />
      ) : null}
      {job.state.phase === "failed" ? (
        <JobFailureNotice
          message={job.state.message}
          status={job.state.status}
          model={model?.id}
          className="mobile-dictation-error"
          retryClassName="mobile-chip-button"
          onRetry={job.canRetry ? job.retry : undefined}
        />
      ) : null}
      {pickerOpen ? (
        <ModelSheet
          title="Music model"
          entries={models.map((entry) => ({
            id: entry.id,
            name: entry.name,
            subtitle: [entry.tier, entry.privacy].filter(Boolean).join(" · "),
          }))}
          selectedId={model?.id ?? ""}
          onSelect={(id) => {
            if (id) setModelId(id);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </>
  );
}
