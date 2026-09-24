import { t } from "../../i18n";
import type { BundleInput } from "../timeline/bundle";
import type { AudioLane } from "../timeline/types";
import type { StudioArtifact } from "../types";
import { type EditorDocument, PROPERTY_DEFAULTS, fps } from "./document";

/** Every file the editable document still references travels with the bundle,
 * including muted and hidden clips omitted from the interchange timeline. */
export function editorMediaPaths(doc: EditorDocument, artifacts: StudioArtifact[]): string[] {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  return [
    ...new Set(
      doc.clips.flatMap((clip) => {
        if (!clip.artifactId) return [];
        const artifact = byId.get(clip.artifactId);
        if (!artifact) throw new Error(t("A media file is missing from this montage."));
        return [artifact.path];
      }),
    ),
  ];
}

/** The legacy interchange writer supports a contiguous picture spine and
 * placed audio. Refuse richer cuts rather than silently discarding edits. */
export function interchangeProblems(
  doc: EditorDocument,
  artifacts: StudioArtifact[] = [],
): string[] {
  const problems = new Set<string>();
  const videoTracks = doc.tracks.filter((track) => track.kind === "video" && !track.hidden);
  if (videoTracks.filter((track) => doc.clips.some((c) => c.trackId === track.id)).length > 1)
    problems.add(t("Overlapping picture tracks"));
  const pictures = doc.clips
    .filter((clip) => videoTracks.some((track) => track.id === clip.trackId))
    .sort((a, b) => a.start - b.start);
  if (!pictures.length) problems.add(t("No visible picture clips"));
  let end = 0;
  for (const clip of pictures) {
    if (clip.start !== end) problems.add(t("Gaps or overlapping clips"));
    end = clip.start + clip.duration;
  }
  for (const clip of doc.clips) {
    const track = doc.tracks.find((track) => track.id === clip.trackId);
    if (track?.hidden) continue;
    if (clip.title !== undefined) problems.add(t("Titles"));
    if (artifacts.find((a) => a.id === clip.artifactId)?.kind === "image")
      problems.add(t("Still images"));
    if (clip.properties.speed.some((point) => point.value !== 1)) problems.add(t("Speed changes"));
    if (
      Object.entries(clip.properties).some(
        ([key, points]) =>
          key !== "volume" &&
          key !== "speed" &&
          points.some(
            (point) => point.value !== PROPERTY_DEFAULTS[key as keyof typeof PROPERTY_DEFAULTS],
          ),
      )
    )
      problems.add(t("Transforms and opacity"));
    if (clip.properties.volume.some((point) => point.value !== clip.properties.volume[0]?.value))
      problems.add(t("Volume keyframes"));
    if (clip.fadeIn || clip.fadeOut) problems.add(t("Fades"));
    if (Object.values(clip.crop).some((value) => value !== 0)) problems.add(t("Cropping"));
    const grade = clip.grade;
    if (
      grade.exposure ||
      grade.contrast !== 1 ||
      grade.saturation !== 1 ||
      grade.temperature ||
      grade.blur ||
      grade.lut ||
      Object.values(grade.curves).some((curve) =>
        curve.some((v, i) => v !== i / (curve.length - 1)),
      )
    )
      problems.add(t("Colour corrections, blur and LUTs"));
    if (track?.kind === "video" && (track.muted || clip.properties.volume[0]?.value !== 1))
      problems.add(t("Picture track audio levels"));
  }
  return [...problems];
}
export function editorBundle(
  doc: EditorDocument,
  artifacts: StudioArtifact[],
  name: string,
): BundleInput {
  const problems = interchangeProblems(doc, artifacts);
  if (problems.length)
    throw new Error(
      t("Render these edits before interchange export: {effects}", {
        effects: problems.join(", "),
      }),
    );
  const rate = fps(doc);
  const artifactFor = (id: string | undefined) => {
    const found = artifacts.find((a) => a.id === id);
    if (!found) throw new Error(t("A media file is missing from this montage."));
    return found;
  };
  const pictureTracks = doc.tracks.filter((track) => track.kind === "video" && !track.hidden);
  const clips = doc.clips
    .filter((clip) => pictureTracks.some((track) => track.id === clip.trackId))
    .sort((a, b) => a.start - b.start)
    .map((clip) => {
      const artifact = artifactFor(clip.artifactId);
      if (artifact.kind !== "video")
        throw new Error(t("Render still images before interchange export."));
      return {
        artifact,
        name: clip.name,
        inSeconds: clip.sourceStart / rate,
        outSeconds: (clip.sourceStart + clip.duration) / rate,
        sourceDurationSeconds: clip.sourceDuration / rate,
        hasAudio: true,
      };
    });
  const audio: NonNullable<BundleInput["audio"]> = {};
  for (const clip of doc.clips) {
    const track = doc.tracks.find((candidate) => candidate.id === clip.trackId);
    if (track?.kind !== "audio" || track.muted || track.hidden) continue;
    const lane: AudioLane =
      track.id === "music"
        ? "music"
        : track.id === "effects" || track.id === "sfx"
          ? "sfx"
          : "dialogue";
    if (!audio[lane]) audio[lane] = [];
    audio[lane].push({
      artifact: artifactFor(clip.artifactId),
      name: clip.name,
      inSeconds: clip.sourceStart / rate,
      outSeconds: (clip.sourceStart + clip.duration) / rate,
      sourceDurationSeconds: clip.sourceDuration / rate,
      atSeconds: clip.start / rate,
      gain: clip.properties.volume[0]?.value ?? 1,
    });
  }
  return {
    name,
    clips,
    audio,
    additionalMedia: editorMediaPaths(doc, artifacts),
    frameRate: doc.frameRate,
    width: doc.width,
    height: doc.height,
  };
}
