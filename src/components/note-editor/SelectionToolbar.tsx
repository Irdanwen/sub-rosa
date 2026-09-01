import type { Editor } from "@tiptap/react";
import { IconBold } from "central-icons/IconBold";
import { IconBulletList } from "central-icons/IconBulletList";
import { IconChainLink1 } from "central-icons/IconChainLink1";
import { IconChecklist } from "central-icons/IconChecklist";
import { IconCode } from "central-icons/IconCode";
import { IconH1 } from "central-icons/IconH1";
import { IconH2 } from "central-icons/IconH2";
import { IconH3 } from "central-icons/IconH3";
import { IconHighlight } from "central-icons/IconHighlight";
import { IconItalic } from "central-icons/IconItalic";
import { IconNumberedList } from "central-icons/IconNumberedList";
import { IconSparkle } from "central-icons/IconSparkle";
import { IconStrikeThrough } from "central-icons/IconStrikeThrough";
import type { CentralIconBaseProps } from "central-icons/CentralIconBase";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { type Anchor, useAnchoredPanel } from "./useAnchoredPanel";
import type { RewriteKind } from "../../lib/tauri";

/**
 * The toolbar that follows a selection.
 *
 * It is the whole formatting surface: this app has no ribbon, and adding one
 * would be borrowing a document processor's furniture for something that is
 * closer to a page of paper. What a ribbon buys is discoverability, and the
 * markdown input rules (`# `, `- `, `1. `, `[] `, `> `) plus this toolbar buy
 * the same thing without a permanent band across the top of the note.
 *
 * Everything here is a **toggle over the current selection**, grouped the way
 * the hand reaches for them: what the block is, what kind of list it is, and
 * how the characters look. A control is offered only if the file can hold what
 * it produces — there is no underline and no font size, because
 * `docToMarkdown` could not write either one back.
 *
 * The last control is the odd one out: it does not change the selection, it
 * asks a model what the selection could be. What comes back is a revision the
 * user accepts or discards (ADR-0038), which is why this toolbar only ever
 * *starts* a rewrite and never applies one.
 */

/** The rewrites offered, in the order they are reached for. `translate` and
 * `custom` need something typed, so they open a field instead of running. */
const REWRITES: { kind: RewriteKind; label: string; needsInput?: "language" | "instruction" }[] = [
  { kind: "correct", label: "Correct spelling and grammar" },
  { kind: "reformulate", label: "Reformulate" },
  { kind: "shorten", label: "Make it shorter" },
  { kind: "expand", label: "Develop it" },
  { kind: "restructure", label: "Reorganise" },
  { kind: "translate", label: "Translate to", needsInput: "language" },
  { kind: "custom", label: "Do something else", needsInput: "instruction" },
];

type ToolbarAction = {
  id: string;
  /** Sentence case: it is a label, not a heading. */
  label: string;
  Icon: ComponentType<CentralIconBaseProps>;
  isActive: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
};

const BLOCK_ACTIONS: ToolbarAction[] = [1, 2, 3].map((level) => ({
  id: `h${level}`,
  label: `Heading ${level}`,
  Icon: [IconH1, IconH2, IconH3][level - 1],
  isActive: (editor) => editor.isActive("heading", { level }),
  run: (editor) => {
    editor
      .chain()
      .focus()
      .toggleHeading({ level: level as 1 | 2 | 3 })
      .run();
  },
}));

const LIST_ACTIONS: ToolbarAction[] = [
  {
    id: "bulletList",
    label: "Bullet list",
    Icon: IconBulletList,
    isActive: (editor) => editor.isActive("bulletList"),
    run: (editor) => {
      editor.chain().focus().toggleBulletList().run();
    },
  },
  {
    id: "orderedList",
    label: "Numbered list",
    Icon: IconNumberedList,
    isActive: (editor) => editor.isActive("orderedList"),
    run: (editor) => {
      editor.chain().focus().toggleOrderedList().run();
    },
  },
  {
    id: "taskList",
    label: "Task list",
    Icon: IconChecklist,
    isActive: (editor) => editor.isActive("taskList"),
    run: (editor) => {
      editor.chain().focus().toggleTaskList().run();
    },
  },
];

const MARK_ACTIONS: ToolbarAction[] = [
  {
    id: "bold",
    label: "Bold",
    Icon: IconBold,
    isActive: (editor) => editor.isActive("bold"),
    run: (editor) => {
      editor.chain().focus().toggleBold().run();
    },
  },
  {
    id: "italic",
    label: "Italic",
    Icon: IconItalic,
    isActive: (editor) => editor.isActive("italic"),
    run: (editor) => {
      editor.chain().focus().toggleItalic().run();
    },
  },
  {
    id: "strike",
    label: "Strikethrough",
    Icon: IconStrikeThrough,
    isActive: (editor) => editor.isActive("strike"),
    run: (editor) => {
      editor.chain().focus().toggleStrike().run();
    },
  },
  {
    id: "highlight",
    label: "Highlight",
    Icon: IconHighlight,
    isActive: (editor) => editor.isActive("highlight"),
    run: (editor) => {
      editor.chain().focus().toggleHighlight().run();
    },
  },
  {
    id: "code",
    label: "Code",
    Icon: IconCode,
    isActive: (editor) => editor.isActive("code"),
    run: (editor) => {
      editor.chain().focus().toggleCode().run();
    },
  },
];

