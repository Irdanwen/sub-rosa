import { t } from "../../lib/i18n";
import { Extension, type Range } from "@tiptap/react";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import type { Editor } from "@tiptap/react";
import { IconBulletList } from "central-icons/IconBulletList";
import { IconChecklist } from "central-icons/IconChecklist";
import { IconCodeLines } from "central-icons/IconCodeLines";
import { IconDivider } from "central-icons/IconDivider";
import { IconH1 } from "central-icons/IconH1";
import { IconH2 } from "central-icons/IconH2";
import { IconH3 } from "central-icons/IconH3";
import { IconNumberedList } from "central-icons/IconNumberedList";
import { IconOpenQuote1 } from "central-icons/IconOpenQuote1";
import { IconText1 } from "central-icons/IconText1";
import { createSuggestionPopover } from "../agent/composer/suggestionPopover";
import {
  BlockPaletteList,
  type BlockPaletteItem,
  type BlockPaletteListHandle,
  type BlockPaletteListProps,
} from "./BlockPaletteList";

/**
 * The `/` palette, for the blocks a selection toolbar has no good place for.
 *
 * The toolbar acts on text you have already written; this acts where the caret
 * is, on a line you have not written yet. That split is why a quote, a rule
 * and a code block live here and not up there — you do not select something in
 * order to turn it into a horizontal rule.
 *
 * It reuses the composer's popover rather than growing a second one. That
 * module is written to be shared ("shared by every palette the editor offers")
 * and its only composer-specific behavior, anchoring to `.agent-composer-box`,
 * already falls back to the caret when there is no composer to find.
 */

const PLUGIN_KEY = new PluginKey("noteBlockPalette");

type BlockPaletteEntry = BlockPaletteItem & {
  /** Words that should also find this entry, beyond its label. */
  aliases: string[];
  run: (editor: Editor, range: Range) => void;
};

/** Replace the `/query` the user typed, then apply the block. Done as one
 * chain so a single undo takes the whole thing back. */
function at(range: Range, editor: Editor) {
  return editor.chain().focus().deleteRange(range);
}

const ENTRIES: BlockPaletteEntry[] = [
  {
    id: "paragraph",
    label: t("Text"),
    hint: "",
    aliases: ["paragraph", "body", "plain"],
    Icon: IconText1,
    run: (editor, range) => {
      at(range, editor).setParagraph().run();
    },
  },
  ...([1, 2, 3] as const).map((level) => ({
    id: `h${level}`,
    label: t("Heading {level}", { level }),
    hint: `${"#".repeat(level)} `,
    aliases: ["title", "section"],
    Icon: [IconH1, IconH2, IconH3][level - 1],
    run: (editor: Editor, range: Range) => {
      at(range, editor).setHeading({ level }).run();
    },
  })),
  {
    id: "bulletList",
    label: t("Bullet list"),
    hint: "- ",
    aliases: ["unordered", "points"],
    Icon: IconBulletList,
    run: (editor, range) => {
      at(range, editor).toggleBulletList().run();
    },
  },
  {
    id: "orderedList",
    label: t("Numbered list"),
    hint: "1. ",
    aliases: ["ordered", "steps"],
    Icon: IconNumberedList,
    run: (editor, range) => {
      at(range, editor).toggleOrderedList().run();
    },
  },
  {
    id: "taskList",
    label: t("Task list"),
    hint: "[] ",
    aliases: ["todo", "checkbox", "checklist"],
    Icon: IconChecklist,
    run: (editor, range) => {
      at(range, editor).toggleTaskList().run();
    },
  },
  {
    id: "blockquote",
    label: t("Quote"),
    hint: "> ",
    aliases: ["citation"],
    Icon: IconOpenQuote1,
    run: (editor, range) => {
      at(range, editor).toggleBlockquote().run();
    },
  },
  {
    id: "codeBlock",
    label: t("Code block"),
    hint: "```",
    aliases: ["snippet", "pre"],
    Icon: IconCodeLines,
    run: (editor, range) => {
      at(range, editor).toggleCodeBlock().run();
    },
  },
  {
    id: "horizontalRule",
    label: t("Divider"),
    hint: "---",
    aliases: ["rule", "separator", "line"],
    Icon: IconDivider,
    run: (editor, range) => {
      at(range, editor).setHorizontalRule().run();
    },
  },
];

export function blockPaletteItems(query: string): BlockPaletteEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return ENTRIES;
  return ENTRIES.filter(
    (entry) =>
      entry.label.toLowerCase().includes(needle) ||
      entry.aliases.some((alias) => alias.includes(needle)),
  );
}

export const BlockPalette = Extension.create({
  name: "noteBlockPalette",

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: "/",
        pluginKey: PLUGIN_KEY,
        // Only at the start of an empty-ish line: a slash inside a sentence or
        // a path like `src/lib` must not open a menu.
        startOfLine: true,
        allowSpaces: false,
        items: ({ query }) => blockPaletteItems(query),
        command: ({ editor, range, props }) => {
          (props as unknown as BlockPaletteEntry).run(editor, range);
        },
        // The list renders `BlockPaletteItem`, which is the visible half of an
        // entry: it has no business knowing how a block is applied.
        render: createSuggestionPopover<
          BlockPaletteItem,
          BlockPaletteListHandle,
          BlockPaletteListProps
        >({
          listComponent: BlockPaletteList,
          pluginKey: PLUGIN_KEY,
          hostClassName: "note-block-menu-host",
        }),
      }),
    ];
  },
});
