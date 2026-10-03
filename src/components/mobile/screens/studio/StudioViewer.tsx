// The viewer: one gallery item, full screen, on black. Swipe sideways to the
// next one, pull down to go back, double tap or pinch to look closer at a
// picture. Clips and tracks get their own quiet controls instead of the
// system bar, which covered the picture and offered nothing this app does.
// What the item is (prompt, model, size, length, price) lives one tap away,
// in a panel, rather than under the picture.

import { IconHeart as IconHeartFilled } from "central-icons-filled/IconHeart";
import { IconPause } from "central-icons-filled/IconPause";
import { IconPlay } from "central-icons-filled/IconPlay";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconClipboard } from "central-icons/IconClipboard";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconHeart } from "central-icons/IconHeart";
import { IconRetouch } from "central-icons/IconRetouch";
import { IconShareOs } from "central-icons/IconShareOs";
import { IconSquareArrowDown } from "central-icons/IconSquareArrowDown";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { IconVideoClip } from "central-icons/IconVideoClip";
import { IconVolumeFull } from "central-icons/IconVolumeFull";
import { IconVolumeOff } from "central-icons/IconVolumeOff";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  useArtifactDataUrl,
  usePlayableMediaUrl,
  useTrackShape,
} from "../../../../lib/artifact-media";
import { hapticNotify, hapticSelection } from "../../../../lib/haptics";
import { intlLocale, t } from "../../../../lib/i18n";
import { isMobilePlatform } from "../../../../lib/mobile";
import { useModalFocus } from "../../../../lib/modal-focus";
import { readArtifactBase64, saveArtifactFromBase64 } from "../../../../lib/studio/artifacts";
import { formatCredits } from "../../../../lib/studio/catalog";
import { darkroomWave } from "../../../../lib/studio/darkroom";
import { removeBackground, upscaleImage } from "../../../../lib/studio/edit-image";
import {
  canMark,
  EMPTY_LIBRARY,
  loadLibrary,
  markArtifacts,
  markOf,
  type StudioLibrary,
  withMarks,
} from "../../../../lib/studio/library";
import { requestRetouch, shareVersionFile } from "../../../../lib/studio/retouch/jobs";
import type { ArtifactKind, StudioArtifact } from "../../../../lib/studio/types";
import { saveToPhotos } from "../../../../lib/tauri";
import { Spinner } from "../../../ui/Spinner";
import { ActionSheet } from "../../ActionSheet";
import { sheetHost } from "../../sheet-host";
import { markMediaPlayback } from "./StudioControls";
import { formatClipLength } from "./StudioLibrary";

const AUDIO_KINDS: ArtifactKind[] = ["music", "speech", "sfx"];
/** A clip this short plays as a loop, the way a moving photo does. */
const LOOP_UNDER_SECONDS = 15;
/** How long playback controls stay up once untouched. */
const CONTROLS_IDLE_MS = 3000;
const MAX_ZOOM = 4;

