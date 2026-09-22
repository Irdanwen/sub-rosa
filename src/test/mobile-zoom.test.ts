import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installZoomRecovery } from "../lib/mobile-zoom";

const CONTENT = "width=device-width, initial-scale=1.0";

function setup() {
  const meta = document.createElement("meta");
  meta.name = "viewport";
  meta.content = CONTENT;
  document.head.appendChild(meta);
  const viewport = { scale: 1 };
  const win = {
    document,
    visualViewport: viewport,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  } as unknown as Window;
  const uninstall = installZoomRecovery(win);
  return { meta, viewport, uninstall };
}

describe("installZoomRecovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    for (const node of document.head.querySelectorAll('meta[name="viewport"]')) {
      node.remove();
    }
  });

  it("undoes a zoom the browser made while a field had focus", () => {
    const { meta, viewport, uninstall } = setup();
    document.dispatchEvent(new Event("focusin"));
    viewport.scale = 1.067;
    document.dispatchEvent(new Event("focusout"));
    expect(meta.content).toBe(`${CONTENT}, maximum-scale=1`);
    vi.advanceTimersByTime(200);
    expect(meta.content).toBe(CONTENT);
    uninstall();
  });

  it("leaves a pinch alone", () => {
    const { meta, viewport, uninstall } = setup();
    document.dispatchEvent(new Event("focusin"));
    document.dispatchEvent(new Event("gesturestart"));
    viewport.scale = 2;
    document.dispatchEvent(new Event("focusout"));
    expect(meta.content).toBe(CONTENT);
    uninstall();
  });

  it("leaves a page that was already zoomed when focus arrived", () => {
    const { meta, viewport, uninstall } = setup();
    viewport.scale = 1.5;
    document.dispatchEvent(new Event("focusin"));
    document.dispatchEvent(new Event("focusout"));
    expect(meta.content).toBe(CONTENT);
    uninstall();
  });
});
