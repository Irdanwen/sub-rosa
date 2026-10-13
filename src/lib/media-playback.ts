import { isIosPlatform } from "./mobile";
import { setPlaybackAudioSession } from "./tauri";

/** Best-effort iOS audio-session flip around media playback: `.playback`
 * keeps generated music/video audible past the lock screen and the silent
 * switch. No-op off iOS (the command only exists there). */
export function markMediaPlayback(active: boolean) {
  if (!isIosPlatform()) return;
  void setPlaybackAudioSession(active).catch(() => undefined);
}
