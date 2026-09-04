// Assemble studio: order gallery clips into a cut list (with per-clip trims),
// lay an optional gallery audio track underneath, preview the sequence, and
// export it - two ways.
//
// "Export film" records the canvas in real time through MediaRecorder. It is
// the quick answer and it has a ceiling: it re-encodes, it takes as long as the
// film runs, and it flattens everything into one track.
//
// "Export timeline" writes a self-contained folder an editor opens: the cut as
// FCPXML or Premiere XML, next to copies of the clips. Nothing is re-encoded,
// it is instant, and the grade and the fine mix happen in a tool built for
// them. That is the finishing path, and the reason the app can keep refusing to
// ship ffmpeg (see lib/studio/timeline/fcpxml.ts).

import { t } from "../../lib/i18n";
import { IconVideo } from "central-icons/IconVideo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { artifactSrc, listArtifacts, saveArtifactFromBase64 } from "../../lib/studio/artifacts";
import {
  assembleClips,
  blobToBase64,
  clipWindow,
  timelineSeconds,
} from "../../lib/studio/assemble";
import { formatElapsed } from "../../lib/studio/async-job";
import { extractFrameAt } from "../../lib/studio/frames";
import { judge, type JudgeVerdict, pickJudgeModel } from "../../lib/studio/judge";
import { modelsOfType } from "../../lib/studio/catalog";
import { DEFAULT_TARGET_LUFS } from "../../lib/studio/loudness";
import { scheduleWithoutOverlap } from "../../lib/studio/mix";
import {
  listFinishedProductions,
  productionCut,
  type WorkflowRunSummary,
} from "../../lib/studio/workflow-run";
import type { MediaCatalog, StudioArtifact } from "../../lib/studio/types";
import { EmptyState } from "../ui/EmptyState";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { GalleryStrip } from "./GalleryStrip";
import { GenerationLayout } from "./GenerationLayout";
import type { ChainShot } from "../../lib/studio/chain";
import { writeTimelineBundle } from "../../lib/studio/timeline/bundle";
import {
  AUDIO_LANES,
  type AudioLane,
  FRAME_RATES,
  TIMELINE_FORMAT_LABELS,
  type TimelineFormat,
  timelineProblems,
} from "../../lib/studio/timeline";
import { bundleCut } from "../../lib/studio/timeline/bundle";
import { formatSeconds, SliderField, StudioField } from "./controls";

/**
 * A sound placed under the film.
 *
 * Replaces the single background track this surface used to have. One track at
 * one level is a monitor path, not a mix: there was nowhere to put a line of
 * dialogue, and nothing could get out of its way. Three lanes is the smallest
 * shape that is actually a mix, and it is the shape both exports want - the
 * offline render ducks music under dialogue, and the timeline lays them on
 * A1/A2/A3 for whoever finishes it.
 */
interface Sound {
  key: string;
  artifact: StudioArtifact;
  lane: AudioLane;
  /** Where it starts on the timeline. */
  atSeconds: number;
  gain: number;
  /** Measured, not assumed. A timeline states how long a file IS. */
  durationSeconds?: number;
}

let nextSoundKey = 0;

/**
 * Place a newly added sound so it does not collide with its own lane.
 *
 * Only dialogue is scheduled: music and effects are meant to sit under things,
 * and moving them would be second-guessing. Only the new sound moves - the ones
 * already there were placed on purpose.
 */
function placeSounds(sounds: readonly Sound[], newKey: string): Sound[] {
  const added = sounds.find((sound) => sound.key === newKey);
  if (added?.lane !== "dialogue") return [...sounds];
  const existing = sounds.filter((sound) => sound.lane === "dialogue" && sound.key !== newKey);
  const placed = scheduleWithoutOverlap([
    ...existing.map((sound) => ({
      durationSeconds: sound.durationSeconds ?? 0,
      preferredAtSeconds: sound.atSeconds,
    })),
    { durationSeconds: added.durationSeconds ?? 0 },
  ]);
  const atSeconds = placed[placed.length - 1] ?? 0;
  return sounds.map((sound) => (sound.key === newKey ? { ...sound, atSeconds } : sound));
}