export function StudioViewer({
  artifact,
  among,
  onNavigate,
  onClose,
  onDelete,
  onContinueShot,
  onReusePrompt,
  onUseAsReference,
  onUpscaled,
  onMarked,
  canRemoveBackground = false,
}: {
  artifact: StudioArtifact;
  /** The list it was opened from, in order, for the neighbours. */
  among: StudioArtifact[];
  onNavigate: (artifact: StudioArtifact) => void;
  onClose: () => void;
  onDelete: () => void;
  onContinueShot?: () => void;
  onReusePrompt?: () => void;
  onUseAsReference?: () => void;
  onUpscaled: () => void;
  /** Told after a mark changed here, so the gallery behind rereads. */
  onMarked?: () => void;
  canRemoveBackground?: boolean;
}) {
  const index = among.findIndex((entry) => entry.path === artifact.path);
  const previous = index > 0 ? among[index - 1] : undefined;
  const next = index >= 0 && index < among.length - 1 ? among[index + 1] : undefined;
  const [library, setLibrary] = useState<StudioLibrary>(EMPTY_LIBRARY);
  const [infoOpen, setInfoOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Focus lands on the position line, not on Close: a ring around the first
  // button is the one thing a finger never asked for (spec/modal-focus.md).
  useModalFocus(rootRef, {
    onClose,
    lockScroll: true,
    initialFocusSelector: "[data-initial-focus]",
  });

  useEffect(() => {
    loadLibrary()
      .then(setLibrary)
      .catch(() => undefined);
  }, []);
  // A new item starts unzoomed, with its chrome showing: state adjusted while
  // rendering, so the next picture never paints at the last one's zoom.
  const [shownPath, setShownPath] = useState(artifact.path);
  if (shownPath !== artifact.path) {
    setShownPath(artifact.path);
    setZoom({ scale: 1, x: 0, y: 0 });
    setChrome(true);
  }

  const noticeTimer = useRef<number | undefined>(undefined);
  const flash = useCallback((text: string) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 1600);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const mark = markOf(library, artifact);
  const toggleFavorite = () => {
    const change = { favorite: !mark?.favorite };
    setLibrary((current) => withMarks(current, [artifact], change));
    hapticSelection();
    markArtifacts([artifact], change)
      .then(() => onMarked?.())
      .catch(() => hapticNotify("error"));
  };

  const go = useCallback(
    (target: StudioArtifact | undefined) => {
      if (!target) return;
      hapticSelection();
      onNavigate(target);
    },
    [onNavigate],
  );

  // Keyboard, for the desktop browser the shell is developed in.
  useEffect(() => {
    // Not while a sheet or the info panel is up: the arrows belong to them.
    if (confirming || infoOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") go(previous);
      if (event.key === "ArrowRight") go(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, previous, next, confirming, infoOpen]);

  // Sideways to move, down to close. The axis is decided by the first ten
  // pixels, so a vertical scrub of a slider or a pan of a zoomed picture is
  // never taken for either.
  const gesture = useRef<{
    x: number;
    y: number;
    t: number;
    axis: "x" | "y" | null;
    pan?: { x: number; y: number };
  } | null>(null);
  const onTouchStart = (event: React.TouchEvent) => {
    if (event.touches.length !== 1) {
      gesture.current = null;
      return;
    }
    if ((event.target as HTMLElement).closest("[data-viewer-control]")) return;
    const touch = event.touches[0];
    gesture.current = {
      x: touch.clientX,
      y: touch.clientY,
      t: event.timeStamp,
      axis: null,
      pan: zoom.scale > 1 ? { x: zoom.x, y: zoom.y } : undefined,
    };
  };
  const onTouchMove = (event: React.TouchEvent) => {
    const state = gesture.current;
    const touch = event.touches[0];
    if (!state || !touch) return;
    const dx = touch.clientX - state.x;
    const dy = touch.clientY - state.y;
    if (state.pan) {
      // Panned within what the zoom brought into reach, so the picture can
      // never be pushed out of its own frame.
      const box = rootRef.current?.getBoundingClientRect();
      setZoom((current) => {
        const limitX = box ? ((current.scale - 1) * box.width) / 2 : Number.POSITIVE_INFINITY;
        const limitY = box ? ((current.scale - 1) * box.height) / 2 : Number.POSITIVE_INFINITY;
        const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
        return {
          ...current,
          x: clamp((state.pan?.x ?? 0) + dx, limitX),
          y: clamp((state.pan?.y ?? 0) + dy, limitY),
        };
      });
      return;
    }
    if (!state.axis) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) state.axis = "x";
      else if (dy > 10 && dy > Math.abs(dx)) state.axis = "y";
      else return;
    }
    if (state.axis === "x") {
      // Resistance past either end: the list says there is nothing there.
      const edge = (dx > 0 && !previous) || (dx < 0 && !next);
      setDrag({ x: edge ? dx / 3 : dx, y: 0 });
    } else {
      setDrag({ x: 0, y: Math.max(0, dy) });
    }
  };
  const onTouchEnd = (event: React.TouchEvent) => {
    const state = gesture.current;
    gesture.current = null;
    if (!state || state.pan || !drag) {
      setDrag(null);
      return;
    }
    const elapsed = Math.max(1, event.timeStamp - state.t);
    const width = rootRef.current?.clientWidth ?? 390;
    if (state.axis === "x") {
      const fast = Math.abs(drag.x) / elapsed > 0.5;
      if ((drag.x < -width * 0.25 || (fast && drag.x < -30)) && next) go(next);
      else if ((drag.x > width * 0.25 || (fast && drag.x > 30)) && previous) go(previous);
    } else if (state.axis === "y" && (drag.y > 140 || drag.y / elapsed > 0.6)) {
      onClose();
      return;
    }
    setDrag(null);
  };

  const audio = AUDIO_KINDS.includes(artifact.kind);
  const pulled = drag && drag.y > 0 ? Math.min(1, drag.y / 300) : 0;
  const stageStyle: CSSProperties = drag
    ? {
        transform: `translate(${drag.x}px, ${drag.y}px) scale(${1 - pulled * 0.15})`,
        transition: "none",
      }
    : {};

  return createPortal(
    <div
      ref={rootRef}
      className="viewer"
      role="dialog"
      aria-modal="true"
      aria-label={artifact.prompt?.trim() || t("Media preview")}
      tabIndex={-1}
      data-chrome={chrome ? "true" : undefined}
      style={{ "--viewer-pull": `${1 - pulled}` } as CSSProperties}
    >
      <div className="viewer-backdrop" aria-hidden />
      <header className="viewer-top" data-viewer-control>
        <button type="button" className="viewer-icon" aria-label={t("Close")} onClick={onClose}>
          <IconCrossMedium size={20} />
        </button>
        <span className="viewer-count" data-initial-focus tabIndex={-1}>
          {index >= 0 && among.length > 1
            ? t("{position} of {total}", { position: index + 1, total: among.length })
            : ""}
        </span>
        <button
          type="button"
          className="viewer-icon"
          aria-label={t("About this item")}
          aria-pressed={infoOpen}
          onClick={() => setInfoOpen((open) => !open)}
        >
          <IconCircleInfo size={20} />
        </button>
      </header>

      <div
        className="viewer-stage"
        style={stageStyle}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        {artifact.kind === "image" ? (
          <ViewerImage
            key={artifact.path}
            artifact={artifact}
            zoom={zoom}
            onZoom={setZoom}
            onTap={() => setChrome((shown) => !shown)}
          />
        ) : artifact.kind === "video" ? (
          <ViewerVideo key={artifact.path} artifact={artifact} onChrome={setChrome} />
        ) : audio ? (
          <ViewerTrack key={artifact.path} artifact={artifact} />
        ) : null}
      </div>

      <footer className="viewer-bar" data-viewer-control>
        {isMobilePlatform() ? (
          <ViewerAction
            label={t("Share")}
            icon={<IconShareOs size={22} />}
            onAction={() => void shareVersionFile(artifact.path).catch(() => hapticNotify("error"))}
          />
        ) : null}
        {isMobilePlatform() && (artifact.kind === "image" || artifact.kind === "video") ? (
          <ViewerAction
            label={t("Save to Photos")}
            icon={<IconSquareArrowDown size={22} />}
            onAction={() =>
              void saveToPhotos(artifact.path, artifact.kind === "video" ? "video" : "image")
                .then(() => {
                  hapticNotify("success");
                  flash(t("Saved to Photos"));
                })
                .catch(() => hapticNotify("error"))
            }
          />
        ) : null}
        {canMark(artifact) ? (
          <ViewerAction
            label={mark?.favorite ? t("Remove from favorites") : t("Add to favorites")}
            icon={mark?.favorite ? <IconHeartFilled size={22} /> : <IconHeart size={22} />}
            active={Boolean(mark?.favorite)}
            onAction={toggleFavorite}
          />
        ) : null}
        {artifact.kind === "video" && onContinueShot ? (
          <ViewerAction
            label={t("Continue this shot")}
            icon={<IconVideoClip size={22} />}
            onAction={onContinueShot}
          />
        ) : null}
        {artifact.kind === "image" ? (
          <ViewerAction
            label={t("Touch up")}
            icon={<IconRetouch size={22} />}
            onAction={() => {
              onClose();
              requestRetouch(artifact.id);
            }}
          />
        ) : null}
        <ViewerAction
          label={t("Delete")}
          icon={<IconTrashCan size={22} />}
          destructive
          onAction={() => setConfirming(true)}
        />
      </footer>

      {notice ? (
        <p className="viewer-notice" role="status">
          {notice}
        </p>
      ) : null}

      {infoOpen ? (
        <ViewerInfo
          artifact={artifact}
          folder={
            library.collections.find((collection) => collection.id === mark?.collectionId)?.name
          }
          onClose={() => setInfoOpen(false)}
          onReusePrompt={artifact.kind === "image" ? onReusePrompt : undefined}
          onUseAsReference={onUseAsReference}
          onMade={() => {
            onUpscaled();
            onClose();
          }}
          canRemoveBackground={canRemoveBackground}
          onCopied={() => flash(t("Prompt copied"))}
        />
      ) : null}

      {confirming ? (
        <ActionSheet
          title={t("Delete this item?")}
          subtitle={t("They are deleted from this device and from your other synced devices.")}
          actions={[{ label: t("Delete"), destructive: true, onAction: onDelete }]}
          closeLabel={t("Cancel")}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </div>,
    sheetHost(),
  );
}

function ViewerAction({
  label,
  icon,
  onAction,
  active,
  destructive,
}: {
  label: string;
  icon: ReactNode;
  onAction: () => void;
  active?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      className="viewer-action"
      aria-label={label}
      title={label}
      data-active={active ? "true" : undefined}
      data-destructive={destructive ? "true" : undefined}
      onClick={onAction}
    >
      {icon}
    </button>
  );
}

/** A picture: double tap to look closer where you tapped, pinch for the
 * rest, drag to move around once closer. */
function ViewerImage({
  artifact,
  zoom,
  onZoom,
  onTap,
}: {
  artifact: StudioArtifact;
  zoom: { scale: number; x: number; y: number };
  onZoom: (zoom: { scale: number; x: number; y: number }) => void;
  onTap: () => void;
}) {
  const src = useArtifactDataUrl(artifact);
  const lastTap = useRef(0);
  const tapTimer = useRef<number | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);
  const pinchFrom = useRef(1);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const start = (event: Event) => {
      event.preventDefault();
      pinchFrom.current = zoom.scale;
    };
    const change = (event: Event) => {
      event.preventDefault();
      const scale = (event as Event & { scale?: number }).scale ?? 1;
      const next = Math.min(MAX_ZOOM, Math.max(1, pinchFrom.current * scale));
      onZoom(next === 1 ? { scale: 1, x: 0, y: 0 } : { ...zoom, scale: next });
    };
    element.addEventListener("gesturestart", start);
    element.addEventListener("gesturechange", change);
    return () => {
      element.removeEventListener("gesturestart", start);
      element.removeEventListener("gesturechange", change);
    };
  }, [zoom, onZoom]);

  useEffect(() => () => window.clearTimeout(tapTimer.current), []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the viewer's own keys (arrows, Escape) cover it.
    // biome-ignore lint/a11y/noStaticElementInteractions: a picture to look at, not a control.
    <div
      ref={ref}
      className="viewer-picture"
      onClick={(event) => {
        const now = Date.now();
        if (now - lastTap.current < 280) {
          window.clearTimeout(tapTimer.current);
          lastTap.current = 0;
          if (zoom.scale > 1) {
            onZoom({ scale: 1, x: 0, y: 0 });
          } else {
            const box = event.currentTarget.getBoundingClientRect();
            const scale = 2.5;
            // Keep the tapped point under the finger.
            const x = (box.width / 2 - (event.clientX - box.left)) * (scale - 1);
            const y = (box.height / 2 - (event.clientY - box.top)) * (scale - 1);
            onZoom({ scale, x, y });
          }
          return;
        }
        lastTap.current = now;
        tapTimer.current = window.setTimeout(onTap, 280);
      }}
    >
      {src ? (
        <img
          src={src}
          alt={artifact.prompt || t("Generated image")}
          draggable={false}
          style={{
            transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
          }}
        />
      ) : (
        <Spinner />
      )}
    </div>
  );
}

