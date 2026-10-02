// How a version names itself on screen, shared by both shells.

import { intlLocale, t } from "../../i18n";
import type { StudioArtifact } from "../types";
import { versionNumber } from "./lineage";

/** "Original", or "Retouch 3". */
export function versionTitle(version: StudioArtifact): string {
  const n = versionNumber(version);
  return n === 0 ? t("Original") : t("Retouch {n}", { n });
}

/** What was asked for, in a few words. */
export function versionCaption(version: StudioArtifact): string {
  const edit = version.edit;
  if (!edit) return version.prompt.trim();
  if (edit.op === "upscale") return t("Upscaled x{scale}", { scale: edit.settings?.scale ?? 2 });
  if (edit.op === "extend")
    return t("Extended to {ratio}", { ratio: edit.settings?.aspectRatio ?? "" });
  return version.prompt.trim();
}

/** "44.7 s", in the reader's own decimal separator. */
export function formatSeconds(ms: number): string {
  const seconds = (Math.max(0, ms) / 1000).toLocaleString(intlLocale(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return t("{seconds} s", { seconds });
}

/** Clip a caption to a chip's width without cutting a word in half. */
export function shortCaption(text: string, max = 48): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[.,;:]$/, "")}…`;
}
