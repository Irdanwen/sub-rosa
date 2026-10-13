import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../../lib/modal-focus";

/**
 * A surface anchored to the control that opened it: a model list under a
 * chip, a short menu under a button. The desktop's answer to the phone's
 * bottom sheet - it opens where the eye already is, instead of across the
 * window.
 *
 * Keyboard and focus come from `useModalFocus` (spec/modal-focus.md): focus
 * moves in, Tab stays in, Escape closes, and focus goes back to the anchor.
 * A press outside closes it too. It opens below the anchor and flips above
 * when the window has no room underneath, and it never leaves the window.
 */
export function Popover({
  anchorRef,
  open,
  onClose,
  children,
  label,
  className,
  role = "dialog",
  tone,
  width,
  initialFocusSelector,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** The accessible name of the surface. */
  label: string;
  className?: string;
  role?: "dialog" | "menu" | "listbox";
  /** "stage" draws it on the Studio's dark glass, whatever the app theme. */
  tone?: "stage";
  /** A fixed width in pixels; the anchor's width (at least 240) otherwise. */
  width?: number;
  initialFocusSelector?: string;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties | undefined>(undefined);
  // Which side of the anchor it opened on, so it grows out of the control
  // that opened it rather than out of its own middle.
  const [side, setSide] = useState<"top" | "bottom">("bottom");

  useModalFocus(surface, { open, onClose, initialFocusSelector });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const gap = 6;
      const margin = 8;
      const surfaceWidth = Math.min(
        width ?? Math.max(240, rect.width),
        window.innerWidth - 2 * margin,
      );
      const left = Math.min(Math.max(margin, rect.left), window.innerWidth - surfaceWidth - margin);
      const below = window.innerHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      // Below by default; above only when it is the roomier side and the
      // space below cannot hold a reasonable list.
      const flip = below < 240 && above > below;
      setSide(flip ? "top" : "bottom");
      setPosition(
        flip
          ? {
              left,
              width: surfaceWidth,
              bottom: window.innerHeight - rect.top + gap,
              maxHeight: above,
            }
          : { left, width: surfaceWidth, top: rect.bottom + gap, maxHeight: below },
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef, open, width]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (surface.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [anchorRef, onClose, open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={surface}
      // Spread: the role is the caller's, and every one of them takes a name.
      {...{ role, "aria-label": label }}
      tabIndex={-1}
      data-side={side}
      className={["popover", tone === "stage" ? "stage popover-stage" : "", className]
        .filter(Boolean)
        .join(" ")}
      style={position ?? { visibility: "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}
