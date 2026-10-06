// From a pack to the requests a composition sends. Pure, apart from
// `startComposition`, which reads the source, makes the gallery folder and
// queues the jobs.

import { artifactDataUrl } from "../../artifact-media";
import { intlLocale, t } from "../../i18n";
import { deleteCollection, saveCollection } from "../library";
import { prepareSource } from "../retouch/canvas-io";
import { buildEditRequest, type EditCaps, type EditRequest } from "../retouch/request";
import type { MediaJob } from "../async-job";
import type { StudioArtifact } from "../types";
import { type ComposeJobContext, submitCompose } from "./jobs";
import { type ComposePack, type ComposeShot, sheetable, sheetPrompt, shotPrompt } from "./packs";

export type ComposeMode = "separate" | "sheet";

export interface CompositionPlan {
  mode: ComposeMode;
  /** The shots that will be made. */
  shots: ComposeShot[];
  /** Shots this model cannot make: a frame it does not offer. */
  skipped: ComposeShot[];
  /** Paid jobs: one per shot, or one for a whole sheet. */
  jobs: number;
  /** Credits, when the catalog prices the model. */
  costCredits?: number;
}

export function planComposition(
  pack: ComposePack,
  mode: ComposeMode,
  caps: Pick<EditCaps, "aspectRatios">,
  unitCost: number | undefined,
): CompositionPlan {
  const sheet = mode === "sheet" && sheetable(pack);
  const shots = pack.shots.filter(
    (shot) => !shot.aspectRatio || caps.aspectRatios.includes(shot.aspectRatio),
  );
  const skipped = pack.shots.filter((shot) => !shots.includes(shot));
  const jobs = sheet ? 1 : shots.length;
  return {
    mode: sheet ? "sheet" : "separate",
    shots,
    skipped,
    jobs,
    costCredits: unitCost === undefined ? undefined : Math.round(unitCost * jobs * 100) / 100,
  };
}

export interface ComposeSettings {
  model: string;
  resolution?: string;
  quality?: string;
  /** For the shots that do not set their own frame. */
  aspectRatio?: string;
}

/** One request per job, in the plan's order. */
export function compositionRequests(
  plan: CompositionPlan,
  pack: ComposePack,
  caps: EditCaps,
  image: string,
  settings: ComposeSettings,
): EditRequest[] {
  const request = (prompt: string, aspectRatio: string | undefined) =>
    buildEditRequest(caps, {
      model: settings.model,
      prompt,
      images: [image],
      resolution: settings.resolution,
      quality: settings.quality,
      aspectRatio,
    });
  if (plan.mode === "sheet") {
    // A sheet is square, whatever the source, and drawn as large as the model
    // goes: each image is a ninth of it (Ideogram prices 2K like 1K).
    const square = caps.aspectRatios.includes("1:1") ? "1:1" : undefined;
    return [
      buildEditRequest(caps, {
        model: settings.model,
        prompt: sheetPrompt(pack),
        images: [image],
        resolution: largestResolution(caps.resolutions) ?? settings.resolution,
        quality: settings.quality,
        aspectRatio: square,
      }),
    ];
  }
  return plan.shots.map((shot) =>
    request(shotPrompt(shot), shot.aspectRatio ?? settings.aspectRatio),
  );
}

/** "2K" over "1K", "1080p" over "720p": the largest a model offers. */
export function largestResolution(resolutions: string[]): string | undefined {
  const size = (value: string) => {
    const match = /^(\d+(?:\.\d+)?)\s*([kp]?)$/i.exec(value.trim());
    if (!match) return 0;
    const number = Number(match[1]);
    return match[2].toLowerCase() === "k" ? number * 1000 : number;
  };
  return [...resolutions].sort((a, b) => size(b) - size(a))[0];
}

export interface StartedComposition {
  group: string;
  collectionId?: string;
  jobs: MediaJob[];
  /** The first refusal, when some jobs could not be queued. */
  refused?: unknown;
}

/** Read the source, make the folder the results go to, and queue every job. */
export async function startComposition(input: {
  /** Made by the caller, so it listens for results before any job exists. */
  group: string;
  source: StudioArtifact;
  pack: ComposePack;
  plan: CompositionPlan;
  caps: EditCaps;
  settings: ComposeSettings;
  unitCost?: number;
}): Promise<StartedComposition> {
  const { source, pack, plan, caps, settings } = input;
  if (plan.jobs === 0) throw new Error(t("This model cannot make any image of this pack."));
  const image = await prepareSource(await artifactDataUrl(source));
  const requests = compositionRequests(plan, pack, caps, image, settings);
  const { group } = input;
  // Filing is a convenience: a folder that cannot be made leaves the images
  // in the gallery rather than stopping a paid composition.
  const collectionId = await saveCollection(collectionName(pack))
    .then((folder) => folder.id)
    .catch(() => undefined);
  const labels = plan.shots.map((shot) => shot.label);
  const results = await Promise.allSettled(
    requests.map((request, index) => {
      const context: ComposeJobContext = {
        v: 1,
        group,
        sourceId: source.id,
        pack: pack.id,
        mode: plan.mode,
        ...(collectionId ? { collectionId } : {}),
        labels: plan.mode === "sheet" ? labels : [labels[index] ?? ""],
        index,
        of: requests.length,
      };
      return submitCompose({ request, context, costCredits: input.unitCost });
    }),
  );
  const jobs = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  // Nothing was accepted: no empty folder left behind.
  if (jobs.length === 0 && collectionId)
    await deleteCollection(collectionId).catch(() => undefined);
  const refused = results.find((result) => result.status === "rejected") as
    | PromiseRejectedResult
    | undefined;
  return { group, collectionId, jobs, ...(refused ? { refused: refused.reason } : {}) };
}

function collectionName(pack: ComposePack): string {
  const day = new Date().toLocaleDateString(intlLocale(), { day: "numeric", month: "short" });
  return t("{pack}, {day}", { pack: pack.label, day });
}
