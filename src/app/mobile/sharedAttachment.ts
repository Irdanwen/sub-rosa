import { downscaleImageFile } from "../../components/mobile/ChatComposer";
import type { AgentLiteAttachment } from "../../lib/tauri";

/**
 * A shared picture or document as the chat composer holds it (ADR-0095). A
 * picture is downsized the way a picked one is, so a shared photo costs what
 * an attached one does.
 */
export async function composerAttachment(
  attachment: AgentLiteAttachment,
): Promise<AgentLiteAttachment> {
  if (attachment.kind !== "image") return attachment;
  // Decoded by hand: the app's policy keeps `fetch` off data URLs.
  const [header, encoded = ""] = attachment.data.split(",", 2);
  const type = /^data:([^;,]+)/.exec(header)?.[1] ?? "image/jpeg";
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const file = new File([bytes], attachment.name, { type });
  return { ...attachment, data: await downscaleImageFile(file) };
}
