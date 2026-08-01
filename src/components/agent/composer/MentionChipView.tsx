import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { IconFileText } from "central-icons/IconFileText";
import { IconFolder1 } from "central-icons/IconFolder1";
import { IconNoteText } from "central-icons/IconNoteText";

import type { ComposerMentionKind } from "../../../lib/agent-mentions";

const CHIP_ICONS = {
  file: IconFileText,
  folder: IconFolder1,
  note: IconNoteText,
} as const;

/** An `@` mention in the composer: the document's name, not its path. The path
 * is real but long, and the user picked the document by name — the full
 * location travels invisibly in the node's attributes and lands in the
 * reference block at send time. */
export function MentionChipView({ node }: NodeViewProps) {
  const kind = (node.attrs.kind as ComposerMentionKind) ?? "file";
  const Icon = CHIP_ICONS[kind] ?? IconFileText;
  const label = (node.attrs.label as string) ?? "";
  const title = (node.attrs.path as string) || label;

  return (
    <NodeViewWrapper
      as="span"
      className="agent-mention-chip"
      data-kind={kind}
      title={title}
      contentEditable={false}
    >
      <span className="agent-mention-chip-icon" aria-hidden="true">
        <Icon size={11} />
      </span>
      {/* The label owns the truncation: `text-overflow` needs a block-ish box,
       * and the chip itself is a flex row. A long file name therefore elides
       * with an ellipsis instead of being cut mid-word. */}
      <span className="agent-mention-chip-label">{label}</span>
    </NodeViewWrapper>
  );
}