/** Which lane a gallery sound belongs on, from what produced it. */
function laneOf(artifact: StudioArtifact): AudioLane {
  if (artifact.kind === "speech") return "dialogue";
  if (artifact.kind === "sfx") return "sfx";
  return "music";
}

const LANE_LABELS: Record<AudioLane, string> = {
  dialogue: "Dialogue",
  sfx: "Effects",
  music: "Music",
};

interface Cut {
  key: string;
  artifact: StudioArtifact;
  durationSeconds?: number;
  /** Native frame size, measured. Only a timeline export needs it. */
  width?: number;
  height?: number;
  inSeconds: number;
  outSeconds?: number;
}

let nextCutKey = 0;

/** Duration of a sound file, measured the same way as a clip's. Needed
 * because a timeline states how long a file IS, not how long it is used for:
 * claiming the film's length for a shorter track writes a clip with a dead
 * tail that the editor has to find and trim by hand. */
function probeAudioDuration(src: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = src;
    audio.addEventListener(
      "loadedmetadata",
      () => resolve(Number.isFinite(audio.duration) ? audio.duration : undefined),
      { once: true },
    );
    audio.addEventListener("error", () => resolve(undefined), { once: true });
  });
}

/** Clip duration and frame size via a throwaway metadata load. The size is
 * what a timeline export needs and what nothing else here ever asked for. */
function probeClip(src: string): Promise<{ duration?: number; width?: number; height?: number }> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = src;
    video.addEventListener(
      "loadedmetadata",
      () =>
        resolve({
          duration: Number.isFinite(video.duration) ? video.duration : undefined,
          width: video.videoWidth || undefined,
          height: video.videoHeight || undefined,
        }),
      { once: true },
    );
    video.addEventListener("error", () => resolve({}), { once: true });
  });
}