function useMediaClock(element: HTMLMediaElement | null) {
  const [state, setState] = useState({ time: 0, duration: 0, playing: false, muted: false });
  useEffect(() => {
    if (!element) return;
    const read = () =>
      setState({
        time: element.currentTime,
        duration: Number.isFinite(element.duration) ? element.duration : 0,
        playing: !element.paused && !element.ended,
        muted: element.muted,
      });
    const events = [
      "timeupdate",
      "durationchange",
      "play",
      "pause",
      "ended",
      "volumechange",
      "loadedmetadata",
    ];
    for (const name of events) element.addEventListener(name, read);
    read();
    return () => {
      for (const name of events) element.removeEventListener(name, read);
    };
  }, [element]);
  return state;
}

function togglePlay(element: HTMLMediaElement | null) {
  if (!element) return;
  if (element.paused || element.ended) void element.play().catch(() => undefined);
  else element.pause();
}

/** Where the playhead is, and a slider to move it. */
function Scrubber({
  element,
  time,
  duration,
}: {
  element: HTMLMediaElement | null;
  time: number;
  duration: number;
}) {
  return (
    <div className="viewer-scrubber" data-viewer-control>
      <span className="viewer-time">{formatClipLength(time)}</span>
      <input
        type="range"
        min={0}
        max={duration || 1}
        step={0.05}
        value={Math.min(time, duration || 1)}
        aria-label={t("Position")}
        style={{ "--progress": `${duration ? (time / duration) * 100 : 0}%` } as CSSProperties}
        onChange={(event) => {
          if (element) element.currentTime = Number(event.target.value);
        }}
      />
      <span className="viewer-time">
        {duration ? `-${formatClipLength(Math.max(0, duration - time))}` : ""}
      </span>
    </div>
  );
}

