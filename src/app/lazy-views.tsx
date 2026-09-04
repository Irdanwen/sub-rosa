import { type ComponentProps, Suspense, lazy } from "react";
import type { AppSettings as AppSettingsComponent } from "../components/settings/AppSettings";

/**
 * Views the desktop shell shows on demand, loaded on demand. Settings and
 * the Studio are the two largest subtrees a launch never needs before the
 * first note is on screen; each is its own chunk, fetched the first time
 * the person opens it. The fallback is empty on purpose: the load is a few
 * milliseconds off the local disk, and a spinner would flash.
 */
const LazyAppSettings = lazy(() =>
  import("../components/settings/AppSettings").then((module) => ({
    default: module.AppSettings,
  })),
);
const LazyStudioView = lazy(() =>
  import("../components/studio/StudioView").then((module) => ({ default: module.StudioView })),
);

export function AppSettings(props: ComponentProps<typeof AppSettingsComponent>) {
  return (
    <Suspense fallback={null}>
      <LazyAppSettings {...props} />
    </Suspense>
  );
}

export function StudioView() {
  return (
    <Suspense fallback={null}>
      <LazyStudioView />
    </Suspense>
  );
}
