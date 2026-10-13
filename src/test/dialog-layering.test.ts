import { describe, expect, it } from "vitest";
import appCss from "../styles/app.css?raw";
import tokensCss from "../styles/tokens.css?raw";

/** A layer named from the --z-* scale resolves to its number in tokens.css. */
function layerToken(name: string) {
  const match = tokensCss.match(new RegExp(`--${name}:\\s*(\\d+);`));
  if (!match) throw new Error(`Missing layer token --${name}`);
  return Number(match[1]);
}

function zIndexFor(selector: string) {
  const escaped = selector.replace(/\./g, "\\.");
  const match = appCss.match(
    new RegExp(`${escaped}\\s*\\{[^}]*?z-index:\\s*(?:(\\d+)|var\\(--([a-z-]+)\\))`),
  );
  if (!match) throw new Error(`Missing z-index for ${selector}`);
  return match[1] !== undefined ? Number(match[1]) : layerToken(match[2]);
}

describe("dialog layering", () => {
  it("keeps modal dialogs above the titlebar tab strip", () => {
    expect(zIndexFor(".dialog-backdrop")).toBeGreaterThan(zIndexFor(".tab-bar"));
  });

  it("keeps modal dialogs above the sidebar toggle", () => {
    expect(zIndexFor(".dialog-backdrop")).toBeGreaterThan(zIndexFor(".chrome-sidebar-toggle"));
  });

  it("keeps hover tips above dialogs", () => {
    expect(zIndexFor(".hover-tip")).toBeGreaterThan(zIndexFor(".dialog-backdrop"));
  });
});
