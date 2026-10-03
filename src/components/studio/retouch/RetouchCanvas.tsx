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
import { FIT, panBy, toggleZoom, type View, zoomAt } from "../../../lib/studio/retouch/view";
import type { Point, ZoneStroke } from "../../../lib/studio/retouch/zone";
import { type StageWait, Veil } from "../stage/Veil";

export type CompareMode = "off" | "hold" | "split";
export type ZoneTool = "brush" | "lasso" | "eraser";

/** The wait the canvas shows, in the stage's words. */
export type CanvasWait = StageWait;

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
  const [roomRef, room] = useElementSize<HTMLElement>();
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

  // --- Looking closer: pinch, drag, double tap, ctrl+wheel ----------------
  const [view, setView] = useState<View>(FIT);
  const [gesturing, setGesturing] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const gesture = useRef({ pinching: false });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; mid: { x: number; y: number }; view: View } | undefined>(
    undefined,
  );
  const drag = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined);
  const lastTap = useRef<{ at: number; x: number; y: number } | undefined>(undefined);
  const frameWidth = frame?.width;
  const frameHeight = frame?.height;
  // A picture of another size starts at fit; versions of the same size keep
  // the view, so a detail can be compared across them.
  useEffect(() => {
    if (frameWidth && frameHeight) setView(FIT);
  }, [frameWidth, frameHeight]);

  const holdTimer = useRef<number | undefined>(undefined);
  const holdAllowed = Boolean(onHoldChange && beforeSrc && !zone && compare !== "split");
  const endHold = () => {
    window.clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
    onHoldChange?.(false);
  };
  const centre = () => {
    const box = roomRef.current?.getBoundingClientRect();
    return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : { x: 0, y: 0 };
  };
  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  };
  const onControl = (target: EventTarget | null) =>
    target instanceof Element && Boolean(target.closest(".retouch-split, button"));

  const gestureHandlers = {
    onPointerDownCapture: (event: ReactPointerEvent) => {
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 2 && frame) {
        pinch.current = { ...spread(), view: viewRef.current };
        gesture.current.pinching = true;
        drag.current = undefined;
        setGesturing(true);
        endHold();
        return;
      }
      if (pointers.current.size !== 1 || onControl(event.target)) return;
      drag.current = { x: event.clientX, y: event.clientY, moved: false };
      if (holdAllowed) {
        window.clearTimeout(holdTimer.current);
        holdTimer.current = window.setTimeout(() => onHoldChange?.(true), 280);
      }
    },
    onPointerMoveCapture: (event: ReactPointerEvent) => {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const start = pinch.current;
      if (start && pointers.current.size >= 2 && frame) {
        const { dist, mid } = spread();
        const c = centre();
        const zoomed = zoomAt(
          start.view,
          dist / Math.max(1, start.dist),
          { x: start.mid.x - c.x, y: start.mid.y - c.y },
          frame,
        );
        setView(panBy(zoomed, mid.x - start.mid.x, mid.y - start.mid.y, frame));
        return;
      }
      const moving = drag.current;
      if (!moving) return;
      const dx = event.clientX - moving.x;
      const dy = event.clientY - moving.y;
      if (!moving.moved && Math.hypot(dx, dy) > 6) {
        moving.moved = true;
        endHold();
      }
      if (moving.moved && !zone && viewRef.current.scale > 1 && frame) {
        setGesturing(true);
        setView((current) => panBy(current, dx, dy, frame));
        moving.x = event.clientX;
        moving.y = event.clientY;
      }
    },
    onPointerUpCapture: (event: ReactPointerEvent) => release(event, true),
    onPointerCancelCapture: (event: ReactPointerEvent) => release(event, false),
  };
  const release = (event: ReactPointerEvent, tapped: boolean) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = undefined;
    if (pointers.current.size > 0) return;
    const wasPinch = gesture.current.pinching;
    gesture.current.pinching = false;
    setGesturing(false);
    endHold();
    const moving = drag.current;
    drag.current = undefined;
    if (!tapped || wasPinch || !moving || moving.moved || zone || !frame) return;
    const now = Date.now();
    const last = lastTap.current;
    if (
      last &&
      now - last.at < 320 &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) < 24
    ) {
      const c = centre();
      setView((current) =>
        toggleZoom(current, { x: event.clientX - c.x, y: event.clientY - c.y }, frame),
      );
      lastTap.current = undefined;
      return;
    }
    lastTap.current = { at: now, x: event.clientX, y: event.clientY };
  };

  // Trackpad pinch and ctrl+wheel zoom; a plain wheel pans once zoomed in.
  useEffect(() => {
    const room = roomRef.current;
    if (!room || !frame) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
        const box = room.getBoundingClientRect();
        const point = {
          x: event.clientX - (box.left + box.width / 2),
          y: event.clientY - (box.top + box.height / 2),
        };
        setView((current) => zoomAt(current, Math.exp(-event.deltaY * 0.01), point, frame));
      } else if (viewRef.current.scale > 1) {
        event.preventDefault();
        setView((current) => panBy(current, -event.deltaX, -event.deltaY, frame));
      }
    };
    room.addEventListener("wheel", onWheel, { passive: false });
    return () => room.removeEventListener("wheel", onWheel);
  }, [roomRef, frame]);

  return (
    <div
      className={["retouch-canvas", className].filter(Boolean).join(" ")}
      data-zone={zone ? "true" : undefined}
    >
      <section
        className="retouch-room"
        ref={roomRef}
        aria-label={t("Picture, pinch or double tap to zoom")}
        {...gestureHandlers}
        onContextMenu={holdAllowed ? (event) => event.preventDefault() : undefined}
      >
        {src ? (
          <div
            className="retouch-frame"
            data-gesturing={gesturing ? "true" : undefined}
            style={
              frame
                ? ({
                    width: frame.width,
                    height: frame.height,
                    transform:
                      view.scale > 1
                        ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
                        : undefined,
                  } as CSSProperties)
                : { visibility: "hidden" }
            }
          >
            {reveal && beforeSrc ? (
              <img className="retouch-image retouch-underlay" src={beforeSrc} alt="" />
            ) : null}
            <img
              key={src}
              className="retouch-image stage-reveal"
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
            {wait ? <Veil wait={wait} defaultLabel={t("Retouching")} /> : null}
            {zone && frame ? <ZoneLayer zone={zone} frame={frame} gesture={gesture} /> : null}
          </div>
        ) : null}
        {view.scale > 1.01 ? (
          <button
            type="button"
            className="retouch-fit"
            data-zone={zone ? "true" : undefined}
            onClick={() => setView(FIT)}
          >
            {t("Fit to screen")}
          </button>
        ) : null}
      </section>
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
      data-no-edge-swipe
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

/** Painting the zone, in the picture's own pixels. */
function ZoneLayer({
  zone,
  frame,
  gesture,
}: {
  zone: CanvasZone;
  frame: { width: number; height: number; scale: number };
  /** Two fingers on the picture are a pinch, never a stroke. */
  gesture: React.RefObject<{ pinching: boolean }>;
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

  // Screen pixels per picture pixel, zoom included: the box is measured
  // after the frame's transform.
  const screenScale = useCallback(
    (canvas: HTMLCanvasElement) =>
      canvas.getBoundingClientRect().width / (frame.width / frame.scale),
    [frame.width, frame.scale],
  );
  const toImage = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
      const box = event.currentTarget.getBoundingClientRect();
      const k = screenScale(event.currentTarget);
      return [(event.clientX - box.left) / k, (event.clientY - box.top) / k];
    },
    [screenScale],
  );

  return (
    <canvas
      ref={canvasRef}
      className="retouch-zone-layer"
      data-tool={zone.tool}
      data-no-edge-swipe
      aria-label={t("Draw the zone to retouch")}
      onPointerDown={(event) => {
        if (!event.isPrimary || gesture.current?.pinching) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = toImage(event);
        setDraft(
          zone.tool === "lasso"
            ? { kind: "lasso", points: [point] }
            : {
                kind: "brush",
                points: [point],
                // The brush keeps its size on screen, so zooming in paints finer.
                radius: zone.radius / screenScale(event.currentTarget),
                ...(zone.tool === "eraser" ? { erase: true } : {}),
              },
        );
      }}
      onPointerMove={(event) => {
        if (!draft) return;
        if (gesture.current?.pinching) {
          setDraft(undefined);
          return;
        }
        const point = toImage(event);
        const last = draft.points.at(-1);
        // Every couple of screen pixels is plenty, and keeps a long stroke light.
        if (
          last &&
          Math.hypot(point[0] - last[0], point[1] - last[1]) * screenScale(event.currentTarget) < 2
        )
          return;
        setDraft({ ...draft, points: [...draft.points, point] } as ZoneStroke);
      }}
      onPointerUp={() => {
        if (draft && !gesture.current?.pinching) zone.onChange([...zone.strokes, draft]);
        setDraft(undefined);
      }}
      onPointerCancel={() => setDraft(undefined)}
    />
  );
}
