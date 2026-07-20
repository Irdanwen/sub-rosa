// Speech studio: text to speech as a first-class surface (not just the
// workflow node). Synchronous - one /audio/speech call returns the bytes.

import { IconVoice2 } from "central-icons/IconVoice2";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { saveArtifactFromBase64 } from "../../lib/studio/artifacts";
import { modelsOfType } from "../../lib/studio/catalog";
import {
  generateSpeech,
  SPEECH_FORMATS,
  SPEECH_INPUT_LIMIT,
  SPEECH_SPEED,
  type SpeechFormat,
} from "../../lib/studio/speech";
import type { MediaCatalog } from "../../lib/studio/types";
import { EmptyState } from "../ui/EmptyState";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { GalleryStrip } from "./GalleryStrip";
import { GenerationLayout } from "./GenerationLayout";
import { effectiveOption, ModelSelect, PillGroup, SliderField, StudioField } from "./controls";

export function SpeechStudio({ catalog }: { catalog: MediaCatalog }) {
  const models = useMemo(() => modelsOfType(catalog, "tts"), [catalog]);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId) ?? models[0];

  const voices = model?.voices ?? [];
  const [voice, setVoice] = useState("");
  const effectiveVoice = effectiveOption(voices, voice);

  const [text, setText] = useState("");
  const [speed, setSpeed] = useState(SPEECH_SPEED.default);
  const [format, setFormat] = useState<SpeechFormat>("mp3");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [galleryEpoch, setGalleryEpoch] = useState(0);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => abortRef.current?.abort(), []);

  const canSubmit = Boolean(model && text.trim()) && !busy;

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
      setGalleryEpoch((epoch) => epoch + 1);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "The narration failed.");
      }
    } finally {
      setBusy(false);
    }
  }, [model, text, busy, effectiveVoice, speed, format]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const controls = (
    <>
      <StudioField label="Model">
        <ModelSelect
          models={models}
          value={model?.id ?? null}
          onChange={setModelId}
          ariaLabel="Speech model"
        />
      </StudioField>
      {voices.length > 0 ? (
        <StudioField label="Voice">
          <Select
            value={effectiveVoice || null}
            placeholder="Choose a voice"
            ariaLabel="Voice"
            onChange={setVoice}
            options={voices.map((entry) => ({ value: entry, label: entry }))}
          />
        </StudioField>
      ) : null}
      <StudioField
        label="Text"
        hint={`${Math.min(text.length, SPEECH_INPUT_LIMIT)} / ${SPEECH_INPUT_LIMIT}`}
      >
        <textarea
          className="studio-textarea"
          rows={7}
          value={text}
          maxLength={SPEECH_INPUT_LIMIT}
          placeholder="Type or paste the text to narrate"
          onChange={(event) => setText(event.target.value)}
        />
      </StudioField>
      <SliderField
        label="Speed"
        min={SPEECH_SPEED.min}
        max={SPEECH_SPEED.max}
        step={SPEECH_SPEED.step}
        value={speed}
        onChange={setSpeed}
        format={(value) => `x${value}`}
      />
      <StudioField label="Format">
        <PillGroup
          options={SPEECH_FORMATS.map((entry) => ({ value: entry }))}
          value={format}
          onChange={setFormat}
          ariaLabel="Audio format"
        />
      </StudioField>
    </>
  );

  const action = busy ? (
    <div className="studio-progress">
      <Spinner aria-hidden />
      <span>Narrating your text</span>
      <button type="button" className="btn btn-secondary" onClick={cancel}>
        Cancel
      </button>
    </div>
  ) : (
    <button
      type="button"
      className="studio-primary-button"
      disabled={!canSubmit}
      onClick={() => void generate()}
    >
      <span>Generate speech</span>
    </button>
  );

  return (
    <GenerationLayout controls={controls} action={action}>
      {error ? <p className="studio-error">{error}</p> : null}
      <GalleryStrip
        kind="speech"
        epoch={galleryEpoch}
        empty={
          !busy ? (
            <EmptyState
              icon={<IconVoice2 size={22} />}
              title="No narrations yet"
              description="Type some text, pick a voice, and generate. Short texts render in seconds."
            />
          ) : null
        }
      />
    </GenerationLayout>
  );
}
