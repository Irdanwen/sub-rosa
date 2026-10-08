/**
 * The note's code block, coloured by its language (`lib/code-highlight`).
 *
 * The colour is a decoration, never a mark: it changes what the editor shows
 * and nothing the document holds, so `docToMarkdown` writes the same fence it
 * always did and the round trip has nothing new to carry (spec
 * note-controls-must-serialize). The node is StarterKit's own code block,
 * extended with one plugin, so the schema is unchanged.
 *
 * The grammars load the first time the document holds a block that names a
 * language; until then it shows plain, and the plugin repaints once they land.
 */

import CodeBlock from "@tiptap/extension-code-block";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  codeLanguage,
  codeLanguagesLoaded,
  highlightCode,
  loadCodeLanguages,
} from "../../lib/code-highlight";
import "../../styles/code-highlight.css";

const highlightKey = new PluginKey<DecorationSet>("noteCodeHighlight");

function namesALanguage(doc: ProseMirrorNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === "codeBlock" && codeLanguage(node.attrs.language)) found = true;
    return !found;
  });
  return found;
}

export function codeDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return true;
    const spans = highlightCode(node.textContent, node.attrs.language);
    let from = pos + 1;
    for (const span of spans ?? []) {
      const to = from + span.text.length;
      if (span.className) decorations.push(Decoration.inline(from, to, { class: span.className }));
      from = to;
    }
    return false;
  });
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

export const NoteCodeBlock = CodeBlock.extend({
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin<DecorationSet>({
        key: highlightKey,
        state: {
          init: (_config, state) => codeDecorations(state.doc),
          apply: (tr, previous) =>
            tr.docChanged || tr.getMeta(highlightKey)
              ? codeDecorations(tr.doc)
              : previous.map(tr.mapping, tr.doc),
        },
        props: {
          decorations: (state) => highlightKey.getState(state),
        },
        view: (view) => {
          let live = true;
          let waiting = false;
          const request = () => {
            if (waiting || codeLanguagesLoaded() || !namesALanguage(view.state.doc)) return;
            waiting = true;
            void loadCodeLanguages().then(
              () => {
                if (live && !view.isDestroyed) {
                  view.dispatch(view.state.tr.setMeta(highlightKey, true));
                }
              },
              () => {
                waiting = false;
              },
            );
          };
          request();
          return {
            update: request,
            destroy: () => {
              live = false;
            },
          };
        },
      }),
    ];
  },
});
