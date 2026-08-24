/**
 * FCPXML 1.10: the cut as Final Cut Pro and DaVinci Resolve read it.
 *
 * This is the finishing path. The in-app assemble records the canvas in real
 * time through MediaRecorder, which is fine for a preview and is a ceiling for
 * anything else: it re-encodes, it takes as long as the film runs, and it
 * flattens every lane into one. An interchange file has none of those costs -
 * it is text - and it hands the grade, the transitions and the fine mix to a
 * tool built for them. That is the whole reason the app can keep refusing to
 * ship ffmpeg.
 *
 * Three things decide whether a generated FCPXML opens or is silently dropped.
 *
 * **Every time is a rational on the timeline's own denominator.** Mixing "3s"
 * and "90/30s" in one document is legal and is how a clip ends up a frame out.
 * See `./timebase`.
 *
 * **The spine is contiguous.** Each `asset-clip` offset is the sum of the
 * durations before it, in frames, not the accumulation of floating seconds.
 * A gap of one frame between two shots reads as an intentional black frame.
 *
 * **Connected clips are positioned in their parent's time, not the
 * timeline's.** Audio lanes attach to the first spine clip, so a lane clip's
 * offset is the parent's `start` plus its position on the timeline. Getting
 * this wrong puts the dialogue somewhere plausible but wrong, which is worse
 * than putting it nowhere.
 */

import { fcpFrameDuration, fcpTime, toFrames } from "./timebase";
import { AUDIO_LANES, type AudioLane, type TimelineCut } from "./types";
import { assertWritable } from "./validate";
import { attrs, escapeXml } from "./xml";

/** FCP's own names for the lanes, which drive its roles-based mixing. */
const AUDIO_ROLES: Record<AudioLane, string> = {
  dialogue: "dialogue",
  sfx: "effects",
  music: "music",
};

/**
 * A stable id for a media file.
 *
 * FCP matches media by `uid` across imports: two exports of the same cut must
 * agree, or reimporting makes a second copy of every asset in the library.
 * Derived from the href with a small non-cryptographic hash - this identifies,
 * it does not authenticate.
 */
function mediaUid(href: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < href.length; index += 1) {
    hash ^= href.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).toUpperCase().padStart(8, "0");
}

interface Asset {
  id: string;
  name: string;
  href: string;
  durationFrames: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

/** Writes the cut as an FCPXML 1.10 document. */
export function toFcpxml(cut: TimelineCut): string {
  assertWritable(cut);
  const rate = cut.frameRate;
  const formatId = "r0";

  // One asset per distinct file: the same clip used twice must not be declared
  // twice, or FCP imports it twice.
  const assets: Asset[] = [];
  const assetIdByHref = new Map<string, string>();
  const assetFor = (
    href: string,
    name: string,
    durationFrames: number,
    hasVideo: boolean,
    hasAudio: boolean,
  ): string => {
    const existing = assetIdByHref.get(href);
    if (existing) return existing;
    const id = `r${assets.length + 1}`;
    assets.push({ id, name, href, durationFrames, hasVideo, hasAudio });
    assetIdByHref.set(href, id);
    return id;
  };

  // Picture track, walked once so offsets accumulate in frames.
  let spineFrames = 0;
  const spineItems = cut.clips.map((clip) => {
    const startFrames = toFrames(clip.inSeconds, rate);
    const durationFrames = toFrames(clip.outSeconds - clip.inSeconds, rate);
    const sourceFrames = toFrames(clip.sourceDurationSeconds, rate);
    const ref = assetFor(clip.href, clip.name, sourceFrames, true, clip.hasAudio);
    const item = {
      ref,
      name: clip.name,
      offsetFrames: spineFrames,
      startFrames,
      durationFrames,
    };
    spineFrames += durationFrames;
    return item;
  });

  // Sound, hung off the first picture clip. `offset` is in the parent's time,
  // which begins at the parent's own `start` - see the header.
  const firstStartFrames = spineItems[0]?.startFrames ?? 0;
  const connected: string[] = [];
  AUDIO_LANES.forEach((lane, laneIndex) => {
    for (const clip of cut.audio?.[lane] ?? []) {
      const durationFrames = toFrames(clip.outSeconds - clip.inSeconds, rate);
      if (durationFrames < 1) continue;
      const ref = assetFor(
        clip.href,
        clip.name,
        toFrames(clip.sourceDurationSeconds, rate),
        false,
        true,
      );
      const parentOffset = firstStartFrames + toFrames(clip.atSeconds, rate);
      const body =
        typeof clip.gain === "number" && clip.gain !== 1
          ? `\n              <adjust-volume amount="${gainDb(clip.gain)}dB"/>\n            `
          : "";
      connected.push(
        `            <asset-clip ${attrs({
          ref,
          lane: -(laneIndex + 1),
          offset: fcpTime(parentOffset, rate),
          name: clip.name,
          start: fcpTime(toFrames(clip.inSeconds, rate), rate),
          duration: fcpTime(durationFrames, rate),
          audioRole: AUDIO_ROLES[lane],
        })}>${body}</asset-clip>`,
      );
    }
  });

  const resources = [
    `    <format ${attrs({
      id: formatId,
      name: `FFVideoFormat${cut.height}p${cut.frameRate.base}`,
      frameDuration: fcpFrameDuration(rate),
      width: cut.width,
      height: cut.height,
      colorSpace: "1-1-1 (Rec. 709)",
    })}/>`,
    ...assets.map(
      (asset) =>
        `    <asset ${attrs({
          id: asset.id,
          name: asset.name,
          uid: mediaUid(asset.href),
          start: "0s",
          duration: fcpTime(asset.durationFrames, rate),
          hasVideo: asset.hasVideo ? "1" : undefined,
          videoSources: asset.hasVideo ? "1" : undefined,
          hasAudio: asset.hasAudio ? "1" : undefined,
          audioSources: asset.hasAudio ? "1" : undefined,
          audioChannels: asset.hasAudio ? "2" : undefined,
          format: asset.hasVideo ? formatId : undefined,
        })}>\n      <media-rep ${attrs({
          kind: "original-media",
          src: asset.href,
        })}/>\n    </asset>`,
    ),
  ].join("\n");

  const spine = spineItems
    .map((item, index) => {
      const open = `          <asset-clip ${attrs({
        ref: item.ref,
        offset: fcpTime(item.offsetFrames, rate),
        name: item.name,
        start: fcpTime(item.startFrames, rate),
        duration: fcpTime(item.durationFrames, rate),
        format: formatId,
        tcFormat: "NDF",
      })}`;
      // Everything connected hangs off the first shot, so only it can be a
      // container. The rest close immediately.
      if (index !== 0 || connected.length === 0) return `${open}/>`;
      return `${open}>\n${connected.join("\n")}\n          </asset-clip>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
${resources}
  </resources>
  <library>
    <event name="${escapeXml(cut.name)}">
      <project name="${escapeXml(cut.name)}">
        <sequence ${attrs({
          format: formatId,
          duration: fcpTime(spineFrames, rate),
          tcStart: "0s",
          tcFormat: "NDF",
          audioLayout: "stereo",
          audioRate: "48k",
        })}>
        <spine>
${spine}
        </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

/**
 * A linear gain as the decibels FCP's volume adjustment wants.
 *
 * Silence has no logarithm, so a gain of zero becomes the floor rather than
 * `-Infinity` - which would be written into the document verbatim and would
 * make the whole file unreadable.
 */
export function gainDb(gain: number): string {
  if (!Number.isFinite(gain) || gain <= 0) return "-96";
  return (Math.round(20 * Math.log10(gain) * 100) / 100).toString();
}