export type SelectionToolbarProps = {
  editor: Editor;
  /** Where to float, on a pointer device. Ignored when `docked`. */
  position: Anchor;
  /** Pinned above the keyboard instead of floating at the selection. A popover
   * that follows the caret is unusable on a phone: the caret is a few
   * millimetres above a keyboard, which is where the popover would go. */
  docked?: boolean;
  /** How far the on-screen keyboard overlaps the layout viewport. The iOS
   * webview does not resize the window when the keyboard opens, so a bar
   * pinned to `bottom: 0` would sit underneath it. */
  keyboardInset?: number;
  /** Open on the link field rather than the buttons, for the Cmd-K path. */
  linkRequested?: boolean;
  onLinkRequestHandled?: () => void;
  /** Re-measure after a command changes the document under the toolbar. */
  onAfterCommand: () => void;
  /** True while the toolbar owns a focused field — the link address, a target
   * language, an instruction. Focusing any of them blurs the editor, which
   * would otherwise dismiss the toolbar out from under the caret, so the host
   * keeps it mounted for as long as this is true. */
  onFieldOpenChange: (open: boolean) => void;
  /** Start a rewrite of the current selection. The toolbar never applies one. */
  onRewrite: (input: { kind: RewriteKind; targetLanguage?: string; instruction?: string }) => void;
};

/** Height of the docked bar, so the menu can sit on top of it rather than
 * under the screen. Kept here because the menu is a sibling of the bar, not a
 * child of it. */
const DOCKED_BAR_HEIGHT = 50;

