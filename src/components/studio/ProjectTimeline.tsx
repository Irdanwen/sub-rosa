import { IconChevronLeft } from "central-icons/IconChevronLeft";
import { IconChevronRight } from "central-icons/IconChevronRight";
import { IconPlusSmall } from "central-icons/IconPlusSmall";
import { IconSpeaker } from "central-icons/IconSpeaker";
import { useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { messageFromError } from "../../lib/errors";
import { artifactSrc, exportArtifact, saveArtifactFromBase64 } from "../../lib/studio/artifacts";
import { blobToBase64, pickRecorderMime } from "../../lib/studio/assemble";
import { EditorCompositor, recordEditor } from "../../lib/studio/editor/compositor";
import {
  type AnimatedProperty,
  type EditorClip,
  type EditorDocument,
  type EditorTrack,
  createEditorClip,
  duplicateClip,
  durationFrames,
  fps,
  insertionTrack,
  isLocked,
  removeClip,
  replaceClip,
  resizeClip,
  resizeClipLeft,
  setKeyframe,
  snapFrame,
  splitClip,
  titleTrack,
  validateEditorDocument,
  valueAt,
} from "../../lib/studio/editor/document";
import {
  editorBundle,
  editorMediaPaths,
  interchangeProblems,
} from "../../lib/studio/editor/interchange";
import { parseCube } from "../../lib/studio/editor/lut";
import { writeTimelineBundle } from "../../lib/studio/timeline/bundle";
import type { TimelineFormat } from "../../lib/studio/timeline/types";
import type { StudioArtifact } from "../../lib/studio/types";
import "./project-timeline.css";

interface Props {
  value: EditorDocument;
  onChange: (value: EditorDocument) => void;
  artifacts: StudioArtifact[];
  onExportArtifact: (artifact: StudioArtifact) => Promise<void>;
}
function timecode(frame: number, rate: number): string {
  const seconds = Math.floor(frame / rate),
    remainder = Math.floor(frame - seconds * rate);
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(
      2,
      "0",
    )}:${(seconds % 60).toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
}
async function mediaDuration(artifact: StudioArtifact): Promise<number> {
  if (artifact.kind === "image") return 5;
  return new Promise((resolve, reject) => {
    const media = document.createElement("video");
    media.preload = "metadata";
    const cleanup = () => {
      clearTimeout(timer);
      media.removeAttribute("src");
      media.load();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(t("Could not measure this media file.")));
    }, 15000);
    media.onloadedmetadata = () => {
      const duration = media.duration;
      cleanup();
      Number.isFinite(duration) && duration > 0
        ? resolve(duration)
        : reject(new Error(t("This media file has no readable duration.")));
    };
    media.onerror = () => {
      cleanup();
      reject(new Error(t("Could not open this media file.")));
    };
    media.src = artifactSrc(artifact);
  });
}
const PROPERTY_LABELS: Record<AnimatedProperty, () => string> = {
  x: () => t("Horizontal position"),
  y: () => t("Vertical position"),
  scale: () => t("Scale"),
  rotation: () => t("Rotation"),
  opacity: () => t("Opacity"),
  volume: () => t("Volume"),
  speed: () => t("Speed"),
};
function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <label className="project-timeline-field">
      <span>{label}</span>
      <input
        type="number"
        value={Number(value.toFixed(4))}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => {
          const n = event.currentTarget.valueAsNumber;
          if (Number.isFinite(n))
            onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n)));
        }}
      />
    </label>
  );
}

