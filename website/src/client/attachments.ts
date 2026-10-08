/**
 * Files and images attached to one turn, as the phone attaches them
 * (`ChatComposer.tsx`, `agent_lite::attach_to_last_user_message`):
 *
 * - the stored message keeps only markers (`[Image: name]`, `[File: name]`),
 *   so the account never carries the bytes and a reread chat says what was
 *   attached;
 * - the turn that sends them carries their content: a text file as a fenced
 *   block under `[File: name]` (60,000 characters for all of them together),
 *   an image as an `image_url` part with a data URL (four at most).
 *
 * An image turn needs a model that reads images. `visionModelFor` is the
 * app's rule (`assistants::runtime::vision_model_for`): keep the chosen model
 * when it reads images, else the first one by name that does and is exactly
 * as private; when none is, the image is refused rather than carried, with the
 * whole conversation, to a less private model.
 */
import type { ChatMessage } from "./carpe-diem";

export interface Attachment {
  kind: "image" | "text";
  name: string;
  /** A `data:image/…` URL for an image, the extracted text for a file. */
  data: string;
}

export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_TEXT_ATTACHMENT_CHARS = 60_000;
/** The long edge an attached photo is brought down to, as on the phone. */
export const IMAGE_MAX_EDGE = 2048;

/** The stored question: the text, then one marker per attachment. */
export function withAttachmentMarkers(content: string, attachments: Attachment[]): string {
  const markers = attachments
    .map((entry) => `[${entry.kind === "image" ? "Image" : "File"}: ${entry.name}]`)
    .join(" ");
  return [content, markers].filter(Boolean).join("\n") || markers;
}

export function hasAttachmentMarkers(content: string): boolean {
  return content.includes("[Image: ") || content.includes("[File: ");
}

/** Folds the attachments into the last user message of `messages`. */
export function attachToLastUserMessage(messages: ChatMessage[], attachments: Attachment[]) {
  if (!attachments.length) return;
  const index = messages.map((message) => message.role).lastIndexOf("user");
  if (index < 0) return;
  const last = messages[index];
  let text = typeof last.content === "string" ? last.content : "";
  let budget = MAX_TEXT_ATTACHMENT_CHARS;
  for (const attachment of attachments.filter((entry) => entry.kind === "text")) {
    const content = Array.from(attachment.data).slice(0, budget).join("");
    budget -= Array.from(content).length;
    text += `\n\n[File: ${attachment.name}]\n\`\`\`\n${content}\n\`\`\``;
    if (budget <= 0) {
      text += "\n[Remaining file content truncated.]";
      break;
    }
  }
  const images = attachments
    .filter((entry) => entry.kind === "image" && entry.data.startsWith("data:image/"))
    .slice(0, MAX_IMAGE_ATTACHMENTS);
  messages[index] = images.length
    ? {
        role: "user",
        content: [
          { type: "text", text },
          ...images.map((image) => ({
            type: "image_url" as const,
            image_url: { url: image.data },
          })),
        ],
      }
    : { role: "user", content: text };
}

export interface VisionCandidate {
  id: string;
  name: string;
  privacy?: string;
  supportsVision?: boolean;
}

/** The model an image turn runs on: `current` when it reads images, else the
 * first text model by name that does and is as private, else null. */
export function visionModelFor(models: VisionCandidate[], current: string): string | null {
  const own = models.find((model) => model.id === current);
  if (own?.supportsVision) return current;
  const wanted = own?.privacy;
  return (
    models
      .filter((model) => model.supportsVision && (!wanted || model.privacy === wanted))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0]?.id ?? null
  );
}

/** A photo brought down to the phone's size, as a JPEG data URL. Swappable in
 * tests, where there is no canvas. */
export type ImageFitter = (file: Blob) => Promise<string>;

export const canvasImageFitter: ImageFitter = async (file) => {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No canvas.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
};