export function AssembleStudio({
  pendingCuts,
  onPendingCutsApplied,
  catalog,
  pendingProductionRunId,
  onPendingProductionApplied,
}: {
  /** A shot chain handed over by the video studio, trims already resolved. */
  pendingCuts?: ChainShot[];
  onPendingCutsApplied?: () => void;
  /** Only the review needs it, so a surface without one simply cannot review. */
  catalog?: MediaCatalog;
  /** A film just made on the Film tab, handed over to be finished. */
  pendingProductionRunId?: string;
  onPendingProductionApplied?: () => void;
} = {}) {
  const [galleryVideos, setGalleryVideos] = useState<StudioArtifact[]>([]);
  const [galleryAudio, setGalleryAudio] = useState<StudioArtifact[]>([]);
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [sounds, setSounds] = useState<Sound[]>([]);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [galleryEpoch, setGalleryEpoch] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [filmName, setFilmName] = useState("Assembly");
  const [timelineFormat, setTimelineFormat] = useState<TimelineFormat>("fcpxml");
  const [frameRateKey, setFrameRateKey] = useState("30");
  const [writingTimeline, setWritingTimeline] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [verdict, setVerdict] = useState<JudgeVerdict | undefined>(undefined);
  const [judging, setJudging] = useState(false);
  const [productions, setProductions] = useState<WorkflowRunSummary[]>([]);
  const [loadingProduction, setLoadingProduction] = useState(false);
  const previewRef = useRef<HTMLVideoElement>(null);
  const previewRun = useRef(0);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => abortRef.current?.abort(), []);

  const reloadSources = useCallback(() => {
    listArtifacts()
      .then((artifacts) => {
        setGalleryVideos(artifacts.filter((entry) => entry.kind === "video"));
        setGalleryAudio(
          artifacts.filter(
            (entry) => entry.kind === "music" || entry.kind === "speech" || entry.kind === "sfx",
          ),
        );
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    reloadSources();
  }, [reloadSources]);

  // A film handed over from the Film tab opens itself: the user pressed
  // "Finish it" there, and being dropped in front of a picker would be the
  // app forgetting what they just asked for.
  useEffect(() => {
    if (!pendingProductionRunId) return;
    void openProduction(pendingProductionRunId);
    onPendingProductionApplied?.();
  }, [pendingProductionRunId, onPendingProductionApplied]);

  useEffect(() => {
    listFinishedProductions()
      .then(setProductions)
      .catch(() => undefined);
  }, []);

  /**
   * Reopen a finished production as a cut list.
   *
   * A run hands back one flattened film: fine to watch, and the end of the
   * line if the user wants to grade it or move a line half a second. This is
   * the way back to the parts - in order, on their lanes - so everything this
   * tab does applies to a film the compiler made.
   */
  const openProduction = useCallback(async (runId: string) => {
    setLoadingProduction(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const cut = await productionCut(runId);
      if (!cut) {
        setError(t("That production has nothing left to open. Its files may have been deleted."));
        return;
      }
      const gallery = await listArtifacts();
      const byId = new Map(gallery.map((artifact) => [artifact.id, artifact]));
      const staged: Cut[] = [];
      for (const shot of cut.shots) {
        const artifact = byId.get(shot.artifactId);
        if (!artifact) continue;
        staged.push({
          key: `cut-${nextCutKey++}`,
          artifact,
          inSeconds: 0,
          // The chain's own trim: a shot ends where its successor took over.
          outSeconds: shot.parentHandoffSeconds,
        });
      }
      if (staged.length === 0) {
        setError(t("None of that production's shots are still in your gallery."));
        return;
      }
      setCuts(staged);
      setFilmName(cut.name);
      setSounds(
        cut.sounds.flatMap((sound) => {
          const artifact = byId.get(sound.artifactId);
          if (!artifact) return [];
          return [
            {
              key: `sound-${nextSoundKey++}`,
              artifact,
              lane: sound.lane,
              atSeconds: sound.atSeconds,
              gain: sound.lane === "music" ? 0.6 : 1,
            },
          ];
        }),
      );
      for (const sound of cut.sounds) {
        const artifact = byId.get(sound.artifactId);
        if (!artifact) continue;
        void probeAudioDuration(artifactSrc(artifact)).then((duration) => {
          if (duration === undefined) return;
          setSounds((current) =>
            current.map((row) =>
              row.artifact.id === artifact.id && row.durationSeconds === undefined
                ? { ...row, durationSeconds: duration }
                : row,
            ),
          );
        });
      }
      const missing = cut.shots.length - staged.length;
      if (missing > 0) {
        setNotice(
          missing === 1
            ? t("1 shot is no longer in your gallery.")
            : t("{count} shots are no longer in your gallery.", { count: missing }),
        );
      }
      for (const entry of staged) {
        void probeClip(artifactSrc(entry.artifact)).then((probed) => {
          if (probed.duration === undefined) return;
          setCuts((current) =>
            current.map((row) =>
              row.key === entry.key
                ? {
                    ...row,
                    durationSeconds: probed.duration,
                    width: probed.width,
                    height: probed.height,
                  }
                : row,
            ),
          );
        });
      }
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "That could not be opened.");
    } finally {
      setLoadingProduction(false);
    }
  }, []);

  const totalSeconds = useMemo(
    () =>
      timelineSeconds(
        cuts
          .filter((cut) => cut.durationSeconds !== undefined)
          .map((cut) => ({
            inSeconds: cut.inSeconds,
            outSeconds: cut.outSeconds,
            durationSeconds: cut.durationSeconds as number,
          })),
      ),
    [cuts],
  );

  const addCut = useCallback(async (artifact: StudioArtifact) => {
    const key = `cut-${nextCutKey++}`;
    setCuts((current) => [...current, { key, artifact, inSeconds: 0 }]);
    const probed = await probeClip(artifactSrc(artifact));
    if (probed.duration !== undefined) {
      setCuts((current) =>
        current.map((cut) =>
          cut.key === key
            ? {
                ...cut,
                durationSeconds: probed.duration,
                width: probed.width,
                height: probed.height,
              }
            : cut,
        ),
      );
    }
  }, []);

  // A chain arriving from the video studio becomes the cut list: shots in
  // order, each already trimmed at the point the next one took over. Replaces
  // the staged list rather than appending, because the chain is the film.
  useEffect(() => {
    if (!pendingCuts?.length) return;
    const staged: Cut[] = pendingCuts.map((shot) => ({
      key: `cut-${nextCutKey++}`,
      artifact: shot.artifact,
      inSeconds: 0,
      outSeconds: shot.outSeconds,
    }));
    setCuts(staged);
    onPendingCutsApplied?.();
    // Durations are only needed for the timeline read-out, so they fill in
    // behind the list rather than holding it up.
    for (const cut of staged) {
      void probeClip(artifactSrc(cut.artifact)).then((probed) => {
        if (probed.duration === undefined) return;
        setCuts((current) =>
          current.map((entry) =>
            entry.key === cut.key
              ? {
                  ...entry,
                  durationSeconds: probed.duration,
                  width: probed.width,
                  height: probed.height,
                }
              : entry,
          ),
        );
      });
    }
  }, [pendingCuts, onPendingCutsApplied]);

  const move = useCallback((key: string, delta: -1 | 1) => {
    setCuts((current) => {
      const index = current.findIndex((cut) => cut.key === key);
      const target = index + delta;
      if (index === -1 || target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }, []);

  const patchCut = useCallback((key: string, patch: Partial<Cut>) => {
    setCuts((current) => current.map((cut) => (cut.key === key ? { ...cut, ...patch } : cut)));
  }, []);

  const stopPreview = useCallback(() => {
    previewRun.current += 1;
    previewRef.current?.pause();
    setPreviewing(false);
  }, []);

  /** Sequential preview: one visible player walks the cut list. */
  const playPreview = useCallback(async () => {
    const player = previewRef.current;
    if (!player || cuts.length === 0) return;
    const run = ++previewRun.current;
    setPreviewing(true);
    try {
      for (const cut of cuts) {
        if (previewRun.current !== run) return;
        const duration = cut.durationSeconds ?? Number.POSITIVE_INFINITY;
        const window = clipWindow(cut, duration);
        if (window.end - window.start <= 0) continue;
        player.src = artifactSrc(cut.artifact);
        player.currentTime = window.start;
        await player.play();
        await new Promise<void>((resolve) => {
          const tick = () => {
            if (previewRun.current !== run) {
              resolve();
              return;
            }
            if (player.ended || player.currentTime >= window.end) {
              resolve();
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      }
    } catch {
      // Preview is a convenience; playback errors just stop it.
    } finally {
      if (previewRun.current === run) {
        player.pause();
        setPreviewing(false);
      }
    }
  }, [cuts]);

  /**
   * What the timeline export is handed.
   *
   * `hasAudio` is declared rather than detected: no webview API reports whether
   * a file carries an audio track before it plays, and generated clips almost
   * always do. An editor shows an empty audio component for a silent file,
   * which is a smaller lie than dropping the sound of every clip that has some.
   */
  const addSound = useCallback(async (artifact: StudioArtifact) => {
    const key = `sound-${nextSoundKey++}`;
    const lane = laneOf(artifact);
    setSounds((current) => [
      ...current,
      { key, artifact, lane, atSeconds: 0, gain: lane === "music" ? 0.6 : 1 },
    ]);
    const duration = await probeAudioDuration(artifactSrc(artifact));
    setSounds((current) =>
      // A line lands after the ones already there rather than on top of them.
      // Two voices talking over each other is never what was meant, and the
      // only way to know where a generated line ends is to have measured it,
      // which is exactly now.
      placeSounds(
        current.map((sound) =>
          sound.key === key ? { ...sound, durationSeconds: duration } : sound,
        ),
        key,
      ),
    );
  }, []);

  const patchSound = useCallback((key: string, patch: Partial<Sound>) => {
    setSounds((current) =>
      current.map((sound) => (sound.key === key ? { ...sound, ...patch } : sound)),
    );
  }, []);

  const bundleInput = useMemo(() => {
    const measured = cuts.find((cut) => cut.width && cut.height);
    return {
      name: filmName.trim() || "Assembly",
      frameRate: FRAME_RATES[frameRateKey] ?? FRAME_RATES["30"],
      width: measured?.width ?? 1920,
      height: measured?.height ?? 1080,
      clips: cuts.map((cut, index) => {
        const duration = cut.durationSeconds ?? Number.NaN;
        const window = clipWindow(cut, Number.isFinite(duration) ? duration : 0);
        return {
          artifact: cut.artifact,
          name: cut.artifact.prompt?.slice(0, 48) || `Shot ${index + 1}`,
          inSeconds: window.start,
          outSeconds: window.end,
          sourceDurationSeconds: duration,
          hasAudio: true,
        };
      }),
      audio: Object.fromEntries(
        AUDIO_LANES.map((lane) => [
          lane,
          sounds
            .filter((sound) => sound.lane === lane && sound.durationSeconds !== undefined)
            .map((sound) => {
              const duration = sound.durationSeconds as number;
              return {
                artifact: sound.artifact,
                name: sound.artifact.prompt?.slice(0, 48) || sound.artifact.fileName,
                inSeconds: 0,
                // A sound plays until it or the film runs out, whichever comes
                // first. Claiming the film's length for a shorter file writes a
                // clip with a dead tail the editor has to find by hand.
                outSeconds: totalSeconds
                  ? Math.min(duration, Math.max(0, totalSeconds - sound.atSeconds))
                  : duration,
                sourceDurationSeconds: duration,
                atSeconds: sound.atSeconds,
                gain: sound.gain,
              };
            }),
        ]).filter(([, clips]) => (clips as unknown[]).length > 0),
      ),
      // Subtitles come free: the prompt of a generated speech artifact IS the
      // line that was spoken, and the lane already says when it is heard. No
      // second surface, no transcription, and a sidecar rather than a burn-in.
      subtitles: sounds
        .filter(
          (sound) =>
            sound.lane === "dialogue" &&
            sound.durationSeconds !== undefined &&
            Boolean(sound.artifact.prompt?.trim()),
        )
        .map((sound) => ({
          atSeconds: sound.atSeconds,
          untilSeconds: sound.atSeconds + (sound.durationSeconds as number),
          text: sound.artifact.prompt as string,
        })),
    };
  }, [cuts, filmName, frameRateKey, sounds, totalSeconds]);

  /** Why the cut cannot be written yet, said before a folder is even picked. */
  const timelineBlockers = useMemo(
    () => (cuts.length === 0 ? [] : timelineProblems(bundleCut(bundleInput).cut)),
    [bundleInput, cuts.length],
  );

  /**
   * Ask a model to watch the cut and say what is weak.
   *
   * The missing feedback loop, and the reason a pipeline plateaus without one:
   * otherwise the only critic is the user, on the sixth shot, after paying for
   * all six. One frame per shot rather than the film - a contact sheet is what
   * a supervisor actually looks at, it costs a fraction of a video call, and
   * the picture is what drifts.
   *
   * Best-effort like every judge: no vision model, a refusal or an unreadable
   * answer all come back as "no opinion", never as an error.
   */
  const runJudge = useCallback(async () => {
    if (cuts.length === 0 || judging) return;
    const model = catalog ? pickJudgeModel(modelsOfType(catalog, "text")) : undefined;
    if (!model) {
      setError(t("No model on this account can look at pictures."));
      return;
    }
    setJudging(true);
    setError(undefined);
    setVerdict(undefined);
    try {
      const subjects = [];
      for (const [index, cut] of cuts.entries()) {
        const window = clipWindow(cut, cut.durationSeconds ?? 0);
        const middle = window.start + (window.end - window.start) / 2;
        try {
          const frame = await extractFrameAt(artifactSrc(cut.artifact), middle);
          subjects.push({
            label: t("Shot {number}", { number: index + 1 }),
            intent: cut.artifact.prompt || undefined,
            imageDataUri: frame.dataUrl,
          });
        } catch {
          // A shot whose frame will not decode is left out rather than
          // stopping the review of the ones that will.
        }
      }
      const result = await judge(
        {
          subjects,
          brief: filmName.trim() || undefined,
          lens: "the cut as a whole: continuity, rhythm, and whether any shot lets the others down",
        },
        model,
      );
      setVerdict(result);
      if (!result) setNotice(t("The judge had nothing to say this time."));
    } finally {
      setJudging(false);
    }
  }, [catalog, cuts, filmName, judging]);

  const runTimelineExport = useCallback(async () => {
    if (writingTimeline || cuts.length === 0) return;
    setError(undefined);
    setNotice(undefined);
    setWritingTimeline(true);
    try {
      // Rust opens the folder picker: a directory chosen here would make the
      // export command an arbitrary directory-write.
      const written = await writeTimelineBundle(bundleInput, timelineFormat);
      if (written.cancelled) return;
      setNotice(
        written.mediaCount === 1
          ? t("Wrote {directory} with 1 file next to the timeline.", {
              directory: written.directory,
            })
          : t("Wrote {directory} with {count} files next to the timeline.", {
              directory: written.directory,
              count: written.mediaCount,
            }),
      );
    } catch (writeError) {
      setError(writeError instanceof Error ? writeError.message : "The timeline export failed.");
    } finally {
      setWritingTimeline(false);
    }
  }, [bundleInput, cuts.length, timelineFormat, writingTimeline]);

  const runExport = useCallback(async () => {
    if (cuts.length === 0 || exporting) return;
    stopPreview();
    const controller = new AbortController();
    abortRef.current = controller;
    setExporting(true);
    setProgress(0);
    setError(undefined);
    try {
      const mixProblems: string[] = [];
      const lane = (which: AudioLane) =>
        sounds
          .filter((sound) => sound.lane === which)
          .map((sound) => ({
            src: artifactSrc(sound.artifact),
            atSeconds: sound.atSeconds,
            gain: sound.gain,
          }));
      const result = await assembleClips({
        clips: cuts.map((cut) => ({
          src: artifactSrc(cut.artifact),
          inSeconds: cut.inSeconds,
          outSeconds: cut.outSeconds,
        })),
        // Asking for a loudness target is what puts the export on the offline
        // mix: deterministic levels, and music that gets out of the way.
        normalizeToLufs: DEFAULT_TARGET_LUFS,
        lanes: {
          dialogue: lane("dialogue"),
          sfx: lane("sfx"),
          music: lane("music"),
        },
        onMixProblem: (problem) => mixProblems.push(problem),
        onProgress: setProgress,
        signal: controller.signal,
      });
      if (mixProblems.length > 0) setNotice(mixProblems.join(" "));
      const base64 = await blobToBase64(result.blob);
      await saveArtifactFromBase64(base64, result.extension, {
        kind: "video",
        model: "assemble",
        prompt: `Assembly of ${cuts.length} clip${cuts.length > 1 ? "s" : ""}`,
      });
      setGalleryEpoch((epoch) => epoch + 1);
      reloadSources();
    } catch (exportError) {
      if (!(exportError instanceof DOMException && exportError.name === "AbortError")) {
        setError(exportError instanceof Error ? exportError.message : "The export failed.");
      }
    } finally {
      setExporting(false);
    }
  }, [cuts, exporting, stopPreview, sounds, reloadSources]);

  const controls = (
    <>
      <StudioField
        label={t("Clips")}
        hint={cuts.length > 0 ? `${cuts.length} · ${formatSeconds(totalSeconds)}` : undefined}
      >
        <div className="studio-cutlist">
          {cuts.map((cut, index) => {
            const duration = cut.durationSeconds;
            const window = clipWindow(cut, duration ?? Number.POSITIVE_INFINITY);
            return (
              <div key={cut.key} className="studio-cut">
                <div className="studio-cut-head">
                  <span className="studio-cut-title" title={cut.artifact.prompt}>
                    {index + 1}. {cut.artifact.prompt || cut.artifact.fileName}
                  </span>
                  <span className="studio-card-actions">
                    <button
                      type="button"
                      className="studio-icon-button"
                      aria-label={t("Move clip up")}
                      disabled={index === 0}
                      onClick={() => move(cut.key, -1)}
                    >
                      <span aria-hidden>↑</span>
                    </button>
                    <button
                      type="button"
                      className="studio-icon-button"
                      aria-label={t("Move clip down")}
                      disabled={index === cuts.length - 1}
                      onClick={() => move(cut.key, 1)}
                    >
                      <span aria-hidden>↓</span>
                    </button>
                    <button
                      type="button"
                      className="studio-icon-button"
                      aria-label={t("Remove clip")}
                      onClick={() =>
                        setCuts((current) => current.filter((entry) => entry.key !== cut.key))
                      }
                    >
                      <span aria-hidden>x</span>
                    </button>
                  </span>
                </div>
                <div className="studio-cut-trim">
                  <label>
                    <span>{t("Start")}</span>
                    <input
                      className="studio-input"
                      inputMode="decimal"
                      value={String(cut.inSeconds)}
                      aria-label={`Clip ${index + 1} start seconds`}
                      onChange={(event) => {
                        const value = Number(event.target.value.replace(",", "."));
                        patchCut(cut.key, {
                          inSeconds: Number.isFinite(value) ? Math.max(0, value) : 0,
                        });
                      }}
                    />
                  </label>
                  <label>
                    <span>{t("End")}</span>
                    <input
                      className="studio-input"
                      inputMode="decimal"
                      placeholder={duration !== undefined ? formatSeconds(duration) : "end"}
                      value={cut.outSeconds !== undefined ? String(cut.outSeconds) : ""}
                      aria-label={`Clip ${index + 1} end seconds`}
                      onChange={(event) => {
                        const raw = event.target.value.trim();
                        if (!raw) {
                          patchCut(cut.key, { outSeconds: undefined });
                          return;
                        }
                        const value = Number(raw.replace(",", "."));
                        if (Number.isFinite(value)) patchCut(cut.key, { outSeconds: value });
                      }}
                    />
                  </label>
                  {duration !== undefined ? (
                    <span className="studio-cut-length">
                      {formatSeconds(window.end - window.start)}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
          <Select
            value={null}
            placeholder={cuts.length > 0 ? "Add another clip" : "Add a clip from your gallery"}
            ariaLabel={t("Add a clip")}
            onChange={(path) => {
              const artifact = galleryVideos.find((entry) => entry.path === path);
              if (artifact) void addCut(artifact);
            }}
            options={galleryVideos.map((entry) => ({
              value: entry.path,
              label: entry.prompt ? entry.prompt.slice(0, 48) : entry.fileName,
            }))}
          />
        </div>
      </StudioField>
      {productions.length > 0 ? (
        <StudioField
          label={t("A film you made")}
          hint={t("Opens its shots and sound, to finish properly")}
        >
          <Select
            value={null}
            placeholder={loadingProduction ? "Opening..." : "Open a production"}
            ariaLabel={t("Open a production")}
            onChange={(runId) => void openProduction(runId)}
            options={productions.map((run) => ({
              value: run.id,
              label: run.name || "Untitled production",
            }))}
          />
        </StudioField>
      ) : null}
      <StudioField
        label={t("Sound")}
        hint={sounds.length > 0 ? `${sounds.length} on 3 lanes` : "Dialogue, effects, music"}
      >
        <div className="studio-cutlist">
          {sounds.map((sound, index) => (
            <div key={sound.key} className="studio-cut">
              <div className="studio-cut-head">
                <span className="studio-cut-title" title={sound.artifact.prompt}>
                  {sound.artifact.prompt || sound.artifact.fileName}
                </span>
                <span className="studio-card-actions">
                  <button
                    type="button"
                    className="studio-icon-button"
                    aria-label={`Remove sound ${index + 1}`}
                    onClick={() =>
                      setSounds((current) => current.filter((entry) => entry.key !== sound.key))
                    }
                  >
                    <span aria-hidden>x</span>
                  </button>
                </span>
              </div>
              <div className="studio-cut-trim">
                <div>
                  <span>{t("Lane")}</span>
                  <Select
                    value={sound.lane}
                    placeholder={t("Music")}
                    ariaLabel={`Sound ${index + 1} lane`}
                    onChange={(value) => patchSound(sound.key, { lane: value as AudioLane })}
                    options={AUDIO_LANES.map((lane) => ({ value: lane, label: LANE_LABELS[lane] }))}
                  />
                </div>
                <label>
                  <span>{t("Start")}</span>
                  <input
                    className="studio-input"
                    inputMode="decimal"
                    value={String(sound.atSeconds)}
                    aria-label={`Sound ${index + 1} start seconds`}
                    onChange={(event) => {
                      const value = Number(event.target.value.replace(",", "."));
                      patchSound(sound.key, {
                        atSeconds: Number.isFinite(value) ? Math.max(0, value) : 0,
                      });
                    }}
                  />
                </label>
              </div>
              <SliderField
                label={`Sound ${index + 1} level`}
                min={0}
                max={1}
                step={0.05}
                value={sound.gain}
                onChange={(value) => patchSound(sound.key, { gain: value })}
                format={(value) => `${Math.round(value * 100)}%`}
              />
            </div>
          ))}
          <Select
            value={null}
            placeholder={sounds.length > 0 ? "Add another sound" : "Add a sound from your gallery"}
            ariaLabel={t("Add a sound")}
            onChange={(path) => {
              const artifact = galleryAudio.find((entry) => entry.path === path);
              if (artifact) void addSound(artifact);
            }}
            options={galleryAudio.map((entry) => ({
              value: entry.path,
              label: entry.prompt ? entry.prompt.slice(0, 48) : entry.fileName,
            }))}
          />
        </div>
      </StudioField>
      {cuts.length > 0 ? (
        <>
          <StudioField label={t("Film name")} hint={t("Names the export")}>
            <input
              className="studio-input"
              type="text"
              value={filmName}
              aria-label={t("Film name")}
              onChange={(event) => setFilmName(event.target.value)}
            />
          </StudioField>
          <StudioField label={t("Timeline for")} hint={t("Used by the timeline export")}>
            <Select
              value={timelineFormat}
              placeholder={t("Final Cut Pro and Resolve")}
              ariaLabel={t("Timeline format")}
              onChange={(value) => setTimelineFormat(value as TimelineFormat)}
              options={Object.entries(TIMELINE_FORMAT_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </StudioField>
          <StudioField label={t("Frame rate")} hint={t("Frames per second in the timeline")}>
            <Select
              value={frameRateKey}
              placeholder="30"
              ariaLabel={t("Frame rate")}
              onChange={setFrameRateKey}
              options={Object.keys(FRAME_RATES).map((key) => ({ value: key, label: key }))}
            />
          </StudioField>
        </>
      ) : null}
    </>
  );

  const action = exporting ? (
    <div className="studio-progress">
      <Spinner aria-hidden />
      <span>{t("Exporting {percent}%", { percent: Math.round(progress * 100) })}</span>
      <button type="button" className="btn btn-secondary" onClick={() => abortRef.current?.abort()}>
        {t("Cancel")}
      </button>
    </div>
  ) : (
    <>
      <button
        type="button"
        className="studio-primary-button"
        disabled={cuts.length === 0}
        onClick={() => void runExport()}
      >
        {t("Export film")}
      </button>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={cuts.length === 0 || writingTimeline || timelineBlockers.length > 0}
        onClick={() => void runTimelineExport()}
      >
        {writingTimeline ? "Writing the timeline..." : "Export timeline"}
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={cuts.length === 0 || judging}
        onClick={() => void runJudge()}
      >
        {judging ? "Watching it..." : "Review the cut"}
      </button>
      {timelineBlockers.length > 0 ? (
        <p className="studio-queue-hint">{timelineBlockers.join(" ")}</p>
      ) : totalSeconds > 0 ? (
        <p className="studio-queue-hint">
          {t(
            "Exporting the film runs in real time: about {duration} for this cut. The timeline is written instantly and keeps every clip untouched.",
            { duration: formatElapsed(totalSeconds * 1000) },
          )}
        </p>
      ) : null}
    </>
  );

  return (
    <GenerationLayout controls={controls} action={action}>
      {error ? <p className="studio-error">{error}</p> : null}
      {notice ? <p className="studio-queue-hint">{notice}</p> : null}
      {verdict ? (
        <div className="studio-verdict" data-passes={verdict.passes}>
          <p className="studio-verdict-score">
            {verdict.score}/10 {verdict.summary}
          </p>
          {verdict.weakest.length > 0 ? (
            <ul className="studio-verdict-weak">
              {verdict.weakest.map((weakness) => (
                <li key={`${weakness.label}-${weakness.why}`}>
                  <strong>{weakness.label}</strong> {weakness.why}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {cuts.length > 0 ? (
        <div className="studio-assemble-preview">
          {/* biome-ignore lint/a11y/useMediaCaption: generated clips have no track */}
          <video ref={previewRef} className="studio-video-player" controls={false} muted={false} />
          <div className="studio-card-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => (previewing ? stopPreview() : void playPreview())}
            >
              {previewing ? "Stop preview" : "Play preview"}
            </button>
          </div>
        </div>
      ) : null}
      <GalleryStrip
        kind="video"
        epoch={galleryEpoch}
        empty={
          cuts.length === 0 ? (
            <EmptyState
              icon={<IconVideo size={22} />}
              title={t("Nothing to assemble yet")}
              description={t(
                "Generate a few clips in the video tab, then add them here to cut one film.",
              )}
            />
          ) : null
        }
      />
    </GenerationLayout>
  );
}
