import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconGlobe } from "central-icons/IconGlobe";
import type { ChatBlock, LinksChatBlock } from "../../lib/chat-blocks";
import { openExternalUrl } from "../../lib/tauri";

/**
 * Renders one parsed chat block (see src/lib/chat-blocks.ts). Shared by the
 * desktop markdown renderer and mobile SimpleMarkdown, so it styles itself
 * with tokens only and owns no layout assumptions beyond "inline in a reply".
 */
export function ChatBlockView({ block }: { block: ChatBlock }) {
  switch (block.kind) {
    case "links":
      return <LinkPreviewCard block={block} />;
    default:
      return null;
  }
}

/**
 * Placeholder while a block's fence is still streaming in: the card's shape
 * with pulsing bars, so the reply never flashes half-written JSON. Bars rest
 * under prefers-reduced-motion (see app.css).
 */
export function ChatBlockSkeleton() {
  return (
    <div className="chat-block chat-block-skeleton" aria-hidden>
      <span className="chat-block-skeleton-bar" style={{ width: "38%" }} />
      <span className="chat-block-skeleton-bar" style={{ width: "86%" }} />
      <span className="chat-block-skeleton-bar" style={{ width: "72%" }} />
    </div>
  );
}

function LinkPreviewCard({ block }: { block: LinksChatBlock }) {
  return (
    <section className="chat-block" aria-label={block.title || "Sources"}>
      {block.title ? <h4 className="chat-block-title">{block.title}</h4> : null}
      <ul className="chat-block-rows">
        {block.links.map((link) => (
          <li key={link.url}>
            <button
              type="button"
              className="chat-block-row"
              onClick={() => void openExternalUrl(link.url)}
              title={link.url}
            >
              <span className="chat-block-row-icon" aria-hidden>
                <IconGlobe size={16} />
              </span>
              <span className="chat-block-row-body">
                <span className="chat-block-row-title">{link.title}</span>
                <span className="chat-block-row-meta">
                  {link.domain}
                  {link.publishedAt ? ` · ${link.publishedAt}` : ""}
                  {link.snippet ? ` · ${link.snippet}` : ""}
                </span>
              </span>
              <span className="chat-block-row-open" aria-hidden>
                <IconArrowUpRight size={14} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
