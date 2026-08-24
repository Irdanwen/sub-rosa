/**
 * SubRip subtitles, written next to the timeline rather than burned in.
 *
 * The reference design burns subtitles into the master with an ffmpeg filter.
 * A sidecar costs nothing, is editable, is what an NLE expects to be handed,
 * and does not need the dependency the app spends real effort not having. The
 * only thing it gives up is a hardcoded look, which is a decision the edit
 * should be making anyway.
 */

import { srtTimecode } from "./timebase";
import type { TimelineSubtitle } from "./types";

export function toSrt(subtitles: readonly TimelineSubtitle[]): string {
  return subtitles
    .filter((cue) => cue.text.trim().length > 0 && cue.untilSeconds > cue.atSeconds)
    .map((cue, index) => {
      const text = cue.text.trim().replace(/\r\n/g, "\n");
      return `${index + 1}\n${srtTimecode(cue.atSeconds)} --> ${srtTimecode(
        cue.untilSeconds,
      )}\n${text}\n`;
    })
    .join("\n");
}
