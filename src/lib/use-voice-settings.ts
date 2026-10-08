// What the "Voice" settings show on either shell: the engines that can read
// aloud, the one in use and its voices, and a short preview in that voice.
// The choice itself lives in voice-preference.ts, which every reader asks.

import { useCallback, useEffect, useRef, useState } from "react";
import { messageFromError } from "./errors";
import { t } from "./i18n";
import type { MediaModel } from "./studio/types";
import {
  fetchReadAloudEngines,
  renderPreferredSpeech,
  resolveSpeechVoice,
  setVoicePreference,
  useVoicePreference,
} from "./voice-preference";

export type VoicePreviewStatus = "idle" | "loading" | "playing" | "failed";

export function useVoiceSettings() {
  const preference = useVoicePreference();
  const [engines, setEngines] = useState<MediaModel[] | null>(null);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<VoicePreviewStatus>("idle");
  const playing = useRef<{ audio: HTMLAudioElement; controller: AbortController } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchReadAloudEngines()
      .then((found) => {
        if (!cancelled) setEngines(found);
      })
      .catch((caught) => {
        if (!cancelled) setError(messageFromError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const stopPreview = useCallback(() => {
    playing.current?.controller.abort();
    playing.current?.audio.pause();
    playing.current = null;
    setPreview("idle");
  }, []);

  // Leaving the screen, or choosing another voice, stops the one speaking.
  useEffect(() => stopPreview, [stopPreview]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new choice is what stops the preview.
  useEffect(() => stopPreview(), [preference, stopPreview]);

  const current = engines ? resolveSpeechVoice(engines, preference) : undefined;

  async function togglePreview() {
    if (preview === "playing" || preview === "loading") {
      stopPreview();
      return;
    }
    const controller = new AbortController();
    const audio = new Audio();
    playing.current = { audio, controller };
    setPreview("loading");
    try {
      audio.src = await renderPreferredSpeech(
        t("Hello. This is the voice that reads your replies and notes aloud."),
        { signal: controller.signal },
      );
      if (playing.current?.audio !== audio) return;
      audio.addEventListener("ended", () => {
        if (playing.current?.audio === audio) stopPreview();
      });
      await audio.play();
      setPreview("playing");
    } catch {
      if (playing.current?.audio !== audio) return;
      playing.current = null;
      setPreview("failed");
    }
  }

  return {
    engines: engines ?? [],
    loading: engines === null && !error,
    error,
    current,
    chooseEngine: (modelId: string) => setVoicePreference({ model: modelId }),
    chooseVoice: (voice: string) =>
      current && setVoicePreference({ model: current.engine.id, voice }),
    preview,
    togglePreview: () => void togglePreview(),
  };
}
