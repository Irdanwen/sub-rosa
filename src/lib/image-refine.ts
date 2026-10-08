/**
 * Image generation "with thinking", from a chat picture: look at it against
 * the prompt, fix what is wrong with one edit, at most twice
 * (`src-tauri/src/image_refine.rs`).
 *
 * The price is asked for before anything runs. Each edit is a durable job
 * that Rust files in the gallery as a version of the first picture
 * (`edit.op === "refine"`), so the versions are read back from the gallery
 * rather than remembered here: a pass cut short by a locked phone still shows
 * its version the next time the card is drawn, and nothing re-runs by itself.
 */

import { invoke } from "@tauri-apps/api/core";
import type { StudioArtifact } from "./studio/types";

/** Never more than this many critique and edit rounds. */
export const MAX_REFINE_PASSES = 2;

export interface RefineEstimate {
  model: string;
  modelName: string;
  passes: number;
  perPassCredits?: number;
  /** The most the edits can cost: a pass that finds nothing to fix costs none. */
  totalCredits?: number;
}

export interface RefineCritique {
  satisfied: boolean;
  issues: string[];
  instruction?: string;
}

export interface RefinePassOutcome {
  critique: RefineCritique;
  root: string;
  n: number;
  jobId?: string;
  fileName?: string;
  path?: string;
  /** The edit is still rendering and will land in the gallery on its own. */
  pending: boolean;
}

export interface RefinePassRequest {
  fileName: string;
  prompt: string;
  root?: string;
  n?: number;
  taskId?: string;
  model?: string;
}

export function estimateRefine(passes = MAX_REFINE_PASSES): Promise<RefineEstimate> {
  return invoke<RefineEstimate>("image_refine_estimate", { request: { passes } });
}

export function runRefinePass(request: RefinePassRequest): Promise<RefinePassOutcome> {
  return invoke<RefinePassOutcome>("image_refine_pass", { request });
}

/** The refined versions of a picture, in the order they were made. */
export function refinedVersions(artifacts: StudioArtifact[], rootId: string): StudioArtifact[] {
  return artifacts
    .filter((artifact) => artifact.edit?.op === "refine" && artifact.edit.root === rootId)
    .sort((a, b) => (a.edit?.n ?? 0) - (b.edit?.n ?? 0) || a.createdAt - b.createdAt);
}

/**
 * Runs the passes one after the other, each on the version the last one
 * made. Stops as soon as a check finds nothing to fix, or an edit is still
 * rendering when its pass gives up waiting.
 */
export async function runRefine(
  start: { fileName: string; prompt: string; taskId?: string; model?: string; passes: number },
  onPass?: (outcome: RefinePassOutcome) => void,
): Promise<RefinePassOutcome[]> {
  const passes = Math.max(1, Math.min(MAX_REFINE_PASSES, Math.floor(start.passes)));
  const outcomes: RefinePassOutcome[] = [];
  let current = start.fileName;
  for (let n = 1; n <= passes; n += 1) {
    const outcome = await runRefinePass({
      fileName: current,
      prompt: start.prompt,
      root: start.fileName,
      n,
      taskId: start.taskId,
      model: start.model,
    });
    outcomes.push(outcome);
    onPass?.(outcome);
    if (outcome.critique.satisfied || outcome.pending || !outcome.fileName) break;
    current = outcome.fileName;
  }
  return outcomes;
}