function ViewerVideo({
  artifact,
  onChrome,
}: {
  artifact: StudioArtifact;
  onChrome: (shown: boolean) => void;
}) {
  const { src, onError } = usePlayableMediaUrl(artifact);
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const clock = useMediaClock(element);
  const [controls, setControls] = useState(true);
  const idle = useRef<number | undefined>(undefined);
  const short =
    (artifact.durationMs ? artifact.durationMs / 1000 : clock.duration) > 0 &&
    (artifact.durationMs ? artifact.durationMs / 1000 : clock.duration) < LOOP_UNDER_SECONDS;

  const show = useCallback(() => {
    setControls(true);
    onChrome(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => {
      if (element && !element.paused) {
        setControls(false);
        onChrome(false);
      }
    }, CONTROLS_IDLE_MS);
  }, [element, onChrome]);

  useEffect(() => {
    if (clock.playing) show();
    else {
      window.clearTimeout(idle.current);
      setControls(true);
      onChrome(true);
    }
  }, [clock.playing, show, onChrome]);
  useEffect(() => () => window.clearTimeout(idle.current), []);

  return (
    <div className="viewer-clip" data-controls={controls ? "true" : undefined}>
      {src ? (
        // biome-ignore lint/a11y/useMediaCaption: a generated clip has no captions to offer.
        <video
          ref={setElement}
          src={src}
          autoPlay
          playsInline
          loop={short}
          preload="auto"
          onError={onError}
          onClick={() => (controls ? setControls(false) : show())}
          onPlay={() => markMediaPlayback(true)}
          onPause={() => markMediaPlayback(false)}
          onEnded={() => markMediaPlayback(false)}
        />
      ) : (
        <Spinner />
      )}
      <button
        type="button"
        className="viewer-play"
        data-viewer-control
        aria-label={clock.playing ? t("Pause") : t("Play")}
        onClick={() => {
          togglePlay(element);
          show();
        }}
      >
        {clock.playing ? <IconPause size={28} /> : <IconPlay size={28} />}
      </button>
      <div className="viewer-clip-controls" data-viewer-control>
        <Scrubber element={element} time={clock.time} duration={clock.duration} />
        <button
          type="button"
          className="viewer-icon"
          aria-label={clock.muted ? t("Turn sound on") : t("Mute")}
          onClick={() => {
            if (element) element.muted = !element.muted;
            show();
          }}
        >
          {clock.muted ? <IconVolumeOff size={18} /> : <IconVolumeFull size={18} />}
        </button>
      </div>
    </div>
  );
}

