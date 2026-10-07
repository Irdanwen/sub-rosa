import { t } from "../../../../lib/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlayableMediaUrl } from "../../../../lib/artifact-media";
import { useMediaJob } from "../../../../lib/studio/async-job";
import {
  acceptedDuration,
  estimateCostCredits,
  musicCapabilities,
  musicModels,
  musicQueueBody,
  musicRequestMissing,
  soundEffectsModels,
  speechModels,
} from "../../../../lib/studio/catalog";
import { musicPaths, retrieveBody } from "../../../../lib/studio/paths";
import {
  estimateRenderMs,
  rememberRenderMs,
  renderEtaKey,
} from "../../../../lib/studio/render-eta";
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
  rememberVoiceId,
  speechCapabilities,
  type SpeechFormat,
} from "../../../../lib/studio/speech";
import type { MediaCatalog, StudioArtifact } from "../../../../lib/studio/types";
import {
  registerDownloadedArtifact,
  saveArtifactFromBase64,
} from "../../../../lib/studio/artifacts";
import { hapticNotify } from "../../../../lib/haptics";
import { JobFailureNotice } from "../../../studio/JobFailureNotice";
import type { StageWait } from "../../../studio/stage/Veil";
import { ModelSheet } from "../../ModelSheet";
import {
  DockSelectChip,
  ModelPickerButton,
  modelSubtitle,
  pickEffective,
  SelectRow,
  SettingsCard,
  StudioToggle,
} from "./StudioControls";
import { Dock, DockComposer } from "./StudioDock";
import { type StageResult, StudioStage, type StudioStageIdle } from "./StudioStage";

/** Which of the three sound panels is showing. */
export type AudioMode = "music" | "speech" | "sfx";

/* Carpe Diem streams the finished track as the retrieve body (one shot);
 * Venice answers JSON with an `audio_url`. Both shapes must be accepted. */
const AUDIO_URL_FIELDS = ["audio_url", "url"];

/** Sound-effect prompts are short by nature and the endpoint says so. */
const SFX_PROMPT_LIMIT = 250;

/** The scene's shape for a track: the darkroom's own, wide and low. */
const TRACK_ASPECT = "5:2";

/** The track on the scene: the one that landed in this session, else the one
 * recalled from the gallery on request. Before either, the canvas is blank:
 * the newest track used to sit there and read as the answer to a prompt not
 * written yet. */
function useSceneTrack(
  landed: StudioArtifact | undefined,
  lastTrack: StudioArtifact | undefined,
): { result: StageResult | undefined; idle: StudioStageIdle } {
  const [recalled, setRecalled] = useState<StudioArtifact | undefined>(undefined);
  const artifact = landed ?? recalled ?? null;
  const playable = usePlayableMediaUrl(artifact);
  const url = playable.src;
  const result: StageResult | undefined = url
    ? {
        kind: "audio",
        src: url,
        seed: artifact?.path ?? url.slice(-64),
        onError: playable.onError,
      }
    : undefined;
  const idle: StudioStageIdle = {
    seed: "audio",
    hint: t("Describe a sound. It will play here."),
    recall:
      lastTrack && !result
        ? { label: t("Last creation"), onRecall: () => setRecalled(lastTrack) }
        : undefined,
  };
  return { result, idle };
}

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
  galleryTracks = [],
  onWorking,
}: {
  catalog: MediaCatalog;
  mode: AudioMode;
  onModeChange: (mode: AudioMode) => void;
  onGenerated: () => void;
  /** Rendered music, speech and effects: the newest of a kind is what the
   * scene shows before anything is made in the session. */
  galleryTracks?: StudioArtifact[];
  /** Told when the synchronous narration starts and ends, so the tab can
   * show it in Recent: that path writes no job row to watch. */
  onWorking?: (working: boolean) => void;
}) {
  return (
    <div className="mobile-studio-form">
      <div className="mobile-segmented" role="tablist" aria-label={t("Audio mode")}>
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
            {entry === "music" ? t("Music") : entry === "speech" ? t("Speech") : t("Effects")}
          </button>
        ))}
      </div>
      {mode === "music" ? (
        <MusicPanel
          catalog={catalog}
          onGenerated={onGenerated}
          lastTrack={galleryTracks.find((entry) => entry.kind === "music")}
        />
      ) : mode === "speech" ? (
        <SpeechPanel
          catalog={catalog}
          onGenerated={onGenerated}
          lastTrack={galleryTracks.find((entry) => entry.kind === "speech")}
          onWorking={onWorking}
        />
      ) : (
        <SfxPanel
          catalog={catalog}
          onGenerated={onGenerated}
          lastTrack={galleryTracks.find((entry) => entry.kind === "sfx")}
        />
      )}
    </div>
  );
}

