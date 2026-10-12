// Audio tab: music, speech, and sound effects behind one mode switch, drawn
// above each desk's scene. Each mode is its own desk; this wrapper only
// remembers which one is active.

import { t } from "../../lib/i18n";
import { useEffect, useState } from "react";
import type { MediaCatalog } from "../../lib/studio/types";
import { DeskTools } from "./desk/StudioDesk";
import { MusicStudio } from "./MusicStudio";
import { SoundFxStudio } from "./SoundFxStudio";
import { SpeechStudio } from "./SpeechStudio";

export type AudioMode = "music" | "speech" | "sfx";

const MODE_STORAGE_KEY = "os-june:studio-audio-mode";

function initialMode(): AudioMode {
  try {
    const saved = window.localStorage.getItem(MODE_STORAGE_KEY);
    if (saved === "music" || saved === "speech" || saved === "sfx") return saved;
  } catch {
    // Fall through to the default.
  }
  return "music";
}

export function AudioStudio({
  catalog,
  requestedMode,
  onOpenGallery,
}: {
  catalog: MediaCatalog;
  requestedMode?: AudioMode;
  onOpenGallery?: () => void;
}) {
  const [mode, setMode] = useState<AudioMode>(() => requestedMode ?? initialMode());

  useEffect(() => {
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      // Mode memory is a nicety, not state.
    }
  }, [mode]);

  const tools = (
    <DeskTools
      value={mode}
      onChange={setMode}
      label={t("Audio mode")}
      options={[
        { value: "music", label: t("Music") },
        { value: "speech", label: t("Speech") },
        { value: "sfx", label: t("Sound effects") },
      ]}
    />
  );

  return mode === "music" ? (
    <MusicStudio catalog={catalog} tools={tools} onOpenGallery={onOpenGallery} />
  ) : mode === "speech" ? (
    <SpeechStudio catalog={catalog} tools={tools} onOpenGallery={onOpenGallery} />
  ) : (
    <SoundFxStudio catalog={catalog} tools={tools} onOpenGallery={onOpenGallery} />
  );
}