/** A track: its silhouette, filling as it plays, under one round button. */
function ViewerTrack({ artifact }: { artifact: StudioArtifact }) {
  const { src, onError } = usePlayableMediaUrl(artifact);
  const shape = useTrackShape(artifact);
  const [element, setElement] = useState<HTMLAudioElement | null>(null);
  const clock = useMediaClock(element);
  const bars = useMemo(
    () => (shape?.peaks.length ? shape.peaks : darkroomWave(artifact.path, 48)),
    [shape, artifact.path],
  );
  const played = clock.duration ? clock.time / clock.duration : 0;
  return (
    <div className="viewer-track">
      {src ? (
        // biome-ignore lint/a11y/useMediaCaption: a generated track has no captions to offer.
        <audio
          ref={setElement}
          src={src}
          autoPlay
          preload="auto"
          onError={onError}
          onPlay={() => markMediaPlayback(true)}
          onPause={() => markMediaPlayback(false)}
          onEnded={() => markMediaPlayback(false)}
        />
      ) : null}
      <p className="viewer-track-title">{artifact.prompt?.trim() || t("Track")}</p>
      <div className="viewer-track-wave" aria-hidden>
        {bars.map((height, barIndex) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: a bar's position is its identity
            key={barIndex}
            data-played={barIndex / bars.length < played ? "true" : undefined}
            style={{ "--bar": `${Math.max(0.06, height)}` } as CSSProperties}
          />
        ))}
      </div>
      <button
        type="button"
        className="viewer-play viewer-play-track"
        data-viewer-control
        aria-label={clock.playing ? t("Pause") : t("Play")}
        onClick={() => togglePlay(element)}
      >
        {clock.playing ? <IconPause size={28} /> : <IconPlay size={28} />}
      </button>
      <Scrubber element={element} time={clock.time} duration={clock.duration} />
    </div>
  );
}

