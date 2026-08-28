import { describe, expect, it } from "vitest";
import studioCss from "../styles/studio.css?raw";

function cssRuleFor(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Anchored at the start of a line: the same selectors appear indented inside
  // the narrow-layout media query, and those overrides are not the rule here.
  const match = new RegExp(`^${escaped}\\s*\\{`, "m").exec(studioCss);
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  const openIndex = match.index + match[0].length - 1;
  let depth = 0;
  for (let index = openIndex; index < studioCss.length; index += 1) {
    if (studioCss[index] === "{") depth += 1;
    if (studioCss[index] === "}") {
      depth -= 1;
      if (depth === 0) return studioCss.slice(openIndex + 1, index);
    }
  }
  throw new Error(`Unclosed CSS rule for ${selector}`);
}

describe("studio controls column", () => {
  it("bounds the sticky card to the room it has", () => {
    // A sticky box taller than the scrollport does not scroll again until the
    // END of its containing block - which here is as tall as the gallery. Left
    // unbounded, reaching the bottom of the form meant scrolling past every
    // clip that had been rendered.
    const controls = cssRuleFor(".studio-controls");
    expect(controls).toContain("position: sticky;");
    expect(controls).toContain(
      "max-height: calc(100dvh - var(--studio-controls-viewport-offset));",
    );
  });

  it("scrolls the fields inside the card, without chaining to the gallery", () => {
    const fields = cssRuleFor(".studio-controls-fields");
    expect(fields).toContain("overflow-y: auto;");
    // A flex item will not shrink below its content without this, so the card
    // would grow straight back past the max-height above.
    expect(fields).toContain("min-height: 0;");
    expect(fields).toContain("overscroll-behavior: contain;");
  });

  it("keeps the call to action out of that scroll", () => {
    expect(cssRuleFor(".studio-controls-action")).toContain("flex: 0 0 auto;");
  });

  it("hands the scroll back to the page once the columns stack", () => {
    // Stacked, a viewport-tall card with its own scroll would be a second
    // scroller inside the first.
    const narrow = studioCss.slice(studioCss.indexOf("@media (max-width: 900px)"));
    expect(narrow).toContain("position: static;");
    expect(narrow).toContain("max-height: none;");
    expect(narrow).toContain("overflow-y: visible;");
  });
});
