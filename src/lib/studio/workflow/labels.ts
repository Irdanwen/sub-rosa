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