export function ProjectTimeline({ value, onChange, artifacts, onExportArtifact }: Props) {
  const [selectedId, setSelectedId] = useState<string>();
  const [frame, setFrame] = useState(0),
    [playing, setPlaying] = useState(false),
    [zoom, setZoom] = useState(60),
    [snap, setSnap] = useState(true);
  const [search, setSearch] = useState(""),
    [error, setError] = useState<string>(),
    [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [progress, setProgress] = useState<number>();
  const [format, setFormat] = useState<TimelineFormat>("fcpxml"),
    [historyTick, setHistoryTick] = useState(0);
  const [drag, setDrag] = useState<{
    id: string;
    mode: "move" | "left" | "right";
    origin: number;
    delta: number;
  }>();
  const [keyframeMode, setKeyframeMode] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null),
    renderer = useRef<EditorCompositor>(),
    abort = useRef<AbortController>();
  const history = useRef<{ past: EditorDocument[]; future: EditorDocument[] }>({
    past: [],
    future: [],
  });
  const playhead = useRef(frame);
  playhead.current = frame;
  const current = useRef(value);
  current.current = value;
  const selected = value.clips.find((clip) => clip.id === selectedId),
    locked = selected ? isLocked(value, selected) : false;
  const rate = fps(value),
    duration = durationFrames(value),
    end = Math.max(duration, rate * 10),
    local = selected ? Math.max(0, Math.min(selected.duration - 1, frame - selected.start)) : 0;
  const problems = validateEditorDocument(value),
    exchangeProblems = interchangeProblems(value, artifacts);
  const commit = (next: EditorDocument) => {
    if (next === value) return;
    history.current.past.push(value);
    if (history.current.past.length > 80) history.current.past.shift();
    history.current.future = [];
    setHistoryTick((n) => n + 1);
    onChange(next);
  };
  const undo = () => {
    const previous = history.current.past.pop();
    if (previous) {
      history.current.future.push(value);
      onChange(previous);
      setHistoryTick((n) => n + 1);
    }
  };
  const redo = () => {
    const next = history.current.future.pop();
    if (next) {
      history.current.past.push(value);
      onChange(next);
      setHistoryTick((n) => n + 1);
    }
  };
  const update = (clip: EditorClip) => commit(replaceClip(value, clip));
  const updateTrack = (track: EditorTrack) =>
    commit({
      ...value,
      tracks: value.tracks.map((existing) => (existing.id === track.id ? track : existing)),
    });

  useEffect(() => {
    if (!canvas.current) return;
    try {
      renderer.current = new EditorCompositor(canvas.current);
    } catch (cause) {
      setError(messageFromError(cause));
    }
    return () => {
      renderer.current?.dispose();
      renderer.current = undefined;
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    const instance = renderer.current;
    if (!instance) return;
    let cancelled = false;
    setReady(false);
    setPlaying(false);
    void instance
      .prepare(value, artifacts)
      .then(async () => {
        if (cancelled) return;
        await instance.seek(
          value,
          Math.min(playhead.current, Math.max(0, durationFrames(value) - 1)),
        );
        if (!cancelled) setReady(true);
      })
      .catch((cause) => {
        if (!cancelled) setError(messageFromError(cause));
      });
    return () => {
      cancelled = true;
    };
    // Seeking is separate from preparing source media.
  }, [value, artifacts]);
  useEffect(() => {
    if (!ready || playing) return;
    let cancelled = false;
    void renderer.current?.seek(value, frame).catch((cause) => {
      if (!cancelled) setError(messageFromError(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [frame, playing, ready, value]);
  useEffect(() => {
    const instance = renderer.current;
    if (!playing || !instance) return;
    let raf = 0,
      cancelled = false;
    const initial = playhead.current >= duration - 1 ? 0 : playhead.current;
    void instance
      .enableAudio(value)
      .then(async () => {
        if (cancelled) return;
        const start = await instance.startAudio(value, initial);
        if (cancelled) {
          instance.pause();
          return;
        }
        if (instance.audioWarnings.length) setStatus(instance.audioWarnings.join("\n"));
        const tick = () => {
          const at = initial + Math.max(0, ((performance.now() - start) * rate) / 1000);
          if (at >= duration) {
            setPlaying(false);
            setFrame(0);
            return;
          }
          instance.draw(value, at, true);
          setFrame(Math.floor(at));
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch((cause) => {
        setError(messageFromError(cause));
        setPlaying(false);
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      instance.pause();
    };
    // Playback owns the clock; updating the displayed frame must not restart it.
  }, [playing, value, duration, rate]);

  async function addArtifact(artifact: StudioArtifact) {
    setError(undefined);
    setBusy(true);
    try {
      const seconds = await mediaDuration(artifact),
        doc = current.current;
      const track = insertionTrack(doc, artifact.kind);
      if (!track) throw new Error(t("Unlock a matching track before adding media."));
      const clip = createEditorClip({
        trackId: track.id,
        name: artifact.prompt?.slice(0, 60) || artifact.fileName,
        artifactId: artifact.id,
        duration: Math.max(1, Math.floor(seconds * fps(doc))),
        sourceDuration: Math.floor((artifact.kind === "image" ? 86400 : seconds) * fps(doc)),
        start: Math.max(
          0,
          ...doc.clips.filter((c) => c.trackId === track.id).map((c) => c.start + c.duration),
        ),
      });
      commit({ ...doc, clips: [...doc.clips, clip] });
      setSelectedId(clip.id);
      setFrame(clip.start);
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setBusy(false);
    }
  }
  function addTitle() {
    let track = titleTrack(value);
    let tracks = value.tracks;
    if (!track) {
      track = {
        id: crypto.randomUUID(),
        name: t("Titles"),
        kind: "video",
        locked: false,
        muted: false,
        hidden: false,
      };
      tracks = [...tracks, track];
    }
    const clip = createEditorClip({
      trackId: track.id,
      name: t("Title"),
      title: t("Your title"),
      duration: Math.round(rate * 3),
      start: frame,
    });
    commit({ ...value, tracks, clips: [...value.clips, clip] });
    setSelectedId(clip.id);
  }
  function property(property: AnimatedProperty, n: number) {
    if (!selected) return;
    update(
      keyframeMode
        ? setKeyframe(selected, property, local, n)
        : {
            ...selected,
            properties: { ...selected.properties, [property]: [{ frame: 0, value: n }] },
          },
    );
  }
  async function exportVideo(interchange = false) {
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    setPlaying(false);
    abort.current = new AbortController();
    try {
      const snapshot = structuredClone(value),
        result = await recordEditor(snapshot, artifacts, {
          signal: abort.current.signal,
          onProgress: setProgress,
        });
      const artifact = await saveArtifactFromBase64(
        await blobToBase64(result.blob),
        result.extension,
        { kind: "video", model: "assembly", prompt: t("Montage export") },
      );
      await onExportArtifact(artifact);
      if (interchange) {
        const output = await writeTimelineBundle(
          {
            name: t("Montage"),
            width: snapshot.width,
            height: snapshot.height,
            frameRate: snapshot.frameRate,
            clips: [
              {
                artifact,
                name: t("Rendered montage"),
                inSeconds: 0,
                outSeconds: durationFrames(snapshot) / fps(snapshot),
                sourceDurationSeconds: durationFrames(snapshot) / fps(snapshot),
                hasAudio: true,
              },
            ],
            editorDocument: JSON.stringify(snapshot),
            additionalMedia: editorMediaPaths(snapshot, artifacts),
          },
          format,
        );
        setStatus(
          [
            ...result.warnings,
            output.cancelled
              ? t("Export cancelled. Your montage is saved.")
              : t("Your montage bundle is ready."),
          ].join("\n"),
        );
      } else {
        await exportArtifact(artifact);
        setStatus([...result.warnings, t("Your video is saved in the gallery.")].join("\n"));
      }
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setBusy(false);
      setProgress(undefined);
      abort.current = undefined;
    }
  }
  async function exportInterchange() {
    if (exchangeProblems.length) {
      await exportVideo(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await writeTimelineBundle(
        { ...editorBundle(value, artifacts, t("Montage")), editorDocument: JSON.stringify(value) },
        format,
      );
      setStatus(
        result.cancelled
          ? t("Export cancelled. Your montage is saved.")
          : t("Your montage bundle is ready."),
      );
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setBusy(false);
    }
  }
  function finishDrag() {
    if (!drag) return;
    const clip = value.clips.find((clip) => clip.id === drag.id);
    setDrag(undefined);
    if (!clip) return;
    if (drag.mode === "move") {
      const start = Math.max(0, clip.start + drag.delta);
      update({
        ...clip,
        start: snap ? snapFrame(value, start, clip.id, (rate * 6) / zoom) : start,
      });
    } else if (drag.mode === "left") commit(resizeClipLeft(value, clip.id, drag.delta));
    else commit(resizeClip(value, clip.id, clip.duration + drag.delta));
  }
  const media = artifacts.filter((artifact) =>
    `${artifact.fileName} ${artifact.prompt}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section
      className="project-timeline"
      aria-label={t("Montage editor")}
      data-history={historyTick}
    >
      <div className="project-timeline-toolbar">
        <div className="project-timeline-actions">
          <button type="button" onClick={undo} disabled={!history.current.past.length || busy}>
            {t("Undo")}
          </button>
          <button type="button" onClick={redo} disabled={!history.current.future.length || busy}>
            {t("Redo")}
          </button>
          <button type="button" onClick={addTitle} disabled={busy}>
            {t("Add title")}
          </button>
        </div>
        <span className="project-timeline-time">
          {timecode(frame, rate)} / {timecode(duration, rate)}
        </span>
        <div className="project-timeline-actions">
          <button
            type="button"
            disabled={!duration || busy || problems.length > 0}
            onClick={() => void exportVideo()}
          >
            {t("Export film")}
          </button>
        </div>
      </div>
      {error && (
        <p className="project-timeline-error" role="alert">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {progress !== undefined && (
        <div className="project-timeline-progress">
          <progress value={progress} max={1} />
          <span>{t("Exporting: {percent}%", { percent: Math.round(progress * 100) })}</span>
          <button type="button" onClick={() => abort.current?.abort()}>
            {t("Cancel export")}
          </button>
        </div>
      )}
      <div className="project-timeline-workbench">
        <aside className="project-timeline-media">
          <h3>{t("Project media")}</h3>
          <input
            type="search"
            aria-label={t("Search media")}
            placeholder={t("Search media")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <p className="project-timeline-help">
            {t(
              "Add a take to the montage. Changing the selected take in a plan leaves this cut intact.",
            )}
          </p>
          <div className="project-timeline-media-list">
            {media.map((artifact) => (
              <button
                type="button"
                key={artifact.id}
                disabled={busy}
                className="project-timeline-media-item"
                onClick={() => void addArtifact(artifact)}
              >
                {artifact.kind === "image" ? (
                  <img src={artifactSrc(artifact)} alt="" loading="lazy" />
                ) : artifact.kind === "video" ? (
                  <video src={artifactSrc(artifact)} muted playsInline preload="metadata" />
                ) : (
                  <span className="project-timeline-audio-mark">
                    <IconSpeaker size={18} aria-hidden="true" />
                  </span>
                )}
                <span>
                  {artifact.prompt?.slice(0, 60) || artifact.fileName}
                  <small>{artifact.model}</small>
                </span>
                <IconPlusSmall size={16} aria-hidden="true" />
              </button>
            ))}
            {!media.length && <p>{t("Your project media will appear here.")}</p>}
          </div>
        </aside>
        <div className="project-timeline-monitor">
          <canvas ref={canvas} aria-label={t("Montage preview")} />
          <div className="project-timeline-transport">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPlaying(false);
                setFrame(Math.max(0, frame - 1));
              }}
              aria-label={t("Previous frame")}
            >
              <IconChevronLeft size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={!ready || !duration || busy || problems.length > 0}
              onClick={() => setPlaying(!playing)}
            >
              {playing ? t("Pause") : t("Play")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPlaying(false);
                setFrame(Math.min(Math.max(0, duration - 1), frame + 1));
              }}
              aria-label={t("Next frame")}
            >
              <IconChevronRight size={16} aria-hidden="true" />
            </button>
            <span>
              {value.width} × {value.height}
            </span>
          </div>
          <p className="project-timeline-help">
            {t("Export runs in real time. Keep the app open until it finishes.")}{" "}
            {pickRecorderMime()?.extension.toUpperCase()}
          </p>
        </div>
        <aside className="project-timeline-inspector">
          <h3>{t("Clip settings")}</h3>
          {selected ? (
            <fieldset disabled={locked || busy} className="project-timeline-inspector-fields">
              <label className="project-timeline-field">
                <span>{t("Name")}</span>
                <input
                  value={selected.name}
                  onChange={(event) => update({ ...selected, name: event.target.value })}
                />
              </label>
              {selected.title !== undefined && (
                <label className="project-timeline-field">
                  <span>{t("Title text")}</span>
                  <textarea
                    value={selected.title}
                    onChange={(event) => update({ ...selected, title: event.target.value })}
                  />
                </label>
              )}
              <label className="project-timeline-field">
                <span>{t("Track")}</span>
                <select
                  value={selected.trackId}
                  onChange={(event) => update({ ...selected, trackId: event.target.value })}
                >
                  {value.tracks
                    .filter(
                      (track) =>
                        track.kind ===
                        value.tracks.find((track) => track.id === selected.trackId)?.kind,
                    )
                    .map((track) => (
                      <option key={track.id} value={track.id} disabled={track.locked}>
                        {track.name}
                      </option>
                    ))}
                </select>
              </label>
              <NumberField
                label={t("Start (frames)")}
                value={selected.start}
                min={0}
                onChange={(start) => update({ ...selected, start: Math.round(start) })}
              />
              <NumberField
                label={t("Duration (frames)")}
                value={selected.duration}
                min={1}
                onChange={(duration) => commit(resizeClip(value, selected.id, duration))}
              />
              {selected.artifactId && (
                <NumberField
                  label={t("Source in (frames)")}
                  value={selected.sourceStart}
                  min={0}
                  max={selected.sourceDuration - 1}
                  onChange={(sourceStart) => update({ ...selected, sourceStart })}
                />
              )}
              <details open>
                <summary>{t("Transform and sound")}</summary>
                <label className="project-timeline-check">
                  <input
                    type="checkbox"
                    checked={keyframeMode}
                    onChange={(event) => setKeyframeMode(event.target.checked)}
                  />
                  {t("Keyframe at playhead")}
                </label>
                <p className="project-timeline-help">
                  {keyframeMode
                    ? t(
                        "Changes create a keyframe at the current frame. Values interpolate between keyframes.",
                      )
                    : t(
                        "Changes apply to the whole clip and replace existing keyframes for that property.",
                      )}
                </p>
                {(Object.keys(PROPERTY_LABELS) as AnimatedProperty[]).map((key) => (
                  <div key={key}>
                    <NumberField
                      label={PROPERTY_LABELS[key]()}
                      value={valueAt(selected.properties[key], local)}
                      min={
                        key === "speed"
                          ? 0.0625
                          : key === "scale"
                            ? 0.01
                            : key === "opacity" || key === "volume"
                              ? 0
                              : undefined
                      }
                      max={
                        key === "speed"
                          ? 16
                          : key === "opacity"
                            ? 1
                            : key === "volume"
                              ? 4
                              : undefined
                      }
                      step={key === "rotation" || key === "x" || key === "y" ? 1 : 0.05}
                      onChange={(n) => property(key, n)}
                    />
                    {selected.properties[key].length > 1 && (
                      <div className="project-timeline-keyframes">
                        {selected.properties[key].map((point) => (
                          <button
                            type="button"
                            key={point.frame}
                            onClick={() => setFrame(selected.start + point.frame)}
                            title={t("Go to keyframe")}
                          >
                            {point.frame}: {Number(point.value.toFixed(2))}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    update({
                      ...selected,
                      properties: Object.fromEntries(
                        Object.entries(selected.properties).map(([key, points]) => [
                          key,
                          points.length > 1
                            ? points.filter((point) => point.frame !== local)
                            : points,
                        ]),
                      ) as EditorClip["properties"],
                    })
                  }
                >
                  {t("Remove keyframes at playhead")}
                </button>
              </details>
              <details>
                <summary>{t("Fades and crop")}</summary>
                <NumberField
                  label={t("Fade in (frames)")}
                  value={selected.fadeIn}
                  min={0}
                  max={Math.max(selected.duration, selected.fadeIn)}
                  onChange={(fadeIn) =>
                    update({ ...selected, fadeIn: Math.round(fadeIn), fadeInOffset: 0 })
                  }
                />
                <NumberField
                  label={t("Fade out (frames)")}
                  value={selected.fadeOut}
                  min={0}
                  max={Math.max(selected.duration, selected.fadeOut)}
                  onChange={(fadeOut) =>
                    update({ ...selected, fadeOut: Math.round(fadeOut), fadeOutOffset: 0 })
                  }
                />
                {(
                  [
                    { key: "left", label: t("Crop left") },
                    { key: "right", label: t("Crop right") },
                    { key: "top", label: t("Crop top") },
                    { key: "bottom", label: t("Crop bottom") },
                  ] as const
                ).map(({ key, label }) => (
                  <NumberField
                    key={key}
                    label={label}
                    value={selected.crop[key]}
                    min={0}
                    max={0.49}
                    step={0.01}
                    onChange={(n) => update({ ...selected, crop: { ...selected.crop, [key]: n } })}
                  />
                ))}
              </details>
              <details>
                <summary>{t("Colour and blur")}</summary>
                {(
                  [
                    { key: "exposure", label: t("Exposure"), min: -5, max: 5 },
                    { key: "contrast", label: t("Contrast"), min: 0, max: 3 },
                    { key: "saturation", label: t("Saturation"), min: 0, max: 3 },
                    { key: "temperature", label: t("Temperature"), min: -2, max: 2 },
                    { key: "blur", label: t("Blur"), min: 0, max: 30 },
                  ] as const
                ).map(({ key, label, min, max }) => (
                  <NumberField
                    key={key}
                    label={label}
                    value={selected.grade[key]}
                    min={min}
                    max={max}
                    step={0.05}
                    onChange={(n) =>
                      update({ ...selected, grade: { ...selected.grade, [key]: n } })
                    }
                  />
                ))}
                <label className="project-timeline-field">
                  <span>{t("Import 3D LUT (.cube)")}</span>
                  <input
                    type="file"
                    accept=".cube"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file)
                        void file
                          .text()
                          .then((text) =>
                            update({
                              ...selected,
                              grade: { ...selected.grade, lut: parseCube(text, file.name) },
                            }),
                          )
                          .catch((cause) => setError(messageFromError(cause)));
                      event.target.value = "";
                    }}
                  />
                </label>
                {selected.grade.lut && (
                  <button
                    type="button"
                    onClick={() =>
                      update({ ...selected, grade: { ...selected.grade, lut: undefined } })
                    }
                  >
                    {t("Remove LUT: {name}", { name: selected.grade.lut.name })}
                  </button>
                )}
              </details>
              <details>
                <summary>{t("Colour curves")}</summary>
                <p className="project-timeline-help">
                  {t(
                    "Set output levels for shadows, quarter tones, midtones, three-quarter tones and highlights.",
                  )}
                </p>
                {(
                  [
                    { key: "master", label: t("Master") },
                    { key: "red", label: t("Red") },
                    { key: "green", label: t("Green") },
                    { key: "blue", label: t("Blue") },
                  ] as const
                ).map(({ key, label }) => (
                  <fieldset key={key} className="project-timeline-curve">
                    <legend>{label}</legend>
                    {selected.grade.curves[key].map((n, i) => (
                      <input
                        key={`${key}-${["shadows", "quarter", "midtones", "threeQuarter", "highlights"][i]}`}
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={n}
                        aria-label={t("{channel} curve point {point}", {
                          channel: label,
                          point: i + 1,
                        })}
                        onChange={(event) => {
                          const n = event.target.valueAsNumber;
                          if (Number.isFinite(n))
                            update({
                              ...selected,
                              grade: {
                                ...selected.grade,
                                curves: {
                                  ...selected.grade.curves,
                                  [key]: selected.grade.curves[key].map((old, j) =>
                                    i === j ? Math.max(0, Math.min(1, n)) : old,
                                  ),
                                },
                              },
                            });
                        }}
                      />
                    ))}
                  </fieldset>
                ))}
              </details>
            </fieldset>
          ) : (
            <p className="project-timeline-help">
              {t("Select a clip to trim it, change its speed or adjust its picture and sound.")}
            </p>
          )}
          {locked && <p>{t("Unlock this track to edit the clip.")}</p>}
        </aside>
      </div>
      <div className="project-timeline-cut-toolbar">
        <div className="project-timeline-actions">
          <button
            type="button"
            disabled={
              !selected ||
              locked ||
              busy ||
              frame <= selected.start ||
              frame >= selected.start + selected.duration
            }
            onClick={() => selected && commit(splitClip(value, selected.id, frame))}
          >
            {t("Split at playhead")}
          </button>
          <button
            type="button"
            disabled={!selected || locked || busy}
            onClick={() => selected && commit(duplicateClip(value, selected.id))}
          >
            {t("Duplicate")}
          </button>
          <button
            type="button"
            disabled={!selected || locked || busy}
            onClick={() => selected && commit(removeClip(value, selected.id))}
          >
            {t("Delete")}
          </button>
          <button
            type="button"
            disabled={!selected || locked || busy}
            onClick={() => selected && commit(removeClip(value, selected.id, true))}
          >
            {t("Delete and close gap")}
          </button>
        </div>
        <label className="project-timeline-check">
          <input
            type="checkbox"
            checked={snap}
            onChange={(event) => setSnap(event.target.checked)}
          />
          {t("Snap")}
        </label>
        <label className="project-timeline-check">
          {t("Zoom")}
          <input
            type="range"
            min={10}
            max={240}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
        </label>
      </div>
      <div className="project-timeline-scroll">
        <div
          className="project-timeline-track-sheet"
          style={{ minWidth: Math.max(700, (end / rate) * zoom + 160) }}
        >
          <div className="project-timeline-ruler">
            <span>{t("Tracks")}</span>
            <input
              type="range"
              min={0}
              max={Math.max(1, end - 1)}
              value={Math.min(frame, Math.max(1, end - 1))}
              style={{ width: (end / rate) * zoom }}
              aria-label={t("Playhead")}
              onChange={(event) => {
                setPlaying(false);
                setFrame(Number(event.target.value));
              }}
            />
          </div>
          {value.tracks.map((track) => (
            <div className="project-timeline-track-row" key={track.id}>
              <div className="project-timeline-track-label">
                <input
                  aria-label={t("Track name")}
                  value={track.name}
                  disabled={busy}
                  onChange={(event) => updateTrack({ ...track, name: event.target.value })}
                />
                <div>
                  <button
                    type="button"
                    aria-pressed={track.locked}
                    disabled={busy}
                    onClick={() => updateTrack({ ...track, locked: !track.locked })}
                  >
                    {track.locked ? t("Unlock") : t("Lock")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={track.muted}
                    disabled={busy}
                    onClick={() => updateTrack({ ...track, muted: !track.muted })}
                  >
                    {track.muted ? t("Unmute") : t("Mute")}
                  </button>
                  {track.kind === "video" && (
                    <button
                      type="button"
                      aria-pressed={track.hidden}
                      disabled={busy}
                      onClick={() => updateTrack({ ...track, hidden: !track.hidden })}
                    >
                      {track.hidden ? t("Show") : t("Hide")}
                    </button>
                  )}
                </div>
              </div>
              <div className="project-timeline-lane" style={{ backgroundSize: `${zoom}px 100%` }}>
                <div
                  className="project-timeline-playhead"
                  style={{ left: (frame / rate) * zoom }}
                />
                {value.clips
                  .filter((clip) => clip.trackId === track.id)
                  .map((clip) => {
                    const moving = drag?.id === clip.id ? drag : undefined;
                    const start =
                      clip.start +
                      (moving?.mode === "move"
                        ? moving.delta
                        : moving?.mode === "left"
                          ? Math.max(0, moving.delta)
                          : 0);
                    const length =
                      clip.duration +
                      (moving?.mode === "left"
                        ? -Math.max(0, moving.delta)
                        : moving?.mode === "right"
                          ? Math.min(0, moving.delta)
                          : 0);
                    return (
                      <div
                        className={`project-timeline-clip${clip.id === selectedId ? " is-selected" : ""}${track.kind === "audio" ? " is-audio" : ""}`}
                        key={clip.id}
                        style={{
                          left: (Math.max(0, start) / rate) * zoom,
                          width: (Math.max(1, length) / rate) * zoom,
                        }}
                      >
                        <button
                          type="button"
                          className="project-timeline-trim-handle"
                          aria-label={t("Trim clip start")}
                          disabled={track.locked || busy}
                          onPointerDown={(event) => {
                            event.currentTarget.setPointerCapture(event.pointerId);
                            setSelectedId(clip.id);
                            setDrag({ id: clip.id, mode: "left", origin: event.clientX, delta: 0 });
                          }}
                          onPointerMove={(event) => {
                            if (drag?.id === clip.id && drag.mode === "left")
                              setDrag({
                                ...drag,
                                delta: Math.min(
                                  clip.duration - 1,
                                  Math.round(((event.clientX - drag.origin) * rate) / zoom),
                                ),
                              });
                          }}
                          onPointerUp={finishDrag}
                          onPointerCancel={() => setDrag(undefined)}
                        />
                        <button
                          type="button"
                          className="project-timeline-clip-body"
                          aria-pressed={clip.id === selectedId}
                          onClick={() => {
                            setSelectedId(clip.id);
                            if (!playing) setFrame(clip.start);
                          }}
                          onPointerDown={(event) => {
                            setSelectedId(clip.id);
                            if (track.locked || busy) return;
                            event.currentTarget.setPointerCapture(event.pointerId);
                            setDrag({ id: clip.id, mode: "move", origin: event.clientX, delta: 0 });
                          }}
                          onPointerMove={(event) => {
                            if (drag?.id === clip.id && drag.mode === "move")
                              setDrag({
                                ...drag,
                                delta: Math.round(((event.clientX - drag.origin) * rate) / zoom),
                              });
                          }}
                          onPointerUp={finishDrag}
                          onPointerCancel={() => setDrag(undefined)}
                        >
                          <span>{clip.name}</span>
                          <small>{timecode(clip.duration, rate)}</small>
                        </button>
                        <button
                          type="button"
                          className="project-timeline-trim-handle"
                          aria-label={t("Trim clip end")}
                          disabled={track.locked || busy}
                          onPointerDown={(event) => {
                            event.currentTarget.setPointerCapture(event.pointerId);
                            setSelectedId(clip.id);
                            setDrag({
                              id: clip.id,
                              mode: "right",
                              origin: event.clientX,
                              delta: 0,
                            });
                          }}
                          onPointerMove={(event) => {
                            if (drag?.id === clip.id && drag.mode === "right")
                              setDrag({
                                ...drag,
                                delta: Math.max(
                                  1 - clip.duration,
                                  Math.round(((event.clientX - drag.origin) * rate) / zoom),
                                ),
                              });
                          }}
                          onPointerUp={finishDrag}
                          onPointerCancel={() => setDrag(undefined)}
                        />
                      </div>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="project-timeline-footer">
        <div className="project-timeline-actions">
          {(["video", "audio"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={busy}
              onClick={() =>
                commit({
                  ...value,
                  tracks: [
                    ...value.tracks,
                    {
                      id: crypto.randomUUID(),
                      name: kind === "video" ? t("Picture track") : t("Audio track"),
                      kind,
                      locked: false,
                      muted: false,
                      hidden: false,
                    },
                  ],
                })
              }
            >
              {kind === "video" ? t("Add picture track") : t("Add audio track")}
            </button>
          ))}
        </div>
        <span className="project-timeline-help">
          {t(
            "Drag clips to move them. Drag their edges inward to trim. Positions and cuts use whole frames.",
          )}
        </span>
      </div>
      {!!problems.length && (
        <ul className="project-timeline-error">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <details className="project-timeline-exchange">
        <summary>{t("Export an editable montage")}</summary>
        <p>
          {t(
            "The bundle contains copies of your media and the original Sub Rosa montage document.",
          )}
        </p>
        <label className="project-timeline-field">
          <span>{t("Format")}</span>
          <select
            value={format}
            onChange={(event) => setFormat(event.target.value as TimelineFormat)}
          >
            <option value="fcpxml">{t("Final Cut Pro and Resolve")}</option>
            <option value="xmeml">{t("Premiere Pro")}</option>
          </select>
        </label>
        {!!exchangeProblems.length && (
          <p role="status">
            {t(
              "These edits need to be rendered into the exported video: {effects}. The original Sub Rosa montage keeps them editable.",
              { effects: exchangeProblems.join(", ") },
            )}
          </p>
        )}
        <button
          type="button"
          disabled={busy || !duration || problems.length > 0}
          onClick={() => void exportInterchange()}
        >
          {exchangeProblems.length ? t("Render and export bundle") : t("Export montage bundle")}
        </button>
      </details>
    </section>
  );
}
