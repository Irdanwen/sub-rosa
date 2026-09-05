// Audio tab: music, speech, and sound effects behind one mode switch. Each
// mode is its own studio; this wrapper only remembers which one is active.

import { t } from "../../lib/i18n";
import { useEffect, useState } from "react";
import type { MediaCatalog } from "../../lib/studio/types";
import { SegmentedControl } from "../ui/SegmentedControl";
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
}: {
  catalog: MediaCatalog;
  requestedMode?: AudioMode;
}) {
  const [mode, setMode] = useState<AudioMode>(() => requestedMode ?? initialMode());

  useEffect(() => {
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      // Mode memory is a nicety, not state.
    }
  }, [mode]);

  return (
    <div className="studio-audio">
      <SegmentedControl
        value={mode}
        onValueChange={setMode}
        aria-label={t("Audio mode")}
        options={[
          { value: "music", label: t("Music") },
          { value: "speech", label: t("Speech") },
          { value: "sfx", label: t("Sound effects") },
        ]}
      />
      {mode === "music" ? (
        <MusicStudio catalog={catalog} />
      ) : mode === "speech" ? (
        <SpeechStudio catalog={catalog} />
      ) : (
        <SoundFxStudio catalog={catalog} />
      )}
    </div>
  );
}
