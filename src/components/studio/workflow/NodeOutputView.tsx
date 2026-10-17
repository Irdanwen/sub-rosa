// What a node shows once it has run, or while it is making something.

import { keyed } from "../../../lib/keyed";
import { useMemo, useState } from "react";
import { t } from "../../../lib/i18n";
import { explainConstraintError } from "../../../lib/studio/model-constraints";
import { estimateRenderMs } from "../../../lib/studio/render-eta";
import type { NodeOutput, NodeRunResult, WorkflowNode } from "../../../lib/studio/workflow";
import { nodeEtaKey } from "../../../lib/studio/workflow/eta";
import { StageFrame } from "../stage/StageFrame";
import "../stage/stage.css";

/** The wait a rendering node shows: the Studio's own veil (ADR-0111), in the
 * shape of what the node makes, with the clock and what this model usually
 * takes. Mounted only while the node runs, so its clock starts with it. */
function RenderingFrame({ node }: { node: WorkflowNode }) {
  const [startedAt] = useState(() => Date.now());
  const etaKey = nodeEtaKey(node);
  const estimateMs = useMemo(() => (etaKey ? estimateRenderMs(etaKey) : undefined), [etaKey]);
  const audio = node.type === "music" || node.type === "tts";
  const ratio = node.params.aspectRatio;
  const aspect = audio ? "3:1" : typeof ratio === "string" && ratio !== "" ? ratio : "1:1";
  const prompt = typeof node.params.prompt === "string" ? node.params.prompt : "";
  return (
    <div className="studio-node-output nodrag">
      <StageFrame
        aspect={aspect}
        className="studio-node-stage"
        waitLabel={t("Rendering")}
        wait={{ seed: node.id + prompt, phase: "processing", startedAt, estimateMs }}
      />
    </div>
  );
}

/** What an item of a list is, for its key. */
/** What an item is, for a stable key among a list's items. */
export function itemName(output: NodeOutput): string {
  if (output.kind === "text") return `text:${output.text}`;
  if (output.kind === "image") return `image:${output.artifactId ?? output.base64.slice(0, 32)}`;
  return `${output.kind}:${output.artifactId ?? output.src ?? ""}`;
}

export function NodeOutputView({ result, node }: { result: NodeRunResult; node: WorkflowNode }) {
  if (result.status === "running") {
    // A chat node answers in seconds; a render holds the canvas for minutes
    // and is worth a frame.
    return nodeEtaKey(node) ? <RenderingFrame node={node} /> : null;
  }
  if (result.status === "error") {
    // A schema rejection reads as a zod report; say what the model wanted
    // instead, next to the pickers that have just been updated with it.
    const explained = result.error ? explainConstraintError(result.error) : undefined;
    return <p className="studio-node-error">{explained ?? result.error}</p>;
  }
  // A step run once per item: what each run made, side by side.
  if (result.items && result.items.length > 0) {
    return (
      <div className="studio-node-items nowheel">
        {keyed(result.items, itemName).map(({ key, value }) => (
          <NodeOutputView
            key={key}
            result={{ ...result, items: undefined, output: value }}
            node={node}
          />
        ))}
      </div>
    );
  }
  const output = result.output;
  if (!output) return null;
  if (output.kind === "text") {
    return <div className="studio-node-output nowheel">{output.text}</div>;
  }
  if (output.kind === "image") {
    return (
      <div className="studio-node-output">
        <img src={`data:${output.mimeType};base64,${output.base64}`} alt={t("Node output")} />
      </div>
    );
  }
  if (output.kind === "audio") {
    const src =
      output.src ??
      output.url ??
      (output.base64 ? `data:${output.mimeType};base64,${output.base64}` : "");
    return (
      <div className="studio-node-output">
        {/* biome-ignore lint/a11y/useMediaCaption: generated audio has no track */}
        {src ? <audio controls src={src} className="studio-audio-player nodrag" /> : null}
      </div>
    );
  }
  return (
    <div className="studio-node-output">
      {output.src ? (
        // biome-ignore lint/a11y/useMediaCaption: generated clips have no track
        <video controls playsInline src={output.src} className="studio-node-video nodrag" />
      ) : (
        <span>{t("Video ready - saved to the gallery.")}</span>
      )}
    </div>
  );
}
