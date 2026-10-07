// The cloned voices made for one engine, for the speech panels (ADR-0077).
// Read only when the engine clones; a failure leaves the list empty rather
// than breaking the panel.

import { useCallback, useEffect, useState } from "react";
import { type ClonedVoice, clonedVoiceRef, listClonedVoices } from "./cloned-voices";

export function useClonedVoices(modelId: string | undefined, clones: boolean) {
  const [voices, setVoices] = useState<ClonedVoice[]>([]);
  const reload = useCallback(async () => {
    if (!clones || !modelId) {
      setVoices([]);
      return;
    }
    try {
      const all = await listClonedVoices();
      setVoices(all.filter((voice) => voice.model === modelId));
    } catch {
      setVoices([]);
    }
  }, [clones, modelId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return {
    voices,
    reload,
    /** As voice options: the stable reference, and the name the person gave. */
    options: voices.map((voice) => ({ value: clonedVoiceRef(voice.id), label: voice.name })),
  };
}
