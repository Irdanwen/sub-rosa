import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReturnToApp } from "../../website/src/pages/return";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../website/src/lib/api", () => ({ api: mocks.api }));

const original = window.location;
let navigated: string[] = [];
let replaced: string[] = [];

function land(hash: string) {
  navigated = [];
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      hash,
      pathname: "/account/devices/return",
      get href() {
        return "https://subrosa.example/account/devices/return";
      },
      set href(value: string) {
        navigated.push(value);
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  replaced = [];
  vi.spyOn(history, "replaceState").mockImplementation((_s, _t, url) => {
    replaced.push(String(url));
  });
});
afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: original });
  vi.restoreAllMocks();
});

const CODE = "a".repeat(43);
const REQUEST = "0192f3c4-5d6e-7f80-9123-456789abcdef";

describe("the page a native sign-in returns to", () => {
  it("hands the return code to the app and takes it out of the address bar", async () => {
    land(`#c=${CODE}&r=${REQUEST}`);
    render(<ReturnToApp />);
    // The fragment never reached the service; it must not linger here either.
    expect(replaced).toEqual(["/account/devices/return"]);
    const link = screen.getByRole("link", { name: "Open Sub Rosa" });
    expect(link).toHaveAttribute("href", `subrosa://auth/callback?request=${REQUEST}&code=${CODE}`);
    await waitFor(() =>
      expect(navigated).toEqual([`subrosa://auth/callback?request=${REQUEST}&code=${CODE}`]),
    );
    // Signing in natively leaves no session, so this page must never ask for one.
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it("builds the scheme itself rather than taking one from the fragment", () => {
    land(`#c=${CODE}&r=${REQUEST}&s=javascript`);
    render(<ReturnToApp />);
    // A scheme in the fragment is ignored outright, so this page can never be
    // talked into opening something else.
    expect(screen.getByRole("link", { name: "Open Sub Rosa" })).toHaveAttribute(
      "href",
      `subrosa://auth/callback?request=${REQUEST}&code=${CODE}`,
    );
  });

  it.each([
    ["a short code", `#c=abc&r=${REQUEST}`],
    ["a request that is not a uuid", `#c=${CODE}&r=not-a-uuid`],
    ["nothing at all", ""],
  ])("refuses %s", (_name, hash) => {
    land(hash);
    render(<ReturnToApp />);
    expect(screen.queryByRole("link", { name: "Open Sub Rosa" })).toBeNull();
    expect(navigated).toEqual([]);
  });
});
