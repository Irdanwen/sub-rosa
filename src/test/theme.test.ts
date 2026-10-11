import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, getStoredTheme, initTheme, setStoredTheme } from "../lib/theme";

type Listener = (event: MediaQueryListEvent) => void;

function fakeSystem(dark: boolean) {
  const listeners = new Set<Listener>();
  const media = {
    matches: dark,
    addEventListener: vi.fn((_type: string, listener: Listener) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: Listener) => listeners.delete(listener)),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media),
  );
  return {
    media,
    listeners,
    flip(next: boolean) {
      media.matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
  };
}

const theme = () => document.documentElement.getAttribute("data-theme");

afterEach(() => {
  // Leave no system listener behind for the next test.
  applyTheme("light");
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
});

describe("theme", () => {
  it("reads a stored preference and ignores anything else", () => {
    expect(getStoredTheme()).toBe("system");
    localStorage.setItem("os-june:theme", "dark");
    expect(getStoredTheme()).toBe("dark");
    localStorage.setItem("os-june:theme", "sepia");
    expect(getStoredTheme()).toBe("system");
  });

  it("falls back to system when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementationOnce(() => {
      throw new Error("sandboxed");
    });
    expect(getStoredTheme()).toBe("system");
  });

  it("applies an explicit theme without listening to the system", () => {
    const system = fakeSystem(true);
    applyTheme("light");
    expect(theme()).toBe("light");
    expect(system.media.addEventListener).not.toHaveBeenCalled();
  });

  it("follows the system and stops when a fixed theme is chosen", () => {
    const system = fakeSystem(true);
    applyTheme("system");
    expect(theme()).toBe("dark");
    applyTheme("system");
    expect(system.media.addEventListener).toHaveBeenCalledTimes(1);
    system.flip(false);
    expect(theme()).toBe("light");

    applyTheme("dark");
    expect(system.media.removeEventListener).toHaveBeenCalledTimes(1);
    system.flip(false);
    expect(theme()).toBe("dark");
  });

  it("reads light when the system cannot be asked", () => {
    vi.stubGlobal("matchMedia", undefined);
    applyTheme("system");
    expect(theme()).toBe("light");
  });

  it("stores the choice and applies it through a view transition when there is one", () => {
    const start = vi.fn((mutate: () => void) => mutate());
    (document as unknown as { startViewTransition?: unknown }).startViewTransition = start;
    setStoredTheme("dark");
    expect(localStorage.getItem("os-june:theme")).toBe("dark");
    expect(start).toHaveBeenCalledTimes(1);
    expect(theme()).toBe("dark");
  });

  it("still applies the choice when storage refuses it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("quota");
    });
    setStoredTheme("dark");
    expect(theme()).toBe("dark");
  });

  it("starts from the stored preference", () => {
    localStorage.setItem("os-june:theme", "dark");
    initTheme();
    expect(theme()).toBe("dark");
  });
});
