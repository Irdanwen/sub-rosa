import { t } from "./i18n";
import type { SourceWarningDto } from "./tauri";

/**
 * The sentence the recorder shows for a warning Rust raised during a take.
 * Rust sends a code and an English message; the code decides the sentence
 * here so it reads in the person's language. An unknown code from a newer
 * capture still says something true, in the words Rust chose.
 */
export function recordingWarningMessage(warning: SourceWarningDto): string {
  switch (warning.code) {
    case "microphone_stream_error":
    case "microphone_stream_stalled":
      return t("Microphone input stopped unexpectedly. Audio after this point may be missing.");
    case "system_audio_silent":
      return t(
        "No sound from the computer yet. Check that the call or video plays on this computer.",
      );
    default:
      return t(warning.message);
  }
}