export function SpeechPanel({
  catalog,
  onGenerated,
  lastTrack,
  onWorking,
}: {
  catalog: MediaCatalog;
  onGenerated: () => void;
  lastTrack?: StudioArtifact;
  onWorking?: (working: boolean) => void;
}) {
  const models = useMemo(() => speechModels(catalog), [catalog]);
  const [modelId, setModelId] = useState("");
  const model = models.find((entry) => entry.id === modelId) ?? defaultSpeechModel(models);
  const caps = useMemo(() => speechCapabilities(model), [model]);
  const [voice, setVoice] = useState("");
  const listedVoice = pickEffective(caps.voices, voice) || caps.defaultVoice || "";
  const [voiceId, setVoiceId] = useState("");
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  /** The narration in progress, for the veil; and the one that last landed. */
  const [syncWait, setSyncWait] = useState<StageWait | undefined>(undefined);
  const [landed, setLanded] = useState<StudioArtifact | undefined>(undefined);
  const [reveal, setReveal] = useState(false);
  const scene = useSceneTrack(landed, lastTrack);

  // The queue rail is a durable job: the file lands even if the phone locks.
  const job = useMediaJob("speech", (artifact, finished) => {
    setLanded(
      registerDownloadedArtifact(artifact, {
        kind: "speech",
        model: finished.model,
        prompt: finished.prompt,
      }),
    );
    setReveal(true);
    hapticNotify("success");
    onGenerated();
  });
  const queueingSince = useRef(Date.now());
  const jobWaiting =
    job.state.phase === "queueing" ||
    job.state.phase === "queued" ||
    job.state.phase === "processing"
      ? job.state
      : undefined;
  const wait: StageWait | undefined =
    syncWait ??
    (jobWaiting
      ? {
          seed: `${model?.id ?? ""}${text}`,
          phase: jobWaiting.phase,
          startedAt: jobWaiting.phase === "queueing" ? queueingSince.current : jobWaiting.startedAt,
          estimateMs: estimateRenderMs(renderEtaKey("speech", model?.id)),
        }
      : undefined);
  const working = busy || Boolean(jobWaiting);
  useEffect(() => {
    onWorking?.(Boolean(wait));
  }, [wait, onWorking]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const input = text.trim().slice(0, caps.inputLimit);
  const cost =
    model && input
      ? estimateCostCredits(model, {
          characters: input.length,
          durationSeconds: estimatedSpeechSeconds(input.length),
          multiplier: catalog.priceMultiplier,
        })
      : undefined;

  const generate = useCallback(async () => {
    if (!model || !input || working) return;
    setError(null);
    if (caps.customVoiceId && voiceId.trim()) rememberVoiceId(voiceId);
    if (caps.rail === "queue") {
      queueingSince.current = Date.now();
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
    const etaKey = renderEtaKey("speech", model.id);
    const startedAt = Date.now();
    setSyncWait({
      seed: `${model.id}${text}`,
      phase: "processing",
      startedAt,
      estimateMs: estimateRenderMs(etaKey),
      label: t("Narrating"),
    });
    try {
      const { base64 } = await generateSpeech({
        model: model.id,
        input,
        voice: effectiveVoice,
        speed: effectiveSpeed,
        format,
        signal: controller.signal,
      });
      // Played from the saved file, never a data: URL: WKWebView leaves a
      // data: audio element silent, which is what this panel used to do.
      const saved = await saveArtifactFromBase64(base64, format, {
        kind: "speech",
        model: model.id,
        prompt: input,
      });
      rememberRenderMs(etaKey, Date.now() - startedAt);
      setLanded(saved);
      setReveal(true);
      hapticNotify("success");
      onGenerated();
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        hapticNotify("error");
        setError(err instanceof Error ? t(err.message) : t("The narration failed."));
      }
    } finally {
      setSyncWait(undefined);
      setBusy(false);
    }
  }, [
    model,
    input,
    text,
    working,
    caps,
    voiceId,
    job,
    catalog,
    effectiveVoice,
    effectiveSpeed,
    format,
    onGenerated,
  ]);

  return (
    <>
      <StudioStage
        aspect={TRACK_ASPECT}
        result={scene.result}
        idle={scene.idle}
        wait={wait}
        waitLabel={t("Narrating")}
        reveal={reveal}
        onRevealEnd={() => setReveal(false)}
      />
      <ModelPickerButton
        label={t("Speech model")}
        value={model?.name ?? ""}
        onOpen={() => setPickerOpen(true)}
      />
      {caps.voices.length > 0 ? (
        <ModelPickerButton
          label={t("Voice")}
          value={listedVoice}
          onOpen={() => setVoicePickerOpen(true)}
        />
      ) : null}
      {caps.customVoiceId ? (
        <div className="mobile-studio-field">
          <div className="mobile-studio-field-head">
            <span className="mobile-studio-field-label">{t("Your ElevenLabs voice")}</span>
          </div>
          <input
            className="mobile-studio-input"
            value={voiceId}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            placeholder={t("Voice ID (optional)")}
            aria-label={t("ElevenLabs Voice ID")}
            onChange={(event) => setVoiceId(event.target.value)}
          />
        </div>
      ) : null}
      {caps.speed && effectiveSpeed !== undefined ? (
        <div className="mobile-studio-field">
          <div className="mobile-studio-field-head">
            <span className="mobile-studio-field-label">{t("Speed")}</span>
            <span className="mobile-studio-field-value">{`x${Math.round(effectiveSpeed * 100) / 100}`}</span>
          </div>
          <input
            type="range"
            className="mobile-studio-slider"
            min={caps.speed.min}
            max={caps.speed.max}
            step={caps.speed.step}
            value={effectiveSpeed}
            aria-label={t("Speed")}
            onChange={(event) => setSpeed(Number(event.target.value))}
          />
        </div>
      ) : null}
      {caps.formats.length > 0 ? (
        <SettingsCard>
          <SelectRow
            label={t("Audio format")}
            value={format}
            options={[...caps.formats]}
            onChange={(next) => setFormat(next as typeof format)}
            format={(option) => option.toUpperCase()}
          />
        </SettingsCard>
      ) : null}
      {error ? <p className="mobile-dictation-error">{error}</p> : null}
      {job.state.phase === "failed" ? (
        <JobFailureNotice
          message={job.state.message}
          status={job.state.status}
          model={model?.id}
          backend={catalog.backend}
          className="mobile-job-failure"
          retryClassName="mobile-chip-button"
          onRetry={job.canRetry ? job.retry : undefined}
          onDismiss={job.reset}
        />
      ) : null}
      <Dock>
        <DockComposer
          value={text}
          onChange={(next) => setText(next.slice(0, caps.inputLimit))}
          placeholder={t("Text to narrate")}
          ariaLabel={t("Text to narrate")}
          cost={cost}
          canSend={Boolean(model && input)}
          busy={working}
          onSend={() => void generate()}
          sendLabel={t("Generate")}
          tools={
            busy ? (
              <button
                type="button"
                className="mobile-chip-button"
                onClick={() => abortRef.current?.abort()}
              >
                {t("Cancel")}
              </button>
            ) : caps.audioTags && !working ? (
              // One chip, so the send button and the price keep their place:
              // six tags in the row pushed both off the screen.
              <DockSelectChip
                label={t("Expression")}
                value=""
                options={[...AUDIO_TAGS]}
                format={(option) => option || t("Expression")}
                onChange={(tag) =>
                  setText((current) =>
                    insertTag(current, tag, current.length).text.slice(0, caps.inputLimit),
                  )
                }
              />
            ) : undefined
          }
          blocker={
            working
              ? undefined
              : !model
                ? { text: t("Choose a speech model first.") }
                : !text.trim()
                  ? { text: t("Write the text to narrate.") }
                  : undefined
          }
        />
      </Dock>
      {pickerOpen ? (
        <ModelSheet
          title={t("Speech model")}
          entries={models.map((entry) => ({
            id: entry.id,
            name: entry.name,
            subtitle: modelSubtitle(entry),
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
          title={t("Voice")}
          entries={caps.voices.map((entry) => ({ id: entry, name: entry, subtitle: "" }))}
          selectedId={listedVoice}
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
  lastTrack,
}: {
  catalog: MediaCatalog;
  onGenerated: () => void;
  lastTrack?: StudioArtifact;
}) {
  const models = useMemo(() => soundEffectsModels(catalog), [catalog]);
  const paths = musicPaths(catalog.backend);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId) ?? models[0];
  const caps = musicCapabilities(model);
  const [prompt, setPrompt] = useState("");
  const [autoDuration, setAutoDuration] = useState(true);
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [loop, setLoop] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // The file is already in the gallery directory (Rust downloaded it, possibly
  // while the app was closed); indexing it is all that is left.
  const [landed, setLanded] = useState<StudioArtifact | undefined>(undefined);
  const [reveal, setReveal] = useState(false);
  const job = useMediaJob("sfx", (artifact, finished) => {
    setLanded(
      registerDownloadedArtifact(artifact, {
        kind: "sfx",
        model: finished.model,
        prompt: finished.prompt,
      }),
    );
    setReveal(true);
    hapticNotify("success");
    onGenerated();
  });
  const scene = useSceneTrack(landed, lastTrack);

  const duration = acceptedDuration(caps, durationSeconds) ?? durationSeconds;
  const loopOn = caps.loop === true && loop;
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
  const queueingSince = useRef(Date.now());
  const wait: StageWait | undefined = waiting
    ? {
        seed: `${model?.id ?? ""}${prompt}`,
        phase: waiting.phase,
        startedAt: waiting.phase === "queueing" ? queueingSince.current : waiting.startedAt,
        estimateMs: estimate,
      }
    : undefined;

  const start = useCallback(() => {
    if (!model || !prompt.trim()) return;
    queueingSince.current = Date.now();
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

  return (
    <>
      <StudioStage
        aspect={TRACK_ASPECT}
        result={scene.result}
        idle={scene.idle}
        wait={wait}
        waitLabel={t("Rendering")}
        reveal={reveal}
        onRevealEnd={() => setReveal(false)}
      />
      <ModelPickerButton
        label={t("Effect model")}
        value={model?.name ?? ""}
        onOpen={() => setPickerOpen(true)}
      />
      {caps.loop ? (
        <StudioToggle label={t("Seamless loop")} checked={loop} onChange={setLoop} />
      ) : null}
      <StudioToggle label={t("Auto duration")} checked={autoDuration} onChange={setAutoDuration} />
      {!autoDuration && caps.durationSeconds ? (
        <div className="mobile-studio-field">
          <div className="mobile-studio-field-head">
            <span className="mobile-studio-field-label">{t("Duration")}</span>
            <span className="mobile-studio-field-value">{`${duration}s`}</span>
          </div>
          <input
            type="range"
            className="mobile-studio-slider"
            min={caps.durationSeconds.min}
            max={caps.durationSeconds.max}
            step={caps.durationSeconds.step}
            value={duration}
            aria-label={t("Duration")}
            onChange={(event) => setDurationSeconds(Number(event.target.value))}
          />
        </div>
      ) : null}
      {job.state.phase === "failed" ? (
        <JobFailureNotice
          message={job.state.message}
          status={job.state.status}
          model={model?.id}
          backend={catalog.backend}
          className="mobile-job-failure"
          retryClassName="mobile-chip-button"
          onRetry={job.canRetry ? job.retry : undefined}
          onDismiss={job.reset}
        />
      ) : null}
      <Dock>
        <DockComposer
          value={prompt}
          onChange={(next) => setPrompt(next.slice(0, SFX_PROMPT_LIMIT))}
          placeholder={t("Describe a short sound (a door creak, rain on glass)")}
          ariaLabel={t("Prompt")}
          cost={cost}
          canSend={Boolean(model && prompt.trim())}
          busy={busy}
          onSend={start}
          sendLabel={t("Generate")}
          blocker={
            busy
              ? undefined
              : !model
                ? { text: t("Choose an effect model first.") }
                : !prompt.trim()
                  ? { text: t("Describe the sound to generate it.") }
                  : undefined
          }
        />
      </Dock>
      {pickerOpen ? (
        <ModelSheet
          title={t("Effect model")}
          entries={models.map((entry) => ({
            id: entry.id,
            name: entry.name,
            subtitle: modelSubtitle(entry),
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
  lastTrack,
}: {
  catalog: MediaCatalog;
  onGenerated: () => void;
  lastTrack?: StudioArtifact;
}) {
  const models = useMemo(() => musicModels(catalog), [catalog]);
  const paths = musicPaths(catalog.backend);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId) ?? models[0];
  const caps = musicCapabilities(model);
  const [prompt, setPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [instrumental, setInstrumental] = useState(false);
  const [writeLyrics, setWriteLyrics] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // The file is already in the gallery directory (Rust downloaded it, possibly
  // while the app was closed); indexing it is all that is left.
  const [landed, setLanded] = useState<StudioArtifact | undefined>(undefined);
  const [reveal, setReveal] = useState(false);
  const job = useMediaJob("music", (artifact, finished) => {
    setLanded(
      registerDownloadedArtifact(artifact, {
        kind: "music",
        model: finished.model,
        prompt: finished.prompt,
      }),
    );
    setReveal(true);
    hapticNotify("success");
    onGenerated();
  });
  const scene = useSceneTrack(landed, lastTrack);

  // No length control on the phone: the model's own default length.
  const duration = acceptedDuration(caps, undefined);
  const instrumentalOn = caps.instrumental && instrumental;
  const writeLyricsOn = caps.lyricsOptimizer === true && writeLyrics && !instrumentalOn;
  const cost = model
    ? estimateCostCredits(model, { durationSeconds: duration, multiplier: catalog.priceMultiplier })
    : undefined;
  const lyricsMissing =
    musicRequestMissing(caps, {
      lyrics,
      instrumental: instrumentalOn,
      writeLyrics: writeLyricsOn,
    }) === "lyrics";
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
  const queueingSince = useRef(Date.now());
  const wait: StageWait | undefined = waiting
    ? {
        seed: `${model?.id ?? ""}${prompt}`,
        phase: waiting.phase,
        startedAt: waiting.phase === "queueing" ? queueingSince.current : waiting.startedAt,
        estimateMs: estimate,
      }
    : undefined;

  const start = useCallback(() => {
    if (!model || !prompt.trim()) return;
    queueingSince.current = Date.now();
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

  return (
    <>
      <StudioStage
        aspect={TRACK_ASPECT}
        result={scene.result}
        idle={scene.idle}
        wait={wait}
        waitLabel={t("Composing your track")}
        reveal={reveal}
        onRevealEnd={() => setReveal(false)}
      />
      <ModelPickerButton
        label={t("Music model")}
        value={model?.name ?? ""}
        onOpen={() => setPickerOpen(true)}
      />
      {caps.instrumental ? (
        <StudioToggle
          label={t("Instrumental (no vocals)")}
          checked={instrumental}
          onChange={setInstrumental}
        />
      ) : null}
      {caps.lyricsOptimizer && !instrumentalOn ? (
        <StudioToggle
          label={t("Write the lyrics for me")}
          checked={writeLyrics}
          onChange={setWriteLyrics}
        />
      ) : null}
      {caps.lyrics !== "none" && !instrumentalOn && !writeLyricsOn ? (
        <textarea
          className="mobile-studio-prompt"
          value={lyrics}
          rows={3}
          maxLength={caps.lyricsLimit}
          placeholder={caps.lyrics === "required" ? t("Lyrics (required)") : t("Lyrics (optional)")}
          onChange={(event) => setLyrics(event.target.value)}
        />
      ) : null}
      {job.state.phase === "failed" ? (
        <JobFailureNotice
          message={job.state.message}
          status={job.state.status}
          model={model?.id}
          backend={catalog.backend}
          className="mobile-job-failure"
          retryClassName="mobile-chip-button"
          onRetry={job.canRetry ? job.retry : undefined}
          onDismiss={job.reset}
        />
      ) : null}
      <Dock>
        <DockComposer
          value={prompt}
          onChange={setPrompt}
          placeholder={t("Describe the track (style, mood, tempo)")}
          ariaLabel={t("Prompt")}
          cost={cost}
          canSend={Boolean(model && prompt.trim()) && !lyricsMissing}
          busy={busy}
          onSend={start}
          sendLabel={t("Generate")}
          blocker={
            busy
              ? undefined
              : !model
                ? { text: t("Choose a music model first.") }
                : !prompt.trim()
                  ? { text: t("Describe the track to generate it.") }
                  : lyricsMissing
                    ? { text: t("Write the lyrics, or make it instrumental.") }
                    : undefined
          }
        />
      </Dock>
      {pickerOpen ? (
        <ModelSheet
          title={t("Music model")}
          entries={models.map((entry) => ({
            id: entry.id,
            name: entry.name,
            subtitle: modelSubtitle(entry),
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
