import { useEffect, useState } from "react";
import { type PlatformCapabilitiesDto, platformCapabilities } from "./tauri";

/**
 * The capability map, read once per session from the binary.
 *
 * Until now a surface that wanted to know whether it could offer system
 * audio or a global shortcut asked `navigator.platform`, which knows what the
 * webview runs on and nothing about what this build compiled in. The map
 * comes from Rust (`diagnostics::capabilities`), where the `cfg` gates are,
 * so the phrase "not available on Windows" and the absence of the control
 * come from the same fact.
 *
 * Before the first answer arrives the hook returns `null`; a surface should
 * render nothing platform-specific rather than assume either way.
 */
let cached: PlatformCapabilitiesDto | null = null;
let inFlight: Promise<PlatformCapabilitiesDto> | null = null;

export function loadPlatformCapabilities(): Promise<PlatformCapabilitiesDto> {
  if (cached) return Promise.resolve(cached);
  if (!inFlight) {
    // Through a resolved promise so that a bridge that is absent (a test
    // that mocks lib/tauri without this command, a preview page) rejects
    // instead of throwing out of the effect that called us.
    inFlight = Promise.resolve()
      .then(() => platformCapabilities())
      .then((caps) => {
        cached = caps;
        return caps;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Test seam: forget the cached answer. */
export function resetPlatformCapabilitiesForTests() {
  cached = null;
  inFlight = null;
}

export function usePlatformCapabilities(): PlatformCapabilitiesDto | null {
  const [caps, setCaps] = useState<PlatformCapabilitiesDto | null>(cached);
  useEffect(() => {
    if (caps) return;
    let cancelled = false;
    loadPlatformCapabilities()
      .then((value) => {
        if (!cancelled) setCaps(value);
      })
      .catch(() => {
        // Without an answer the surface stays platform-agnostic.
      });
    return () => {
      cancelled = true;
    };
  }, [caps]);
  return caps;
}

/** One sentence for a control this build does not have. */
export function unavailableOn(caps: PlatformCapabilitiesDto | null, what: string) {
  const platform = caps?.platform ?? "this platform";
  return `${what} is not available on ${platform} yet.`;
}
