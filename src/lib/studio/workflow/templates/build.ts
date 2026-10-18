// What every starter workflow is built from: a step placed on the grid, a
// wire between two steps, and the models a template names by default.
// Template ids are stable ("template-" prefix) and timestamps are 0: the UI
// clones a template with fresh ids before letting the user edit or save it.
// A default model the catalog no longer offers is swapped for its nearest
// sibling when the template is opened (template-models.ts).

import {
  defaultParams,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from "../schema";

const LEVEL_X = 300;
const ROW_Y = 220;

export const CHAT_MODEL = "qwen3-next-80b";
export const IMAGE_MODEL = "seedream-v4";
export const TTS_MODEL = "tts-kokoro";
export const MUSIC_MODEL = "ace-step-15";
export const VIDEO_MODEL = "kling-2.5-turbo-pro-text-to-video";
/** The image-to-video half of the same family, for a shot that continues
 * another one from its handoff frame. */
export const VIDEO_FROM_IMAGE_MODEL = "kling-2.5-turbo-pro-image-to-video";

export function node(
  id: string,
  type: WorkflowNodeType,
  label: string,
  level: number,
  row: number,
  params: Record<string, unknown> = {},
): WorkflowNode {
  return {
    id,
    type,
    label,
    position: { x: level * LEVEL_X, y: row * ROW_Y },
    params: { ...defaultParams(type), ...params },
  };
}

export function edge(source: string, target: string, targetPort?: string): WorkflowEdge {
  return {
    id: `${source}-${target}${targetPort ? `-${targetPort}` : ""}`,
    source,
    target,
    targetPort,
  };
}
