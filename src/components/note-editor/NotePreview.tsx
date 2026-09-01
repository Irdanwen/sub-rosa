import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { ResolvedPos } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import type { JSONContent } from "@tiptap/react";
import { useKeyboardInset } from "../../lib/keyboard-inset";
import { useNoteRewrite, type StartRewrite } from "../../lib/note-rewrite";
import type { Anchor } from "./useAnchoredPanel";
import { RewritePanel } from "./RewritePanel";
import { isMobilePlatform } from "../../lib/mobile";
import { docToMarkdown, markdownToDoc } from "../../lib/note-markdown";
import { noteEditorExtensions } from "./extensions";
import { SelectionToolbar } from "./SelectionToolbar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type NotePreviewProps = {
  noteId: string;
  markdown: string;
  // Tagged with the noteId the editor was created under so a late
  // blur (during note-switch teardown) can't silently overwrite a
  // different note's content.
  onChange: (noteId: string, markdown: string) => void;
  emptyPlaceholder?: string;
};

export function NotePreview({ noteId, markdown, onChange, emptyPlaceholder }: NotePreviewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [toolbar, setToolbar] = useState<Anchor | null>(null);
  const [linkRequested, setLinkRequested] = useState(false);
  // The toolbar takes focus while one of its fields is open — a link address,
  // a target language, an instruction — which blurs the editor. Without this
  // the toolbar would dismiss itself the instant the caret entered its own
  // field.
  const [fieldOpen, setFieldOpen] = useState(false);
  // On a phone the toolbar is docked above the keyboard for as long as the
  // editor has focus, rather than appearing on a selection: making a selection
  // with a thumb is the hard part, and a control that only exists afterwards
  // is a control nobody finds.
  const [focused, setFocused] = useState(false);
  const docked = useMemo(() => isMobilePlatform(), []);
  const keyboardInset = useKeyboardInset();
  const {
    run: rewriteRun,
    start: startRewriteRun,
    stop: stopRewrite,
    dismiss: dismissRewrite,
  } = useNoteRewrite();
  // The range the revision would replace, captured when the rewrite starts and
  // then *carried through every edit that lands while the model works*. The
  // panel does not lock the editor, so the user can keep typing above the
  // passage — and a stored absolute position, applied afterwards, would
  // overwrite whatever had slid into its place.
  const rewriteRange = useRef<{ from: number; to: number } | null>(null);
  const lastRewriteInput = useRef<Parameters<StartRewrite>[0] | null>(null);
  // Survives the blur that focusing the link field causes, so the field stays
  // anchored to the text it is about to link.
  const lastToolbarPosition = useRef<Anchor | null>(null);
  // Keyed on the note, not the markdown: the editor is torn down and rebuilt
  // on a note change, and re-parsing on every keystroke would fight the user.
  const initialDoc = useMemo(() => markdownToDoc(markdown), [noteId]);
  const focusedExternalMarkdown = useRef<{
    editorMarkdown: string;
    externalMarkdown: string;
  } | null>(null);

  const editor = useEditor(
    {
      extensions: [
        ...noteEditorExtensions({ palette: !docked }),
        Placeholder.configure({
          placeholder:
            emptyPlaceholder ??
            "Hit record to capture a conversation, or just start typing your thoughts here",
        }),
      ],
      content: initialDoc,
      editorProps: {
        attributes: {
          class: "note-preview",
          role: "textbox",
          "aria-label": "Generated note",
          "aria-multiline": "true",
        },
        handleKeyDown: (_view, event) => {
          // Cmd-K is the link shortcut everywhere else in this app's world.
          // Handled here rather than as an extension keymap so the toolbar,
          // which owns the field, is the thing that opens.
          if (event.key === "k" && (event.metaKey || event.ctrlKey) && !event.altKey) {
            event.preventDefault();
            setLinkRequested(true);
            return true;
          }
          return false;
        },
      },
      onBlur: ({ editor }) => {
        // `noteId` here is the value at editor-creation time — the
        // useEditor dep list tears the editor down on note change, so
        // this closure always reflects the note the editor was bound
        // to, even when blur fires during teardown.
        const editorMarkdown = docToMarkdown(editor.state.doc);
        const mergedMarkdown = mergeFocusedExternalMarkdown(
          editorMarkdown,
          focusedExternalMarkdown.current,
        );
        focusedExternalMarkdown.current = null;
        onChange(noteId, mergedMarkdown);
      },
    },
    [noteId],
  );

  useEffect(() => {
    if (!editor) return;

    function updateToolbar() {
      const next = getToolbarPosition(editor);
      if (next) lastToolbarPosition.current = next;
      setToolbar(next);
    }
    function hideToolbar() {
      setToolbar(null);
    }

    function markFocused() {
      setFocused(true);
      updateToolbar();
    }
    function markBlurred() {
      setFocused(false);
      hideToolbar();
    }

    function followEdits({ transaction }: { transaction: Transaction }) {
      const range = rewriteRange.current;
      if (!range || !transaction.docChanged) return;
      rewriteRange.current = {
        from: transaction.mapping.map(range.from),
        to: transaction.mapping.map(range.to),
      };
    }

    editor.on("selectionUpdate", updateToolbar);
    editor.on("transaction", followEdits);
    editor.on("focus", markFocused);
    editor.on("blur", markBlurred);
    window.addEventListener("scroll", updateToolbar, true);

    return () => {
      editor.off("selectionUpdate", updateToolbar);
      editor.off("transaction", followEdits);
      editor.off("focus", markFocused);
      editor.off("blur", markBlurred);
      window.removeEventListener("scroll", updateToolbar, true);
    };
  }, [editor]);

  // Backend writes (transcribe → generate) arrive after the editor has
  // already mounted, so we have to pull new markdown in by hand. Skip
  // if the user is actively editing — clobbering focused content would
  // be a worse bug than the stale render. Guarded with try/catch and
  // an isDestroyed check so we never touch a torn-down view during
  // note-switch unmounts.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    try {
      const current = docToMarkdown(editor.state.doc).trim();
      if (current === markdown.trim()) return;
      if (editor.isFocused) {
        focusedExternalMarkdown.current = {
          editorMarkdown: current,
          externalMarkdown: markdown,
        };
        return;
      }
      editor.commands.setContent(markdownToDoc(markdown), {
        emitUpdate: false,
      });
    } catch {
      // Editor is mid-teardown or view isn't ready yet — the next
      // mount will paint the correct content.
    }
  }, [editor, markdown]);

  const startRewrite = useCallback(
    (input: {
      kind: Parameters<StartRewrite>[0]["kind"];
      targetLanguage?: string;
      instruction?: string;
    }) => {
      if (!editor) return;
      const { from, to } = editor.state.selection;
      if (from === to) return;
      rewriteRange.current = { from, to };
      // The model is handed markdown, not plain text: it is told to keep the
      // structure, and it cannot keep what it was never shown.
      const full = { ...input, text: docToMarkdown(editor.state.doc.cut(from, to)) };
      lastRewriteInput.current = full;
      startRewriteRun(full);
    },
    [editor, startRewriteRun],
  );

  const applyRevision = useCallback(
    (text: string, mode: "replace" | "below") => {
      const range = rewriteRange.current;
      if (!editor || !range) return;
      const blocks = (markdownToDoc(text).content ?? []) as JSONContent[];

      // One transaction, so Cmd-Z takes the whole revision back in one press,
      // and so the blur serializer stays the only writer to the note.
      if (mode === "replace") {
        const target = replacementTarget(editor, range, blocks);
        editor.chain().focus().insertContentAt(target.range, target.content).run();
      } else {
        editor.chain().focus().insertContentAt(afterBlockAt(editor, range.to), blocks).run();
      }
      rewriteRange.current = null;
      dismissRewrite();
    },
    [editor, dismissRewrite],
  );

  const refreshToolbar = useCallback(() => {
    const next = getToolbarPosition(editor);
    if (next) lastToolbarPosition.current = next;
    setToolbar(next);
  }, [editor]);

  return (
    <div ref={wrapRef} className="note-preview-wrap">
      <EditorContent editor={editor} />
      {editor && rewriteRun ? (
        <RewritePanel
          run={rewriteRun}
          docked={docked}
          keyboardInset={keyboardInset}
          position={toolbar ?? lastToolbarPosition.current ?? getCaretPosition(editor)}
          onReplace={(text) => applyRevision(text, "replace")}
          onInsertBelow={(text) => applyRevision(text, "below")}
          onRetry={() => {
            const previous = lastRewriteInput.current;
            if (previous) startRewriteRun(previous);
          }}
          onStop={stopRewrite}
          onDismiss={() => {
            rewriteRange.current = null;
            dismissRewrite();
            editor.commands.focus();
          }}
        />
      ) : null}
      {editor &&
      !rewriteRun &&
      (docked ? focused || fieldOpen : toolbar || linkRequested || fieldOpen) ? (
        <SelectionToolbar
          editor={editor}
          docked={docked}
          keyboardInset={keyboardInset}
          onRewrite={startRewrite}
          // While the link field is open the editor is blurred, so there is no
          // selection to measure: hold the position it was opened at. Cmd-K on
          // a bare caret has no selection either, so fall back to the caret.
          position={toolbar ?? lastToolbarPosition.current ?? getCaretPosition(editor)}
          linkRequested={linkRequested}
          onLinkRequestHandled={() => setLinkRequested(false)}
          onAfterCommand={refreshToolbar}
          onFieldOpenChange={setFieldOpen}
        />
      ) : null}
    </div>
  );
}

