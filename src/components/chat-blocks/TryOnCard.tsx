import { t } from "../../lib/i18n";
import type { TryOnChatBlock } from "../../lib/try-on-block";
import { TryOnPanel } from "../studio/TryOnPanel";

/**
 * The assistant's try-on proposal. It carries no photo and no price: the
 * person picks both photos here and starts the paid edit with their own tap.
 * The result lands in the gallery as a chat picture, so the Library finds it.
 */
export function TryOnCard({ block }: { block: TryOnChatBlock }) {
  const title = block.title || t("Try it on");
  return (
    <section className="chat-block assistant-media-card" aria-label={title}>
      <h4 className="chat-block-title">{title}</h4>
      {block.garment ? <p>{block.garment}</p> : null}
      <TryOnPanel garmentLabel={block.garment} origin={{ surface: "chat" }} />
    </section>
  );
}
