// The render-time bucket a workflow node learns into and reads from: the same
// buckets the Studio's own desks use (render-eta.ts), so a model's history is
// one history wherever it was rendered from.

import { renderEtaKey } from "../render-eta";
import type { WorkflowNode } from "./schema";

const KIND: Partial<Record<WorkflowNode["type"], string>> = {
  image: "image",
  imageEdit: "edit",
  tts: "speech",
  music: "music",
  video: "video",
};

/** The bucket for a node that renders something worth timing, or nothing. */
export function nodeEtaKey(node: Pick<WorkflowNode, "type" | "params">): string | undefined {
  const kind = KIND[node.type];
  if (!kind) return undefined;
  const model =
    typeof node.params.model === "string" && node.params.model ? node.params.model : undefined;
  return renderEtaKey(kind, model);
}