function mergeFocusedExternalMarkdown(
  editorMarkdown: string,
  pending: { editorMarkdown: string; externalMarkdown: string } | null,
) {
  if (!pending) return editorMarkdown;
  if (editorMarkdown.trim() === pending.externalMarkdown.trim()) {
    return editorMarkdown;
  }

  const base = pending.editorMarkdown.trim();
  const external = pending.externalMarkdown.trim();
  if (!external) return editorMarkdown;
  if (!base) {
    return editorMarkdown.trim()
      ? appendMarkdown(editorMarkdown, external)
      : pending.externalMarkdown;
  }
  if (!external.startsWith(base)) return editorMarkdown;

  const appended = external.slice(base.length).trim();
  if (!appended || editorMarkdown.trimEnd().endsWith(appended)) {
    return editorMarkdown;
  }
  return appendMarkdown(editorMarkdown, appended);
}

function appendMarkdown(existing: string, addition: string) {
  const existingTrimmed = existing.trimEnd();
  const additionTrimmed = addition.trim();
  if (!existingTrimmed) return additionTrimmed;
  if (!additionTrimmed) return existingTrimmed;
  return `${existingTrimmed}\n\n${additionTrimmed}`;
}

/** Where the toolbar wants to sit. Keeping it on screen is the toolbar's own
 * job, since only it knows how wide it currently is. */
