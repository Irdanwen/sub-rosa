import type { BibleRole } from "./bible/types";
import { BIBLE_ROLES } from "./bible/types";
import type { NodeRunResult } from "./workflow/engine";
import type { WorkflowNode } from "./workflow/schema";

/**
 * Which part of a film project a production step is making.
 *
 * A project's workflow is compiled with node ids that name what they make:
 * `shot-<id>` renders a take, `image-<id>` composes a shot's opening image,
 * `line-<id>` voices its dialogue, `bible-<entry>-<role>` draws a reference and
 * `score-<cue>` writes a cue of the score. The ids are the contract between the
 * compiler, the frozen run a restart replays, and the screens that show a wait
 * where its result will land. Anything else (an asset, a frame extraction, a
 * prompt) is plumbing and has no place to show.
 */
export type ProductionTarget =
  | { kind: "take"; shotId: string }
  | { kind: "opening"; shotId: string }
  | { kind: "line"; shotId: string }
  | { kind: "bible"; entryId: string; role: BibleRole }
  | { kind: "cue"; cueId: string };

const IMAGE_ROLES = BIBLE_ROLES.filter((role) => role !== "voice").join("|");
const BIBLE_NODE = new RegExp(`^bible-(.+)-(${IMAGE_ROLES})$`);

export function nodeTarget(nodeId: string): ProductionTarget | undefined {
  const bible = BIBLE_NODE.exec(nodeId);
  if (bible) return { kind: "bible", entryId: bible[1], role: bible[2] as BibleRole };
  const [, prefix, id] = /^(shot|image|line|score)-(.+)$/.exec(nodeId) ?? [];
  if (!id) return undefined;
  if (prefix === "shot") return { kind: "take", shotId: id };
  if (prefix === "image") return { kind: "opening", shotId: id };
  if (prefix === "line") return { kind: "line", shotId: id };
  // `score-prompt` is the text feeding a single score, not a cue.
  return id === "prompt" ? undefined : { kind: "cue", cueId: id };
}

/** One key per place a wait is shown. */
export function targetKey(target: ProductionTarget): string {
  switch (target.kind) {
    case "bible":
      return `bible:${target.entryId}:${target.role}`;
    case "cue":
      return `cue:${target.cueId}`;
    default:
      return `${target.kind}:${target.shotId}`;
  }
}

/** A step being made right now, and what the screen needs to show its wait. */
export interface LiveRender {
  nodeId: string;
  target: ProductionTarget;
  startedAt: number;
  /** Waiting for a slot at the provider, or being made. */
  phase: "queued" | "processing";
  progress?: number;
  /** The render-eta bucket this step's wall time is learned under. */
  etaKey: string;
  /** The shape of what is being made, when the step says. */
  aspectRatio?: string;
}

/** What kind of render a node is, in render-eta's vocabulary. */
function etaKind(node: WorkflowNode | undefined): string {
  if (!node) return "unknown";
  if (node.type === "imageEdit") return "image";
  if (node.type === "tts") return "speech";
  return node.type;
}

/**
 * Fold one engine update into the set of live renders. Pure, so the screens
 * and the tests agree on it; the caller files `finished` with render-eta so
 * the next wait of the same kind has an estimate.
 */
export function foldLiveRender(
  live: Readonly<Record<string, LiveRender>>,
  result: NodeRunResult,
  node: WorkflowNode | undefined,
  now: number,
): { live: Record<string, LiveRender>; finished?: { etaKey: string; elapsedMs: number } } {
  const target = nodeTarget(result.nodeId);
  if (!target) return { live: { ...live } };
  const previous = live[result.nodeId];
  const next = { ...live };
  if (result.status === "running") {
    const model = typeof node?.params.model === "string" ? node.params.model : "unknown";
    const aspect = node?.params.aspectRatio ?? node?.params.aspect_ratio;
    next[result.nodeId] = {
      nodeId: result.nodeId,
      target,
      startedAt: previous?.startedAt ?? now,
      // The engine only notes a running step while it waits for a slot.
      phase: result.note ? "queued" : "processing",
      progress: typeof result.progress === "number" ? result.progress : previous?.progress,
      etaKey: previous?.etaKey ?? `${etaKind(node)}:${model}`,
      aspectRatio: typeof aspect === "string" && aspect ? aspect : previous?.aspectRatio,
    };
    return { live: next };
  }
  delete next[result.nodeId];
  return {
    live: next,
    finished:
      result.status === "done" && previous
        ? { etaKey: previous.etaKey, elapsedMs: now - previous.startedAt }
        : undefined,
  };
}
