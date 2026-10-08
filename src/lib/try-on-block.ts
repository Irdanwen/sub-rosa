/**
 * The `subrosa:tryon` chat block: the assistant proposes a virtual try-on,
 * and the card it renders lets the person pick the two photos, see the price
 * and start it themselves (`src/lib/studio/try-on.ts`). The payload carries
 * no image and no price: both come from the person and the catalog, never
 * from the model.
 */

export type TryOnChatBlock = {
  kind: "tryon";
  title?: string;
  /** A few words naming the garment, folded into the tuned prompt. */
  garment?: string;
};

const MAX_TITLE = 120;
const MAX_GARMENT = 160;

function capped(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Parses a `subrosa:tryon` payload (already JSON-decoded, `v` checked). */
export function parseTryOnPayload(payload: Record<string, unknown>): TryOnChatBlock {
  const title = capped(payload.title, MAX_TITLE);
  const garment = capped(payload.garment, MAX_GARMENT);
  return {
    kind: "tryon",
    ...(title ? { title } : {}),
    ...(garment ? { garment } : {}),
  };
}

/** The block as plain text, for copying a reply. */
export function tryOnPlainText(block: TryOnChatBlock): string[] {
  return [block.title || "Try it on", ...(block.garment ? [`- ${block.garment}`] : [])];
}
