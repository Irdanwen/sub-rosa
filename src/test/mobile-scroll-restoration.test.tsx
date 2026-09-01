import { act, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScrollRestoration } from "../app/mobile/useScrollRestoration";

/**
 * Going back to a list must land where you left it.
 *
 * This is the defect the shell had for as long as the stack has been keyed by
 * tab and depth: the wrapper remounts on every move, and the scroll position
 * went with it. The test pushes a screen, comes back, and asserts the offset --
 * the whole point being that the next refactor of mobile navigation cannot
 * quietly reintroduce it.
 *
 * jsdom does no layout, so `scrollHeight` and `clientHeight` are stubbed. That
 * is honest here: what is under test is the bookkeeping, not the browser.
 */

/** A screen with a scroller in it, the shape every mobile screen has. */
function Screen({ height }: { height: number }) {
  return (
    <div>
      <div data-testid="scroller" style={{ overflowY: "auto" }} ref={sizeIt(height)} />
    </div>
  );
}

/** Give the scroller a size jsdom will not compute on its own. */
function sizeIt(scrollHeight: number) {
  return (element: HTMLDivElement | null) => {
    if (!element) return;
    Object.defineProperty(element, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(element, "clientHeight", { value: 400, configurable: true });
  };
}

function Harness({ contentHeight = 2000 }: { contentHeight?: number }) {
  const [depth, setDepth] = useState(0);
  const host = useRef<HTMLDivElement | null>(null);
  useScrollRestoration(`notes:${depth}`, host);

  return (
    <div>
      <button type="button" onClick={() => setDepth((d) => d + 1)}>
        push
      </button>
      <button type="button" onClick={() => setDepth((d) => Math.max(0, d - 1))}>
        pop
      </button>
      {/* Keyed exactly as the shell keys it, so the wrapper really remounts. */}
      <div ref={host} data-testid="host" key={`notes:${depth}`}>
        <Screen height={contentHeight} />
      </div>
    </div>
  );
}

/** Run the replay loop the hook schedules on the incoming screen. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

afterEach(() => vi.useRealTimers());

describe("mobile scroll restoration", () => {
  it("puts the list back where it was after a push and a pop", async () => {
    const view = render(<Harness />);
    const scroller = () => view.getByTestId("scroller");

    scroller().scrollTop = 640;

    view.getByText("push").click();
    await settle();
    // A fresh screen starts at the top, and does not inherit the one below it.
    expect(scroller().scrollTop).toBe(0);

    view.getByText("pop").click();
    await settle();
    expect(scroller().scrollTop).toBe(640);
  });

  it("leaves a screen that was already at the top alone", async () => {
    const view = render(<Harness />);
    const scroller = () => view.getByTestId("scroller");

    view.getByText("push").click();
    await settle();
    scroller().scrollTop = 120;
    view.getByText("pop").click();
    await settle();

    expect(scroller().scrollTop).toBe(0);
  });

  it("does not force a position the content cannot hold", async () => {
    // The saved offset is past the end of a screen that came back shorter --
    // a note deleted from the list, a filter applied. Assigning it anyway
    // would clamp to zero on a real browser and read as "it forgot".
    const view = render(<Harness contentHeight={2000} />);
    const scroller = () => view.getByTestId("scroller");

    scroller().scrollTop = 1500;
    view.getByText("push").click();
    await settle();

    view.rerender(<Harness contentHeight={2000} />);
    await settle();

    expect(scroller().scrollTop).toBe(0);
  });

  it("gives up as soon as a finger lands on the screen", async () => {
    const view = render(<Harness />);
    const scroller = () => view.getByTestId("scroller");

    scroller().scrollTop = 900;
    act(() => view.getByText("push").click());
    await settle();
    // The pop has to commit first: the listener that abandons the replay is
    // attached by the incoming screen's layout effect.
    act(() => view.getByText("pop").click());

    // The touch arrives before the replay had a frame to run.
    act(() => {
      view.getByTestId("host").dispatchEvent(new Event("touchstart"));
    });
    await settle();

    expect(scroller().scrollTop).toBe(0);
  });
});
