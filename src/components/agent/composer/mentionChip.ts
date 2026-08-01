import Mention from "@tiptap/extension-mention";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { PluginKey } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import { MentionChipView } from "./MentionChipView";
import {
  MentionSuggestionList,
  type MentionSuggestionListHandle,
  type MentionSuggestionListProps,
} from "./MentionSuggestionList";
import { createSuggestionPopover } from "./suggestionPopover";
import type { ComposerMention, ComposerMentionItem } from "../../../lib/agent-mentions";

/** Node name for an inline `@` mention. Distinct from the category chip so the
 * two palettes' styling and doc queries never collide. */
export const MENTION_CHIP_NODE = "agentMention";

/** "@" opens the document palette. Unlike the "/" palette this one may appear
 * mid-sentence ("rewrite @notes/draft.md please"), which is why it does not
 * require a leading position. */
const TRIGGER_CHAR = "@";
const MENTION_SUGGESTION_PLUGIN_KEY = new PluginKey("agentMentionSuggestion");

/** Reads every mention in a doc, in document order, so the send path can turn
 * them into resolved references. */
export function mentionsFromDoc(doc: ProseMirrorNode): ComposerMention[] {
  const mentions: ComposerMention[] = [];
  doc.descendants((node) => {
    if (node.type.name !== MENTION_CHIP_NODE) return true;
    const label = typeof node.attrs.label === "string" ? node.attrs.label : "";
    const kind =
      node.attrs.kind === "folder" || node.attrs.kind === "note" ? node.attrs.kind : "file";
    if (!label) return false;
    mentions.push({
      kind,
      label,
      ...(typeof node.attrs.path === "string" && node.attrs.path ? { path: node.attrs.path } : {}),
      ...(typeof node.attrs.noteId === "string" && node.attrs.noteId
        ? { noteId: node.attrs.noteId }
        : {}),
    });
    return false;
  });
  return mentions;
}

/** The same mention twice is one reference: the block below the message would
 * otherwise repeat the path, which reads as two different documents. */
export function dedupeMentions(mentions: ComposerMention[]): ComposerMention[] {
  const seen = new Set<string>();
  return mentions.filter((mention) => {
    const key = `${mention.kind}:${mention.noteId ?? mention.path ?? mention.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const MentionChipBase = Mention.extend({
  name: MENTION_CHIP_NODE,

  addAttributes() {
    return {
      label: { default: "" },
      kind: { default: "file" },
      path: { default: "" },
      noteId: { default: "" },
    };
  },

  /** The chip reads as "@name" in the plain text sent to the agent, so the
   * sentence still makes sense on its own; the resolved path rides in the
   * reference block appended at send time. */
  renderText({ node }) {
    return `@${(node.attrs.label as string) ?? ""}`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionChipView);
  },
});

export type MentionChipOptions = {
  /** Resolves the palette's rows for a query. Async because the files come
   * from the backend; an empty result renders the "No matches" row. */
  items: (query: string) => Promise<ComposerMentionItem[]>;
};

export function createMentionChip(options: MentionChipOptions) {
  return MentionChipBase.configure({
    deleteTriggerWithBackspace: true,
    renderHTML({ node }) {
      return [
        "span",
        {
          class: "agent-mention-chip",
          "data-kind": (node.attrs.kind as string) ?? "file",
        },
        `@${(node.attrs.label as string) ?? ""}`,
      ];
    },
    suggestion: {
      char: TRIGGER_CHAR,
      pluginKey: MENTION_SUGGESTION_PLUGIN_KEY,
      // File names contain no spaces often enough, and allowing them would
      // keep the palette open across a whole sentence.
      allowSpaces: false,
      items: ({ query }) => options.items(query),
      command: ({ editor, range, props }) => {
        const item = props as unknown as ComposerMentionItem;
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            {
              type: MENTION_CHIP_NODE,
              attrs: {
                label: item.label,
                kind: item.kind,
                path: item.path ?? "",
                noteId: item.noteId ?? "",
              },
            },
            // A trailing space so the user keeps typing the sentence instead
            // of landing glued to the chip.
            { type: "text", text: " " },
          ])
          .run();
      },
      render: createSuggestionPopover<
        ComposerMentionItem,
        MentionSuggestionListHandle,
        MentionSuggestionListProps
      >({
        listComponent: MentionSuggestionList,
        pluginKey: MENTION_SUGGESTION_PLUGIN_KEY,
        hostClassName: "agent-mention-menu-host",
      }),
    },
  });
}
