import { recoverableView } from "./recoverable-view";

/** Heavy desktop views load on demand and recover independently of the shell. */
export const AppSettings = recoverableView(async () => {
  const module = await import("../components/settings/AppSettings");
  return { default: module.AppSettings };
});
export const StudioView = recoverableView(async () => {
  const module = await import("../components/studio/StudioView");
  return { default: module.StudioView };
});
