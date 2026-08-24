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

import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
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
import type { StudioArtifact } from "../../lib/studio/types";
import { EmptyState } from "../ui/EmptyState";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { GalleryStrip } from "./GalleryStrip";
import { GenerationLayout } from "./GenerationLayout";
import type { ChainShot } from "../../lib/studio/chain";
import { writeTimelineBundle } from "../../lib/studio/timeline/bundle";
import {
  FRAME_RATES,
  TIMELINE_FORMAT_LABELS,
  type TimelineFormat,
  timelineProblems,
} from "../../lib/studio/timeline";
import { bundleCut } from "../../lib/studio/timeline/bundle";
import { formatSeconds, SliderField, StudioField } from "./controls";

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
}: {
  /** A shot chain handed over by the video studio, trims already resolved. */
  pendingCuts?: ChainShot[];
  onPendingCutsApplied?: () => void;
} = {}) {
  const [galleryVideos, setGalleryVideos] = useState<StudioArtifact[]>([]);
  const [galleryAudio, setGalleryAudio] = useState<StudioArtifact[]>([]);
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [audioPath, setAudioPath] = useState("");
  const [audioVolume, setAudioVolume] = useState(0.6);
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
  const [audioDurationSeconds, setAudioDurationSeconds] = useState<number | undefined>(undefined);
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
  useEffect(() => {
    const track = galleryAudio.find((entry) => entry.path === audioPath);
    if (!track) {
      setAudioDurationSeconds(undefined);
      return;
    }
    let cancelled = false;
    void probeAudioDuration(artifactSrc(track)).then((duration) => {
      if (!cancelled) setAudioDurationSeconds(duration);
    });
    return () => {
      cancelled = true;
    };
  }, [audioPath, galleryAudio]);

  const bundleInput = useMemo(() => {
    const measured = cuts.find((cut) => cut.width && cut.height);
    const audio = galleryAudio.find((entry) => entry.path === audioPath);
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
      audio:
        audio && audioDurationSeconds !== undefined
          ? {
              music: [
                {
                  artifact: audio,
                  name: audio.prompt?.slice(0, 48) || audio.fileName,
                  inSeconds: 0,
                  // The track plays under the film until one of the two runs
                  // out, so the shorter of the pair is the honest out point.
                  outSeconds: Math.min(audioDurationSeconds, totalSeconds || audioDurationSeconds),
                  sourceDurationSeconds: audioDurationSeconds,
                  atSeconds: 0,
                  gain: audioVolume,
                },
              ],
            }
          : undefined,
    };
  }, [
    cuts,
    filmName,
    frameRateKey,
    galleryAudio,
    audioPath,
    audioVolume,
    audioDurationSeconds,
    totalSeconds,
  ]);

  /** Why the cut cannot be written yet, said before a folder is even picked. */
  const timelineBlockers = useMemo(
    () => (cuts.length === 0 ? [] : timelineProblems(bundleCut(bundleInput).cut)),
    [bundleInput, cuts.length],
  );

  const runTimelineExport = useCallback(async () => {
    if (writingTimeline || cuts.length === 0) return;
    setError(undefined);
    setNotice(undefined);
    const directory = await openDirectoryDialog({ directory: true, multiple: false });
    if (typeof directory !== "string") return;
    setWritingTimeline(true);
    try {
      const written = await writeTimelineBundle(bundleInput, timelineFormat, directory);
      setNotice(
        `Wrote ${written.directory} with ${written.mediaCount} file${
          written.mediaCount === 1 ? "" : "s"
        } next to the timeline.`,
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
      const audio = galleryAudio.find((entry) => entry.path === audioPath);
      const result = await assembleClips({
        clips: cuts.map((cut) => ({
          src: artifactSrc(cut.artifact),
          inSeconds: cut.inSeconds,
          outSeconds: cut.outSeconds,
        })),
        audioSrc: audio ? artifactSrc(audio) : undefined,
        audioVolume,
        onProgress: setProgress,
        signal: controller.signal,
      });
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
  }, [cuts, exporting, stopPreview, galleryAudio, audioPath, audioVolume, reloadSources]);

  const controls = (
    <>
      <StudioField
        label="Clips"
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
                      aria-label="Move clip up"
                      disabled={index === 0}
                      onClick={() => move(cut.key, -1)}
                    >
                      <span aria-hidden>↑</span>
                    </button>
                    <button
                      type="button"
                      className="studio-icon-button"
                      aria-label="Move clip down"
                      disabled={index === cuts.length - 1}
                      onClick={() => move(cut.key, 1)}
                    >
                      <span aria-hidden>↓</span>
                    </button>
                    <button
                      type="button"
                      className="studio-icon-button"
                      aria-label="Remove clip"
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
                    <span>Start</span>
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
                    <span>End</span>
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
            ariaLabel="Add a clip"
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
      <StudioField label="Audio track" hint="Optional, under the whole film">
        <Select
          value={audioPath || null}
          placeholder="None"
          ariaLabel="Audio track"
          onChange={setAudioPath}
          options={[
            { value: "", label: "None" },
            ...galleryAudio.map((entry) => ({
              value: entry.path,
              label: entry.prompt ? entry.prompt.slice(0, 48) : entry.fileName,
            })),
          ]}
        />
      </StudioField>
      {audioPath ? (
        <SliderField
          label="Audio volume"
          min={0}
          max={1}
          step={0.05}
          value={audioVolume}
          onChange={setAudioVolume}
          format={(value) => `${Math.round(value * 100)}%`}
        />
      ) : null}
      {cuts.length > 0 ? (
        <>
          <StudioField label="Film name" hint="Names the export">
            <input
              className="studio-input"
              type="text"
              value={filmName}
              aria-label="Film name"
              onChange={(event) => setFilmName(event.target.value)}
            />
          </StudioField>
          <StudioField label="Timeline for" hint="Used by the timeline export">
            <Select
              value={timelineFormat}
              placeholder="Final Cut Pro and Resolve"
              ariaLabel="Timeline format"
              onChange={(value) => setTimelineFormat(value as TimelineFormat)}
              options={Object.entries(TIMELINE_FORMAT_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </StudioField>
          <StudioField label="Frame rate" hint="Frames per second in the timeline">
            <Select
              value={frameRateKey}
              placeholder="30"
              ariaLabel="Frame rate"
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
      <span>Exporting {Math.round(progress * 100)}%</span>
      <button type="button" className="btn btn-secondary" onClick={() => abortRef.current?.abort()}>
        Cancel
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
        Export film
      </button>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={cuts.length === 0 || writingTimeline || timelineBlockers.length > 0}
        onClick={() => void runTimelineExport()}
      >
        {writingTimeline ? "Writing the timeline..." : "Export timeline"}
      </button>
      {timelineBlockers.length > 0 ? (
        <p className="studio-queue-hint">{timelineBlockers.join(" ")}</p>
      ) : totalSeconds > 0 ? (
        <p className="studio-queue-hint">
          Exporting the film runs in real time: about {formatElapsed(totalSeconds * 1000)} for this
          cut. The timeline is written instantly and keeps every clip untouched.
        </p>
      ) : null}
    </>
  );

  return (
    <GenerationLayout controls={controls} action={action}>
      {error ? <p className="studio-error">{error}</p> : null}
      {notice ? <p className="studio-queue-hint">{notice}</p> : null}
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
              title="Nothing to assemble yet"
              description="Generate a few clips in the video tab, then add them here to cut one film."
            />
          ) : null
        }
      />
    </GenerationLayout>
  );
}