export function SelectionToolbar({
  editor,
  position,
  docked,
  keyboardInset = 0,
  linkRequested,
  onLinkRequestHandled,
  onAfterCommand,
  onFieldOpenChange,
  onRewrite,
}: SelectionToolbarProps) {
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<(typeof REWRITES)[number] | null>(null);
  const [pendingValue, setPendingValue] = useState("");
  const linkInputRef = useRef<HTMLInputElement>(null);
  const pendingInputRef = useRef<HTMLInputElement>(null);
  const { ref, style } = useAnchoredPanel(position, !docked);
  const menu = useAnchoredPanel(position, !docked && menuOpen);
  const placement = docked
    ? { className: "selection-toolbar note-toolbar-docked", style: { bottom: keyboardInset } }
    : { className: "selection-toolbar", style };

  useEffect(() => {
    if (!linkRequested) return;
    setLinkDraft(currentHref(editor));
    onLinkRequestHandled?.();
  }, [linkRequested, editor, onLinkRequestHandled]);

  // Keyed on whether the field is open, never on what is in it. Keyed on the
  // draft, the select-on-open below re-selects the whole value after every
  // keystroke, so each new character replaces the one before it and a typed
  // URL comes out one letter long.
  const linkOpen = linkDraft !== null;
  const fieldOpen = linkOpen || pending !== null;

  useEffect(() => {
    onFieldOpenChange(fieldOpen);
  }, [fieldOpen, onFieldOpenChange]);

  useEffect(() => {
    if (!linkOpen) return;
    linkInputRef.current?.focus();
    linkInputRef.current?.select();
  }, [linkOpen]);

  // Same rule as the link field: keyed on whether it is open, never on what is
  // in it, so a keystroke does not re-select the value under the caret.
  useEffect(() => {
    if (!pending) return;
    pendingInputRef.current?.focus();
  }, [pending]);

  function chooseRewrite(entry: (typeof REWRITES)[number]) {
    setMenuOpen(false);
    if (entry.needsInput) {
      setPendingValue("");
      setPending(entry);
      return;
    }
    onRewrite({ kind: entry.kind });
  }

  function commitPending() {
    if (!pending) return;
    const value = pendingValue.trim();
    if (!value) return;
    onRewrite(
      pending.needsInput === "language"
        ? { kind: pending.kind, targetLanguage: value }
        : { kind: pending.kind, instruction: value },
    );
    setPending(null);
  }

  function run(action: ToolbarAction) {
    action.run(editor);
    onAfterCommand();
  }

  function commitLink() {
    const href = normalizeHref(linkDraft ?? "");
    const chain = editor.chain().focus().extendMarkRange("link");
    if (href) {
      chain.setLink({ href }).run();
    } else {
      chain.unsetLink().run();
    }
    setLinkDraft(null);
    onAfterCommand();
  }

  if (pending) {
    return (
      <div
        ref={ref}
        className={`${placement.className} selection-toolbar-link`}
        role="toolbar"
        aria-label="Rewrite"
        style={placement.style}
        onMouseDown={(event) => event.preventDefault()}
      >
        <span className="selection-toolbar-prompt">{pending.label}</span>
        <input
          ref={pendingInputRef}
          type="text"
          value={pendingValue}
          placeholder={pending.needsInput === "language" ? "English" : "Turn this into a checklist"}
          aria-label={pending.label}
          onMouseDown={(event) => event.stopPropagation()}
          onChange={(event) => setPendingValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitPending();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setPending(null);
              editor.commands.focus();
            }
          }}
        />
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={commitPending}
        >
          Go
        </button>
      </div>
    );
  }

  if (linkOpen) {
    return (
      <div
        ref={ref}
        className={`${placement.className} selection-toolbar-link`}
        role="toolbar"
        aria-label="Link"
        style={placement.style}
        // Keeps the click from blurring the editor, which would drop the
        // selection the link is about to be applied to.
        onMouseDown={(event) => event.preventDefault()}
      >
        <input
          ref={linkInputRef}
          type="url"
          value={linkDraft}
          placeholder="Paste a link"
          aria-label="Link address"
          onMouseDown={(event) => event.stopPropagation()}
          onChange={(event) => setLinkDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitLink();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setLinkDraft(null);
              editor.commands.focus();
            }
          }}
        />
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={commitLink}>
          {linkDraft.trim() ? "Apply" : "Remove"}
        </button>
      </div>
    );
  }

  return (
    <>
      <div
        ref={ref}
        className={placement.className}
        role="toolbar"
        aria-label="Format selection"
        style={placement.style}
        onMouseDown={(event) => event.preventDefault()}
      >
        {[BLOCK_ACTIONS, LIST_ACTIONS, MARK_ACTIONS].map((group, index) => (
          <ToolbarGroup
            // The groups are a fixed literal, so the index is a stable identity.
            key={group[0].id}
            actions={group}
            editor={editor}
            onRun={run}
            leadingDivider={index > 0}
          />
        ))}
        <span className="divider" aria-hidden />
        <button
          type="button"
          data-active={editor.isActive("link") || undefined}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setLinkDraft(currentHref(editor))}
          title="Link"
          aria-label="Link"
        >
          <IconChainLink1 size={16} />
        </button>
        <span className="divider" aria-hidden />
        <button
          type="button"
          className="selection-toolbar-ai"
          data-active={menuOpen || undefined}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setMenuOpen((open) => !open)}
          title="Rewrite"
          aria-label="Rewrite"
          aria-expanded={menuOpen}
        >
          <IconSparkle size={16} />
        </button>
      </div>
      {/* A sibling, not a child: the docked toolbar scrolls sideways, and a
          menu inside a scroll container is a menu with its corner cut off. */}
      {menuOpen ? (
        <div
          ref={menu.ref}
          className={docked ? "rewrite-menu rewrite-menu-docked" : "rewrite-menu"}
          role="menu"
          aria-label="Rewrite"
          style={docked ? { bottom: keyboardInset + DOCKED_BAR_HEIGHT } : menu.style}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
        >
          {REWRITES.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              role="menuitem"
              onPointerDown={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseRewrite(entry)}
            >
              {entry.label}
              {entry.needsInput ? <span aria-hidden>…</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

function ToolbarGroup({
  actions,
  editor,
  onRun,
  leadingDivider,
}: {
  actions: ToolbarAction[];
  editor: Editor;
  onRun: (action: ToolbarAction) => void;
  leadingDivider: boolean;
}) {
  return (
    <>
      {leadingDivider ? <span className="divider" aria-hidden /> : null}
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          data-active={action.isActive(editor) || undefined}
          // Both, and on purpose: preventing the mouse event is what keeps a
          // desktop click from blurring the editor, and preventing the pointer
          // event is what keeps a tap from doing the same on iOS, where the
          // focus move happens before any mouse event is synthesised.
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onRun(action)}
          title={action.label}
          aria-label={action.label}
        >
          <action.Icon size={16} />
        </button>
      ))}
    </>
  );
}

function currentHref(editor: Editor): string {
  const href = editor.getAttributes("link").href;
  return typeof href === "string" ? href : "";
}

/**
 * What a person pastes is `example.com` more often than `https://example.com`.
 * A bare host is given https; anything already carrying a scheme the schema
 * allows is left alone, and anything else is refused rather than written as a
 * link the app would not open.
 */
function normalizeHref(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^(https?:\/\/|mailto:)/i.test(value)) return value;
  if (/^[^\s:]+@[^\s:]+\.[^\s:]+$/.test(value)) return `mailto:${value}`;
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  return `https://${value}`;
}
