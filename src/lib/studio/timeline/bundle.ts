/**
 * Turning what a Studio surface has into a timeline bundle on disk.
 *
 * The generators in this folder are deliberately platform-free. This is the
 * one place that knows about artifacts, about Tauri, and about where a bundle
 * ends up - so the formats stay testable and this stays thin.
 *
 * **Media is referenced relatively.** A bundle carries copies of its clips in
 * `media/`, and the document points at `media/<file>`. That is what makes the
 * folder something you can hand to somebody. It is also the only thing that
 * can work here: Rust picks the final folder name (it refuses to overwrite an
 * earlier export), so the document is written before anyone knows the absolute
 * path it will live at.
 */

import { invoke } from "@tauri-apps/api/core";
import type { StudioArtifact } from "../types";
import { toSrt } from "./srt";
import { DEFAULT_FRAME_RATE, type FrameRate } from "./timebase";
import {
  type AudioLane,
  TIMELINE_FORMAT_EXTENSIONS,
  type TimelineAudioClip,
  type TimelineCut,
  type TimelineFormat,
  type TimelineSubtitle,
} from "./types";
import { toTimeline } from "./index";

/** Where copied media sits inside a bundle. Must match the Rust side. */
export const MEDIA_SUBDIR = "media";

/** A shot on its way into a bundle: a gallery file plus its trims. */
export interface BundleClip {
  artifact: StudioArtifact;
  name: string;
  inSeconds: number;
  outSeconds: number;
  /** Measured, not guessed. An unmeasured clip is refused by `validate`. */
  sourceDurationSeconds: number;
  hasAudio: boolean;
}

/** A sound on its way into a bundle. */
export interface BundleAudioClip {
  artifact: StudioArtifact;
  name: string;
  inSeconds: number;
  outSeconds: number;
  sourceDurationSeconds: number;
  atSeconds: number;
  gain?: number;
}

export interface BundleInput {
  name: string;
  clips: BundleClip[];
  audio?: Partial<Record<AudioLane, BundleAudioClip[]>>;
  subtitles?: TimelineSubtitle[];
  frameRate?: FrameRate;
  width?: number;
  height?: number;
}

/** The href a bundled file gets. Encoded: a URL is a URL even when local. */
function bundleHref(artifact: StudioArtifact): string {
  return `${MEDIA_SUBDIR}/${encodeURIComponent(artifact.fileName)}`;
}

/** The cut, plus the gallery paths Rust has to copy next to it. */
export function bundleCut(input: BundleInput): { cut: TimelineCut; media: string[] } {
  const toAudio = (clip: BundleAudioClip): TimelineAudioClip => ({
    name: clip.name,
    href: bundleHref(clip.artifact),
    inSeconds: clip.inSeconds,
    outSeconds: clip.outSeconds,
    sourceDurationSeconds: clip.sourceDurationSeconds,
    atSeconds: clip.atSeconds,
    gain: clip.gain,
  });

  const audio = Object.fromEntries(
    Object.entries(input.audio ?? {})
      .map(([lane, clips]) => [lane, (clips ?? []).map(toAudio)] as const)
      .filter(([, clips]) => clips.length > 0),
  ) as Partial<Record<AudioLane, TimelineAudioClip[]>>;

  const cut: TimelineCut = {
    name: input.name,
    frameRate: input.frameRate ?? DEFAULT_FRAME_RATE,
    width: input.width ?? 1920,
    height: input.height ?? 1080,
    clips: input.clips.map((clip) => ({
      name: clip.name,
      href: bundleHref(clip.artifact),
      inSeconds: clip.inSeconds,
      outSeconds: clip.outSeconds,
      sourceDurationSeconds: clip.sourceDurationSeconds,
      hasAudio: clip.hasAudio,
    })),
    audio: Object.keys(audio).length > 0 ? audio : undefined,
    subtitles: input.subtitles,
  };

  // One copy per file, in first-use order, so a clip used twice is copied once.
  const media: string[] = [];
  const seen = new Set<string>();
  const remember = (artifact: StudioArtifact) => {
    if (seen.has(artifact.path)) return;
    seen.add(artifact.path);
    media.push(artifact.path);
  };
  for (const clip of input.clips) remember(clip.artifact);
  for (const clips of Object.values(input.audio ?? {})) {
    for (const clip of clips ?? []) remember(clip.artifact);
  }

  return { cut, media };
}

export interface ExportedTimeline {
  directory: string;
  documentPath: string;
  mediaCount: number;
  /** True when the user dismissed the folder picker and nothing was written. */
  cancelled: boolean;
}

/**
 * Write the bundle where the user picks, in the chosen dialect.
 *
 * The folder picker opens in Rust, so no destination crosses IPC: a directory
 * chosen in the webview would make the export an arbitrary directory-write.
 * A dismissed picker resolves with `cancelled: true` and nothing on disk.
 *
 * Throws with everything wrong at once if the cut is not writable, before any
 * file is created - a half-written bundle is worse than no bundle.
 */
export async function writeTimelineBundle(
  input: BundleInput,
  format: TimelineFormat,
): Promise<ExportedTimeline> {
  const { cut, media } = bundleCut(input);
  const document = toTimeline(cut, format);
  const subtitles = cut.subtitles?.length ? toSrt(cut.subtitles) : undefined;
  return invoke<ExportedTimeline>("export_timeline_bundle", {
    request: {
      name: cut.name,
      document,
      extension: TIMELINE_FORMAT_EXTENSIONS[format],
      subtitles,
      media,
    },
  });
}
