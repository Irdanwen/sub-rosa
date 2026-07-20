// Assemble studio: order gallery clips into a cut list (with per-clip trims),
// lay an optional gallery audio track underneath, preview the sequence, and
// export everything as one file through the webview's own recorder.

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
import { SliderField, StudioField } from "./controls";

interface Cut {
  key: string;
  artifact: StudioArtifact;
  durationSeconds?: number;
  inSeconds: number;
  outSeconds?: number;
}

let nextCutKey = 0;

/** Clip duration via a throwaway metadata load. */
function probeDuration(src: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = src;
    video.addEventListener(
      "loadedmetadata",
      () => resolve(Number.isFinite(video.duration) ? video.duration : undefined),
      { once: true },
    );
    video.addEventListener("error", () => resolve(undefined), { once: true });
  });
}

function formatSeconds(value: number): string {
  return `${Math.round(value * 10) / 10}s`;
}

export function AssembleStudio() {
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
    const duration = await probeDuration(artifactSrc(artifact));
    if (duration !== undefined) {
      setCuts((current) =>
        current.map((cut) => (cut.key === key ? { ...cut, durationSeconds: duration } : cut)),
      );
    }
  }, []);

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
      {totalSeconds > 0 ? (
        <p className="studio-queue-hint">
          Exports run in real time: about {formatElapsed(totalSeconds * 1000)} for this cut.
        </p>
      ) : null}
    </>
  );

  return (
    <GenerationLayout controls={controls} action={action}>
      {error ? <p className="studio-error">{error}</p> : null}
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
