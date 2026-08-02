// Runs a workflow and persists its deliverables to the gallery. The engine
// itself is storage-agnostic (it only produces typed node outputs); saving the
// output-node results is the caller's job. The desktop canvas does this inline;
// mobile (template runner + linear editor) shares this helper so a flow's
// image/video/track actually lands in the gallery — before this, mobile ran
// flows but never saved them.

import { artifactDataUrl } from "../artifact-media";
import { isMobilePlatform } from "../mobile";
import { artifactSrc, saveArtifactFromBase64, saveArtifactFromUrl } from "./artifacts";
import {
  type NodeRunResult,
  runWorkflow,
  type RunWorkflowOptions,
  type Workflow,
} from "./workflow";

function audioExtension(mimeType: string): string {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("flac")) return "flac";
  return "mp3";
}

/**
 * Bring a rendered clip down to disk and hand back a URL this webview can
 * decode, so a `lastFrame` node can read a still out of it.
 *
 * The download has to go through Rust either way (the webview cannot fetch the
 * backend cross-origin), which means the clip lands in the gallery - the right
 * outcome anyway: an intermediate shot of a chain is a deliverable, not a
 * temp file. On iOS the asset protocol does not resolve in the webview and a
 * data: URL cannot answer the byte-range requests a <video> makes, so the
 * bytes come back as a blob: URL instead.
 */
export async function materializeVideo(url: string): Promise<string> {
  const artifact = await saveArtifactFromUrl(url, "mp4", {
    kind: "video",
    model: "workflow",
    prompt: "",
  });
  return isMobilePlatform() ? artifactDataUrl(artifact) : artifactSrc(artifact);
}

/** Runs `workflow` and saves whatever reached an `output` node to the gallery.
 * Returns the finished per-node results (same shape `runWorkflow` returns). */
export async function runAndSaveWorkflow(
  workflow: Workflow,
  options?: RunWorkflowOptions,
): Promise<Map<string, NodeRunResult>> {
  const outputNodeIds = new Set(
    workflow.nodes.filter((node) => node.type === "output").map((node) => node.id),
  );
  const finished = await runWorkflow(workflow, { materializeVideo, ...options });
  for (const [nodeId, result] of finished) {
    if (!outputNodeIds.has(nodeId) || !result.output) continue;
    const output = result.output;
    const metadata = { model: "workflow", prompt: workflow.name };
    if (output.kind === "image") {
      await saveArtifactFromBase64(output.base64, "png", { ...metadata, kind: "image" });
    } else if (output.kind === "video") {
      await saveArtifactFromUrl(output.url, "mp4", { ...metadata, kind: "video" });
    } else if (output.kind === "audio" && output.url) {
      await saveArtifactFromUrl(output.url, "mp3", {
        ...metadata,
        kind: output.source ?? "music",
      });
    } else if (output.kind === "audio" && output.base64) {
      await saveArtifactFromBase64(output.base64, audioExtension(output.mimeType), {
        ...metadata,
        kind: output.source ?? "speech",
      });
    }
  }
  return finished;
}
