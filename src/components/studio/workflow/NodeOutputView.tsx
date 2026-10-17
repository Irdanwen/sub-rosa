// What a node shows once it has run, or while it is making something.

import { t } from "../../../lib/i18n";
import { explainConstraintError } from "../../../lib/studio/model-constraints";
import { Darkroom } from "../Darkroom";
import type { NodeRunResult, WorkflowNode, WorkflowNodeType } from "../../../lib/studio/workflow";

/** The media node types whose wait is long enough to be worth a frame. A chat
 * node answers in seconds; a video node holds the canvas for minutes. */
const DARKROOM_NODES = new Set<WorkflowNodeType>(["image", "imageEdit", "tts", "music", "video"]);

export function NodeOutputView({ result, node }: { result: NodeRunResult; node: WorkflowNode }) {
  if (result.status === "running") {
    if (!DARKROOM_NODES.has(node.type)) return null;
    // A node that is making something waits the same way the studios do, in
    // the same frame - at the shape of what this node makes, with the run's
    // own progress when the runner reports any.
    const audio = node.type === "music" || node.type === "tts";
    const aspect = typeof node.params.aspect_ratio === "string" ? node.params.aspect_ratio : "1/1";
    const prompt = typeof node.params.prompt === "string" ? node.params.prompt : "";
    return (
      <div className="studio-node-output nodrag">
        <Darkroom
          compact
          variant={audio ? "audio" : "video"}
          seed={node.id + prompt}
          phase="processing"
          progress={typeof result.progress === "number" ? result.progress : undefined}
          aspectRatio={audio ? undefined : aspect}
        />
      </div>
    );
  }
  if (result.status === "error") {
    // A schema rejection reads as a zod report; say what the model wanted
    // instead, next to the pickers that have just been updated with it.
    const explained = result.error ? explainConstraintError(result.error) : undefined;
    return <p className="studio-node-error">{explained ?? result.error}</p>;
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
