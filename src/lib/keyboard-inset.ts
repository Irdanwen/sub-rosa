import { useEffect, useState } from "react";

/**
 * Height (px) of the on-screen keyboard overlapping the layout viewport.
 * The iOS webview does not resize the window when the keyboard opens; the
 * visual viewport shrinks instead. Sticky composers add this as bottom
 * offset so they ride above the keyboard.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const overlap = window.innerHeight - viewport.height - viewport.offsetTop;
      setInset(Math.max(0, Math.round(overlap)));
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}