/** What the item is, and what can still be made from it. */
function ViewerInfo({
  artifact,
  folder,
  onClose,
  onReusePrompt,
  onUseAsReference,
  onMade,
  canRemoveBackground,
  onCopied,
}: {
  artifact: StudioArtifact;
  folder?: string;
  onClose: () => void;
  onReusePrompt?: () => void;
  onUseAsReference?: () => void;
  onMade: () => void;
  canRemoveBackground: boolean;
  onCopied: () => void;
}) {
  const [working, setWorking] = useState<"x2" | "x4" | "cutout" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A panel over the viewer: focus goes in, Tab stays, Escape closes the
  // panel alone (spec/modal-focus.md; the hook's stack leaves the viewer's own
  // Escape underneath).
  const panelRef = useRef<HTMLElement>(null);
  useModalFocus(panelRef, { onClose, initialFocusSelector: ".viewer-info-close" });

  const make = async (kind: "x2" | "x4" | "cutout") => {
    if (working) return;
    setWorking(kind);
    setError(null);
    try {
      const base64 = await readArtifactBase64(artifact);
      const result =
        kind === "cutout"
          ? await removeBackground(base64)
          : await upscaleImage(base64, kind === "x2" ? 2 : 4);
      await saveArtifactFromBase64(result, "png", {
        kind: "image",
        model: kind === "cutout" ? "background-remover" : "upscale",
        prompt: `${artifact.prompt?.trim() || t("Image")} (${kind === "cutout" ? "cutout" : kind})`,
      });
      hapticNotify("success");
      onMade();
    } catch (err) {
      hapticNotify("error");
      setError(
        err instanceof Error
          ? t(err.message)
          : kind === "cutout"
            ? t("The cutout failed.")
            : t("The upscale failed."),
      );
    } finally {
      setWorking(null);
    }
  };

  const rows: [string, string][] = [];
  if (artifact.model) rows.push([t("Model"), artifact.model]);
  rows.push([
    t("Made"),
    new Date(artifact.createdAt).toLocaleString(intlLocale(), {
      dateStyle: "medium",
      timeStyle: "short",
    }),
  ]);
  if (artifact.width && artifact.height) {
    rows.push([t("Size"), `${artifact.width} × ${artifact.height}`]);
  }
  if (artifact.durationMs) rows.push([t("Length"), formatClipLength(artifact.durationMs / 1000)]);
  if (typeof artifact.costCredits === "number") {
    rows.push([t("Price"), formatCredits(artifact.costCredits)]);
  }
  if (folder) rows.push([t("Folder"), folder]);

  return (
    <section
      ref={panelRef}
      className="viewer-info"
      data-viewer-control
      role="dialog"
      aria-modal="true"
      aria-label={t("About this item")}
      tabIndex={-1}
    >
      <div className="viewer-info-grabber" aria-hidden />
      {artifact.prompt?.trim() ? (
        <div className="viewer-info-prompt">
          <p>{artifact.prompt}</p>
          <button
            type="button"
            className="viewer-chip"
            onClick={() =>
              void writeText(artifact.prompt)
                .then(onCopied)
                .catch(() => undefined)
            }
          >
            <IconClipboard size={14} aria-hidden />
            {t("Copy prompt")}
          </button>
          {onReusePrompt ? (
            <button type="button" className="viewer-chip" onClick={onReusePrompt}>
              {t("Reuse the prompt")}
            </button>
          ) : null}
        </div>
      ) : null}
      <dl className="viewer-info-rows">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {artifact.kind === "image" ? (
        <div className="viewer-info-actions">
          <button
            type="button"
            className="viewer-chip"
            disabled={working !== null}
            onClick={() => void make("x2")}
          >
            {working === "x2" ? <Spinner /> : t("Upscale x2")}
          </button>
          <button
            type="button"
            className="viewer-chip"
            disabled={working !== null}
            onClick={() => void make("x4")}
          >
            {working === "x4" ? <Spinner /> : t("Upscale x4")}
          </button>
          {canRemoveBackground ? (
            <button
              type="button"
              className="viewer-chip"
              disabled={working !== null}
              onClick={() => void make("cutout")}
            >
              {working === "cutout" ? <Spinner /> : t("Remove background")}
            </button>
          ) : null}
          {onUseAsReference ? (
            <button type="button" className="viewer-chip" onClick={onUseAsReference}>
              {t("Use as reference")}
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="viewer-info-error">{error}</p> : null}
      <button type="button" className="viewer-info-close" onClick={onClose}>
        {t("Close")}
      </button>
    </section>
  );
}
