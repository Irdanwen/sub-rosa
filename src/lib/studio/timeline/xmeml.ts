/**
 * Premiere Pro xmeml v5: the same cut, in the dialect Adobe reads.
 *
 * Everything counts in whole frames here rather than in rationals, which
 * removes one class of error and adds another: `start`/`end` are positions on
 * the timeline and `in`/`out` are positions inside the source file, and the two
 * pairs must describe the same length. A file where they disagree imports with
 * clips at plausible but wrong lengths, which is the kind of bug someone finds
 * three hours into an edit.
 *
 * A `<file>` is declared in full the first time it appears and referenced by id
 * afterwards. Declaring it twice makes Premiere import the media twice.
 */

import { toFrames, xmemlTimebase } from "./timebase";
import { AUDIO_LANES, type TimelineCut } from "./types";
import { assertWritable } from "./validate";
import { escapeXml } from "./xml";

export function toXmeml(cut: TimelineCut): string {
  assertWritable(cut);
  const rate = cut.frameRate;
  const { timebase, ntsc } = xmemlTimebase(rate);
  const rateXml = `<rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>`;

  const seenFiles = new Map<string, string>();
  let fileCounter = 0;
  let itemCounter = 0;

  /** Full declaration the first time, a bare reference after that. */
  const fileXml = (href: string, name: string, durationFrames: number, hasAudio: boolean) => {
    const existing = seenFiles.get(href);
    if (existing) return `<file id="${existing}"/>`;
    fileCounter += 1;
    const id = `file-${fileCounter}`;
    seenFiles.set(href, id);
    const audio = hasAudio
      ? "<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>"
      : "";
    return [
      `<file id="${id}">`,
      `<name>${escapeXml(name)}</name>`,
      `<pathurl>${escapeXml(href)}</pathurl>`,
      rateXml,
      `<duration>${durationFrames}</duration>`,
      `<media><video><samplecharacteristics>${rateXml}<width>${cut.width}</width><height>${cut.height}</height></samplecharacteristics></video>${audio}</media>`,
      "</file>",
    ].join("");
  };

  /** Premiere carries a clip's level as an effect, not an attribute. */
  const levelFilter = (gain: number) =>
    [
      "<filter><effect>",
      "<name>Audio Levels</name><effectid>audiolevels</effectid>",
      "<effecttype>audiolevels</effecttype><mediatype>audio</mediatype>",
      "<pproBypass>false</pproBypass>",
      '<parameter authoringApp="PremierePro">',
      "<parameterid>level</parameterid><name>Level</name>",
      "<valuemin>0</valuemin><valuemax>3.98107</valuemax>",
      `<value>${Math.max(0, Math.min(3.98107, gain))}</value>`,
      "</parameter></effect></filter>",
    ].join("");

  let spineFrames = 0;
  const videoItems = cut.clips.map((clip) => {
    const inFrames = toFrames(clip.inSeconds, rate);
    const durationFrames = toFrames(clip.outSeconds - clip.inSeconds, rate);
    const sourceFrames = toFrames(clip.sourceDurationSeconds, rate);
    const start = spineFrames;
    spineFrames += durationFrames;
    itemCounter += 1;
    return [
      `        <clipitem id="clipitem-${itemCounter}">`,
      `          <name>${escapeXml(clip.name)}</name>`,
      `          <duration>${sourceFrames}</duration>`,
      `          ${rateXml}`,
      `          <start>${start}</start><end>${spineFrames}</end>`,
      `          <in>${inFrames}</in><out>${inFrames + durationFrames}</out>`,
      `          ${fileXml(clip.href, clip.name, sourceFrames, clip.hasAudio)}`,
      "        </clipitem>",
    ].join("\n");
  });

  const audioTracks = AUDIO_LANES.map((lane) => {
    const clips = cut.audio?.[lane] ?? [];
    if (clips.length === 0) return undefined;
    const items = clips.flatMap((clip) => {
      const durationFrames = toFrames(clip.outSeconds - clip.inSeconds, rate);
      if (durationFrames < 1) return [];
      const inFrames = toFrames(clip.inSeconds, rate);
      const start = toFrames(clip.atSeconds, rate);
      const sourceFrames = toFrames(clip.sourceDurationSeconds, rate);
      itemCounter += 1;
      return [
        [
          `        <clipitem id="clipitem-${itemCounter}">`,
          `          <name>${escapeXml(clip.name)}</name>`,
          `          <duration>${sourceFrames}</duration>`,
          `          ${rateXml}`,
          `          <start>${start}</start><end>${start + durationFrames}</end>`,
          `          <in>${inFrames}</in><out>${inFrames + durationFrames}</out>`,
          `          ${fileXml(clip.href, clip.name, sourceFrames, true)}`,
          "          <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>",
          typeof clip.gain === "number" && clip.gain !== 1
            ? `          ${levelFilter(clip.gain)}`
            : undefined,
          "        </clipitem>",
        ]
          .filter((line) => line !== undefined)
          .join("\n"),
      ];
    });
    if (items.length === 0) return undefined;
    return `      <track>\n${items.join("\n")}\n      </track>`;
  }).filter((track): track is string => track !== undefined);

  const audioXml =
    audioTracks.length === 0
      ? ""
      : `\n    <audio>\n      <format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>\n${audioTracks.join(
          "\n",
        )}\n    </audio>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="sequence-1">
    <name>${escapeXml(cut.name)}</name>
    <duration>${spineFrames}</duration>
    ${rateXml}
    <media>
    <video>
      <format><samplecharacteristics>${rateXml}<width>${cut.width}</width><height>${cut.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>
      <track>
${videoItems.join("\n")}
      </track>
    </video>${audioXml}
    </media>
  </sequence>
</xmeml>
`;
}
