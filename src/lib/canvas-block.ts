// The canvas block is shared with the web client
// (`@subrosa/chat-core/canvas-block`); the app gives it its own fallback title.
import {
  type CanvasChatBlock,
  parseCanvasPayload as parseCanvasWith,
} from "@subrosa/chat-core/canvas-block";
import { t } from "./i18n";

export * from "@subrosa/chat-core/canvas-block";

/** Parses a `subrosa:canvas` payload (already JSON-decoded, `v` checked). */
export function parseCanvasPayload(payload: Record<string, unknown>): CanvasChatBlock | null {
  return parseCanvasWith(payload, t("Canvas"));
}
