// The stage of a retouch: the version on screen, as large as the room allows.
//
// Everything that happens to the picture happens here, on top of it, at the
// picture's own size: the darkroom's grain while a retouch renders, the new
// version wiping in when it lands, the version before it for comparison, and
// the zone the person paints. Shared by the desktop tab and the phone screen.

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { t } from "../../../lib/i18n";
import { formatElapsed } from "../../../lib/studio/async-job";
import { darkroomSeed, darkroomVars } from "../../../lib/studio/darkroom";
import { describeRemaining, waitProgress } from "../../../lib/studio/render-eta";
import type { Point, ZoneStroke } from "../../../lib/studio/retouch/zone";

export type CompareMode = "off" | "hold" | "split";
export type ZoneTool = "brush" | "lasso" | "eraser";

export interface CanvasWait {
  seed: string;
  phase: "queueing" | "queued" | "processing";
  startedAt: number;
  estimateMs?: number;
  label?: string;
}

export interface CanvasZone {
  tool: ZoneTool;
  /** Brush radius on screen, in CSS pixels. */
  radius: number;
  strokes: ZoneStroke[];
  onChange: (strokes: ZoneStroke[]) => void;
}

export interface RetouchCanvasProps {
  src?: string;
  /** The version's own pixel size when `src` is a reduced copy: the zone is
   * drawn in the version's pixels, not the copy's. */
  pixelSize?: { width: number; height: number };
  /** Told the version's pixel size once it is known. */
  onPixelSize?: (size: { width: number; height: number }) => void;
  /** The version this one was made from: shown to compare, and under the
   * wipe when this one has just arrived. */
  beforeSrc?: string;
  alt: string;
  reveal?: boolean;
  onRevealEnd?: () => void;
  /** Press and hold the picture to see the version before. */
  onHoldChange?: (holding: boolean) => void;
  compare: CompareMode;
  wait?: CanvasWait;
  zone?: CanvasZone;
  /** Overlays laid on the stage, outside the picture (title, tools, bar). */
  children?: ReactNode;
  className?: string;
}

interface Size {
  width: number;
  height: number;
}

