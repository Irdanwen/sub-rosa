import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { Agentation } from "agentation";
import { isMobilePlatform } from "./lib/mobile";
import { installNativeContextMenuGuard } from "./lib/native-context-menu";
import { replayOnboarding } from "./lib/onboarding";
import { initTheme } from "./lib/theme";
import { initBrand } from "./lib/brand";
import "./styles/app.css";
import "./styles/carpe-diem.css";
import "./styles/studio.css";
import "./styles/council.css";
import "./styles/mobile.css";

declare global {
  interface Window {
    /** Devtools-console testing hooks; not referenced by app code. */
    june?: { replayOnboarding: typeof replayOnboarding };
  }
}

// `june.replayOnboarding()` in the webview console re-runs the wizard;
// pass a step id ("permissions", "dictation-practice", ...) to land on that step.
if (import.meta.env.DEV) {
  window.june = { replayOnboarding };
}

initTheme();
initBrand();
installNativeContextMenuGuard();
if (isMobilePlatform()) {
  void import("./lib/dynamic-type").then(({ initDynamicType }) => initDynamicType());
}

// Console driver for the agent HUD overlay window: __agentHud("demo") etc.
// from this window's devtools. Emits on the Tauri bus only, so fake demo
// sessions never leak into the sidebar or menu bar. See lib/agent-hud-demo.ts.
if (import.meta.env.DEV) {
  void import("./lib/agent-hud-demo").then(({ registerAgentHudDemo }) =>
    registerAgentHudDemo({ local: false }),
  );
  // Same pattern for the meeting-detection prompt: __meetingHud("detected")
  // drives the real dictation HUD window over the Tauri bus.
  void import("./lib/meeting-hud-demo").then(({ registerMeetingHudDemo }) =>
    registerMeetingHudDemo({ local: false }),
  );
  // __dictationHud("listening") drives the dictation pill in the same HUD
  // window over the Tauri bus.
  void import("./lib/dictation-hud-demo").then(({ registerDictationHudDemo }) =>
    registerDictationHudDemo({ local: false }),
  );
  // __recordingHud("recording") drives the recording pill (meeting-hud window)
  // over the Tauri bus. Note: that window only shows when Rust already has a
  // live recording with the main window hidden — see lib/recording-hud-demo.ts.
  void import("./lib/recording-hud-demo").then(({ registerRecordingHudDemo }) =>
    registerRecordingHudDemo({ local: false }),
  );
  // __emptyStates() forces every list view (Agents, Routines, Projects,
  // Notes, Dictation, sidebar) into its empty rendering for design work;
  // call again or __emptyStates(false) to reset. Real data is untouched.
  void import("./lib/empty-states-demo").then(({ registerEmptyStatesDemo }) =>
    registerEmptyStatesDemo(),
  );
}

// The mobile (iOS/Android) build renders its own shell: bottom tabs and push
// stacks instead of the desktop sidebar + tab strip. Same IPC, same reducer,
// same feature components underneath. Each shell is its own chunk, so the
// desktop never parses the phone's screens and the phone never parses the
// desktop's; the boot curtain in index.html covers the load.
const App = lazy(() => import("./app/App").then((module) => ({ default: module.App })));
const MobileApp = lazy(() =>
  import("./app/mobile/MobileApp").then((module) => ({ default: module.MobileApp })),
);
const Shell = isMobilePlatform() ? MobileApp : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <Shell />
    </Suspense>
    {import.meta.env.DEV ? <Agentation /> : null}
  </React.StrictMode>,
);

// Drop the curtain painted by index.html, one frame after the shell has had a
// chance to paint over it. Two frames, not zero: removing it in the same tick
// as `render` uncovers a root React has committed but the compositor has not
// drawn yet, which is the flash the curtain exists to prevent.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    const boot = document.getElementById("boot");
    if (!boot) return;
    boot.setAttribute("data-leaving", "");
    boot.addEventListener("transitionend", () => boot.remove(), { once: true });
    // The transition never fires under reduced motion, and a curtain that
    // stays is worse than one that never faded.
    window.setTimeout(() => boot.remove(), 600);
  }),
);
