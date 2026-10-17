// What a person reads for each kind of workflow node, in their language.

import { t } from "../../i18n";
import type { WorkflowNodeType } from "./schema";

export function nodeTypeLabel(type: WorkflowNodeType | string): string {
  switch (type) {
    case "textInput":
      return t("Text input");
    case "asset":
      return t("Asset");
    case "document":
      return t("Document");
    case "chat":
      return t("Chat");
    case "image":
      return t("Image");
    case "imageEdit":
      return t("Image edit");
    case "tts":
      return t("Text to speech");
    case "music":
      return t("Music");
    case "video":
      return t("Video");
    case "lastFrame":
      return t("Frame from video");
    case "gate":
      return t("Approval gate");
    case "assemble":
      return t("Assemble");
    case "output":
      return t("Output");
    default:
      return String(type);
  }
}

/** An input port's name, in the reader's language. Port ids are unique per
 * schema, and only `in` means two things (a gate's candidates, an output's
 * result). Unknown ids fall back to the schema's own wording. */
export function portLabel(type: WorkflowNodeType | string, port: { id: string; label: string }) {
  switch (port.id) {
    case "prompt":
      return t("Prompt");
    case "images":
      return t("Images");
    case "text":
      return t("Text");
    case "openingFrame":
      return t("Opening frame");
    case "endFrame":
      return t("End frame");
    case "references":
      return t("References");
    case "referenceClips":
      return t("Reference clips");
    case "referenceAudio":
      return t("Reference audio");
    case "video":
      return t("Video");
    case "in":
      return type === "gate" ? t("Candidates") : t("Result");
    case "clips":
      return t("Clips");
    case "dialogue":
      return t("Dialogue");
    case "sfx":
      return t("Effects");
    case "music":
      return t("Music");
    case "audio":
      return t("Audio track");
    default:
      return port.label;
  }
}

/** A setting's name, in the reader's language. */
export function paramLabel(param: { name: string; label: string }): string {
  switch (param.name) {
    case "text":
      return t("Text");
    case "assetKind":
      return t("Kind");
    case "artifactId":
      return t("Gallery item");
    case "noteId":
      return t("Note");
    case "model":
      return t("Model");
    case "prompt":
      return t("Prompt");
    case "temperature":
      return t("Temperature");
    case "maxTokens":
      return t("Max tokens");
    case "negativePrompt":
      return t("Negative prompt");
    case "aspectRatio":
      return t("Aspect ratio");
    case "stylePreset":
      return t("Style preset");
    case "hideWatermark":
      return t("Hide watermark");
    case "voice":
      return t("Voice");
    case "speed":
      return t("Speed");
    case "startAt":
      return t("Starts at");
    case "responseFormat":
      return t("Response format");
    case "lyrics":
      return t("Lyrics");
    case "durationSeconds":
      return t("Duration (seconds)");
    case "instrumental":
      return t("Instrumental");
    case "writeLyrics":
      return t("Write the lyrics for me");
    case "loop":
      return t("Seamless loop");
    case "duration":
      return t("Duration");
    case "resolution":
      return t("Resolution");
    case "position":
      return t("Frame");
    case "note":
      return t("What to check");
    case "mode":
      return t("Who decides");
    case "judgeModel":
      return t("Judge");
    case "audioVolume":
      return t("Music level");
    case "normalize":
      return t("Level the film");
    default:
      return param.label;
  }
}

/** A choice in a list setting, in the reader's language. File formats keep
 * their own names. */
export function enumLabel(paramName: string, value: string): string {
  switch (`${paramName}:${value}`) {
    case "assetKind:image":
      return t("Image");
    case "assetKind:video":
      return t("Video");
    case "assetKind:audio":
      return t("Audio");
    case "position:handoff":
      return t("Handoff point");
    case "position:end":
      return t("Last frame");
    case "position:start":
      return t("First frame");
    case "mode:human":
      return t("You");
    case "mode:judged":
      return t("A judge");
    case "mode:judged-then-human":
      return t("A judge, then you");
    default:
      return value;
  }
}

/** What flows along a connection, named for a person. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case "text":
      return t("text");
    case "image":
      return t("an image");
    case "audio":
      return t("audio");
    case "video":
      return t("a video");
    default:
      return t("anything");
  }
}