function useElementSize<T extends HTMLElement>(): [React.RefObject<T>, Size] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // The content box: the room's padding is breathing space, not picture.
    const measure = () => {
      const style = getComputedStyle(element);
      const padX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const padY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      setSize({
        width: Math.max(0, element.clientWidth - (padX || 0)),
        height: Math.max(0, element.clientHeight - (padY || 0)),
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

export function RetouchCanvas({
  src,
  pixelSize,
  onPixelSize,
  beforeSrc,
  alt,
  reveal,
  onRevealEnd,
  onHoldChange,
  compare,
  wait,
  zone,
  children,
  className,
}: RetouchCanvasProps) {
  const [roomRef, room] = useElementSize<HTMLDivElement>();
  const [natural, setNatural] = useState<Size | undefined>(undefined);
  const [split, setSplit] = useState(0.5);
  // The wipe starts once the new picture is decoded, never over a blank.
  const [decoded, setDecoded] = useState<string | undefined>(undefined);
  const wiping = Boolean(reveal && decoded === src);

  // The picture's box: as large as the room allows, never cropped.
  const frame = useMemo(() => {
    const pixels = pixelSize ?? natural;
    if (!pixels || !natural || room.width === 0 || room.height === 0) return undefined;
    const scale = Math.min(room.width / pixels.width, room.height / pixels.height);
    return {
      width: Math.max(1, Math.round(pixels.width * scale)),
      height: Math.max(1, Math.round(pixels.height * scale)),
      scale,
    };
  }, [natural, pixelSize, room]);

  const knownWidth = (pixelSize ?? natural)?.width;
  const knownHeight = (pixelSize ?? natural)?.height;
  useEffect(() => {
    if (knownWidth && knownHeight) onPixelSize?.({ width: knownWidth, height: knownHeight });
  }, [knownWidth, knownHeight, onPixelSize]);

  const showBefore = Boolean(beforeSrc) && compare !== "off" && !zone;
  const holdTimer = useRef<number | undefined>(undefined);
  const endHold = () => {
    window.clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
    onHoldChange?.(false);
  };
  // A long press, not a click: a click on the picture must stay free.
  const holdHandlers =
    onHoldChange && beforeSrc && !zone && compare !== "split"
      ? {
          onPointerDown: () => {
            window.clearTimeout(holdTimer.current);
            holdTimer.current = window.setTimeout(() => onHoldChange(true), 280);
          },
          onPointerUp: endHold,
          onPointerLeave: endHold,
          onPointerCancel: endHold,
          onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault(),
        }
      : {};

  return (
    <div
      className={["retouch-canvas", className].filter(Boolean).join(" ")}
      data-zone={zone ? "true" : undefined}
    >
      <div className="retouch-room" ref={roomRef}>
        {src ? (
          <div
            className="retouch-frame"
            {...holdHandlers}
            style={
              frame
                ? ({ width: frame.width, height: frame.height } as CSSProperties)
                : { visibility: "hidden" }
            }
          >
            {reveal && beforeSrc ? (
              <img className="retouch-image retouch-underlay" src={beforeSrc} alt="" />
            ) : null}
            <img
              key={src}
              className="retouch-image"
              data-reveal={reveal ? (wiping ? "true" : "waiting") : undefined}
              src={src}
              alt={alt}
              draggable={false}
              onLoad={(event) => {
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                });
                setDecoded(src);
              }}
              onAnimationEnd={() => onRevealEnd?.()}
            />
            {showBefore && beforeSrc ? (
              <img
                className="retouch-image retouch-before"
                data-mode={compare}
                style={
                  compare === "split"
                    ? ({ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` } as CSSProperties)
                    : undefined
                }
                src={beforeSrc}
                alt={t("Before")}
                draggable={false}
              />
            ) : null}
            {showBefore && compare === "split" ? (
              <SplitHandle value={split} onChange={setSplit} />
            ) : null}
            {showBefore && compare === "hold" ? (
              <span className="retouch-before-tag">{t("Before")}</span>
            ) : null}
            {wait ? <Veil wait={wait} /> : null}
            {zone && frame ? <ZoneLayer zone={zone} frame={frame} /> : null}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** The before/after divider. Dragged with a pointer, moved with the arrows. */
function SplitHandle({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (clientX: number) => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const box = parent.getBoundingClientRect();
    onChange(Math.min(1, Math.max(0, (clientX - box.left) / box.width)));
  };
  return (
    <div
      ref={ref}
      className="retouch-split"
      style={{ left: `${value * 100}%` } as CSSProperties}
      role="slider"
      tabIndex={0}
      aria-label={t("Compare before and after")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        move(event.clientX);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event.clientX);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onChange(Math.max(0, value - 0.05));
        else if (event.key === "ArrowRight") onChange(Math.min(1, value + 0.05));
        else return;
        event.preventDefault();
      }}
    >
      <span className="retouch-split-grip" />
    </div>
  );
}

/** The darkroom's grain over the version being retouched, with its clock. */
function Veil({ wait }: { wait: CanvasWait }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);
  const light = useMemo(() => darkroomVars(darkroomSeed(wait.seed)), [wait.seed]);
  const elapsed = Math.max(0, now - wait.startedAt);
  const timed = wait.phase === "processing";
  const progress = timed ? waitProgress(elapsed, wait.estimateMs) : undefined;
  const remaining = timed ? describeRemaining(elapsed, wait.estimateMs) : undefined;
  const phase =
    wait.label ??
    (wait.phase === "queueing"
      ? t("Submitting")
      : wait.phase === "queued"
        ? t("Queued, waiting for a slot")
        : t("Retouching"));
  return (
    <div className="retouch-veil" style={light as CSSProperties}>
      <div className="darkroom-field" aria-hidden>
        <span className="darkroom-lights">
          <span className="darkroom-light darkroom-light-a" />
          <span className="darkroom-light darkroom-light-b" />
          <span className="darkroom-light darkroom-light-c" />
        </span>
        <span className="darkroom-grain" />
      </div>
      <div className="retouch-veil-caption">
        <span aria-live="polite">{phase}</span>
        <span className="retouch-veil-clock">
          {formatElapsed(elapsed)}
          {remaining ? ` · ${remaining}` : ""}
        </span>
      </div>
      <div
        className="darkroom-bar"
        data-indeterminate={progress === undefined ? "true" : undefined}
      >
        <span style={progress === undefined ? undefined : { transform: `scaleX(${progress})` }} />
      </div>
    </div>
  );
}

/** Painting the zone, in the picture's own pixels. */
function ZoneLayer({
  zone,
  frame,
}: {
  zone: CanvasZone;
  frame: { width: number; height: number; scale: number };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [draft, setDraft] = useState<ZoneStroke | undefined>(undefined);
  const strokes = useMemo(
    () => (draft ? [...zone.strokes, draft] : zone.strokes),
    [zone.strokes, draft],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(frame.width * ratio);
    canvas.height = Math.round(frame.height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    const color = getComputedStyle(canvas).color || "#fff";
    context.setTransform(ratio * frame.scale, 0, 0, ratio * frame.scale, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.fillStyle = color;
    context.strokeStyle = color;
    for (const stroke of strokes) {
      context.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
      if (stroke.kind === "lasso") {
        if (stroke.points.length < 2) continue;
        context.beginPath();
        context.moveTo(...stroke.points[0]);
        for (const point of stroke.points.slice(1)) context.lineTo(...point);
        if (stroke === draft) {
          context.lineWidth = 2 / frame.scale;
          context.stroke();
        } else {
          context.closePath();
          context.fill();
        }
        continue;
      }
      if (stroke.points.length === 0) continue;
      context.lineWidth = stroke.radius * 2;
      context.beginPath();
      context.moveTo(...stroke.points[0]);
      for (const point of stroke.points.slice(1)) context.lineTo(...point);
      if (stroke.points.length === 1)
        context.lineTo(stroke.points[0][0] + 0.01, stroke.points[0][1]);
      context.stroke();
    }
  }, [strokes, draft, frame]);

  const toImage = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
      const box = event.currentTarget.getBoundingClientRect();
      return [(event.clientX - box.left) / frame.scale, (event.clientY - box.top) / frame.scale];
    },
    [frame.scale],
  );

  return (
    <canvas
      ref={canvasRef}
      className="retouch-zone-layer"
      data-tool={zone.tool}
      aria-label={t("Draw the zone to retouch")}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = toImage(event);
        setDraft(
          zone.tool === "lasso"
            ? { kind: "lasso", points: [point] }
            : {
                kind: "brush",
                points: [point],
                radius: zone.radius / frame.scale,
                ...(zone.tool === "eraser" ? { erase: true } : {}),
              },
        );
      }}
      onPointerMove={(event) => {
        if (!draft) return;
        const point = toImage(event);
        const last = draft.points.at(-1);
        // Every couple of screen pixels is plenty, and keeps a long stroke light.
        if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) * frame.scale < 2) return;
        setDraft({ ...draft, points: [...draft.points, point] } as ZoneStroke);
      }}
      onPointerUp={() => {
        if (draft) zone.onChange([...zone.strokes, draft]);
        setDraft(undefined);
      }}
      onPointerCancel={() => setDraft(undefined)}
    />
  );
}