function getToolbarPosition(editor: Editor | null): Anchor | null {
  if (!editor || editor.state.selection.empty) return null;
  try {
    const { from, to } = editor.state.selection;
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    return {
      x: (start.left + end.right) / 2,
      top: Math.min(start.top, end.top),
      // The bottom matters as much as the top: a panel with no room above the
      // selection has to know what it is flipping under.
      bottom: Math.max(start.bottom, end.bottom),
    };
  } catch {
    return null;
  }
}

/**
 * What a revision actually replaces, and with what.
 *
 * Three cases, and the middle one is the one that bites.
 *
 * - **Inline selection, inline reply.** Half a sentence corrected comes back
 *   as one paragraph. Inserting that paragraph *as a block* would split the
 *   paragraph the user was in, so its inline content goes in instead and the
 *   paragraph survives.
 * - **Inline selection, structured reply.** A reorganisation into headings and
 *   a checklist cannot go into the middle of a sentence. The range widens to
 *   the whole textblock the selection sits in, so the block *becomes* the new
 *   structure. Without this the old block is left behind, empty — a bare
 *   `- [ ]` with a document nested underneath it.
 * - **Selection already spanning blocks.** Replace it as it stands.
 *
 * The range never widens past the textblock. A rewrite must not replace text
 * the model was never shown, and the neighbouring items of a list are exactly
 * that.
 */
function replacementTarget(
  editor: Editor,
  range: { from: number; to: number },
  blocks: JSONContent[],
): { range: { from: number; to: number }; content: JSONContent[] } {
  const from = editor.state.doc.resolve(range.from);
  const to = editor.state.doc.resolve(range.to);
  const inline = from.sameParent(to) && from.parent.isTextblock;
  if (!inline) return { range, content: blocks };

  if (blocks.length === 1 && blocks[0].type === "paragraph") {
    return { range, content: blocks[0].content ?? [] };
  }
  return { range: structuralRange(from, to), content: blocks };
}

/**
 * The range a structured reply replaces, widened from an inline selection.
 *
 * The textblock, normally. Inside a list item it is the *item*, because a list
 * item is `paragraph block*`: replace only its paragraph and the schema puts
 * an empty one back, and the note ends up with a bare `- [ ]` carrying a
 * document underneath it. Replacing the item lets the list close and reopen
 * around the new blocks, which is what the shape actually wants.
 *
 * Only when the item holds nothing else. An item with a sub-list under it
 * holds text the model was never shown, and no rewrite may replace that.
 *
 * A residual: restructuring the text *inside* a single list item can still
 * leave the list's now-empty first marker behind, because a list may not be
 * empty and the schema puts one back. It is undoable, it loses nothing, the
 * neighbouring items survive, and it takes asking to reorganise one line of a
 * checklist to reach — so it is left alone rather than fixed with a special
 * case that would have to know about every list-shaped node.
 */
function structuralRange(from: ResolvedPos, to: ResolvedPos) {
  const itemDepth = from.depth - 1;
  const item = itemDepth > 0 ? from.node(itemDepth) : null;
  const isLoneTextblock =
    item !== null &&
    (item.type.name === "listItem" || item.type.name === "taskItem") &&
    item.childCount === 1;
  if (isLoneTextblock) {
    return { from: from.before(itemDepth), to: to.after(itemDepth) };
  }
  return { from: from.before(from.depth), to: to.after(to.depth) };
}

/** The position just after the top-level block holding `pos`, which is where
 * "below" means. */
function afterBlockAt(editor: Editor, pos: number) {
  const resolved = editor.state.doc.resolve(pos);
  return resolved.depth >= 1 ? resolved.after(1) : pos;
}

function getCaretPosition(editor: Editor): Anchor {
  try {
    const at = editor.view.coordsAtPos(editor.state.selection.from);
    return { x: at.left, top: at.top, bottom: at.bottom };
  } catch {
    return { x: window.innerWidth / 2, top: 12, bottom: 12 };
  }
}
