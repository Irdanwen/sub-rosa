/**
 * iOS zooms the page when focus lands on a field whose text is under 16px, and
 * never zooms back out. The phone's fields are 16px (mobile.css), so this is
 * the net under that floor rather than the fix: one field that slips under it
 * leaves the whole shell cropped at the right, tab bar included, until the app
 * is killed.
 *
 * It tells that zoom apart from a pinch. The scale was 1 when focus arrived,
 * it is larger when focus leaves, and no two-finger gesture happened in
 * between: the browser did it, not the person. Pinning `maximum-scale=1` for a
 * moment makes WebKit settle back to 1, and taking it off again keeps pinch
 * zoom available, which is why the viewport meta carries no maximum-scale in
 * the first place (see index.html).
 */
const SETTLE_MS = 150;
const EPSILON = 0.01;

export function installZoomRecovery(win: Window = window): () => void {
  const viewport = win.visualViewport;
  const meta = win.document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!viewport || !meta) return () => {};

  let scaleAtFocus = 1;
  let pinched = false;
  let restore: number | undefined;

  const onFocusIn = () => {
    scaleAtFocus = viewport.scale;
    pinched = false;
  };
  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length > 1) pinched = true;
  };
  const onGesture = () => {
    pinched = true;
  };
  const onFocusOut = () => {
    if (pinched || scaleAtFocus > 1 + EPSILON || viewport.scale <= 1 + EPSILON) return;
    if (restore !== undefined) return;
    const original = meta.content;
    meta.content = `${original}, maximum-scale=1`;
    restore = win.setTimeout(() => {
      meta.content = original;
      restore = undefined;
    }, SETTLE_MS);
  };

  win.document.addEventListener("focusin", onFocusIn);
  win.document.addEventListener("focusout", onFocusOut);
  win.document.addEventListener("touchstart", onTouchStart, { passive: true });
  win.document.addEventListener("gesturestart", onGesture);
  return () => {
    win.document.removeEventListener("focusin", onFocusIn);
    win.document.removeEventListener("focusout", onFocusOut);
    win.document.removeEventListener("touchstart", onTouchStart);
    win.document.removeEventListener("gesturestart", onGesture);
    if (restore !== undefined) win.clearTimeout(restore);
  };
}
