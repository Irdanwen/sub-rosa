/**
 * Markdown <-> ProseMirror for the note body.
 *
 * A note is stored as markdown and edited as a ProseMirror document, so every
 * blur crosses this seam. What came before it converted markdown to an HTML
 * *string* and converted back by walking the rendered DOM, and it understood
 * five things: `#` headings (all flattened to level 1), flat bullets,
 * paragraphs, `**bold**` and `*italic*`. Everything else the schema can hold —
 * every list nesting, every ordered list, every quote, code block, rule, link
 * and strike — was silently deleted the moment the caret left the editor. The
 * bug was invisible only because the toolbar could not produce any of it.
 *
 * Three things make this version different, and they are the whole point:
 *
 * - **It serializes the document, not the DOM.** `htmlToMarkdown` walked
 *   `editor.view.dom` and collected every `<li>` with one flat
 *   `querySelectorAll`, which is why nesting could never survive. A document
 *   is a tree; walking it is recursive by construction, and decorations,
 *   placeholders and widgets are not in it at all.
 * - **It escapes.** A paragraph reading `- not a list` used to serialize
 *   verbatim and come back as a bullet. Text is escaped on the way out and
 *   unescaped on the way in, so the round trip is a fixed point.
 * - **It tracks open marks across text nodes** rather than wrapping each node
 *   independently, so `bold` followed by `bold+italic` cannot emit a run of
 *   asterisks that parses back as something else.
 *
 * ## The vocabulary, and why it stops where it does
 *
 * Headings 1 to 3, paragraphs, nested bullet, ordered and **task** lists,
 * blockquotes, fenced code, horizontal rules, hard breaks; `bold`, `italic`,
 * `strike`, `code`, `link` and `highlight`. A task list is written the way
 * every other tool writes it (`- [ ]` / `- [x]`) and a highlight as `==text==`
 * — neither is CommonMark, both are what a person pasting a note elsewhere
 * expects. **`underline` is deliberately absent** — markdown has no underline,
 * so a mark the editor accepts and the file cannot hold is the exact bug this
 * module exists to remove. `NotePreview` disables it in StarterKit for the
 * same reason; highlight (which does have a representation) takes its place.
 *
 * Anything else in the markdown — a table, an HTML block, a footnote — is kept
 * as literal paragraph text rather than parsed or dropped. It is not rendered
 * as a table, but the user's characters survive, which is the property that
 * matters.
 *
 * ## Line breaks
 *
 * A single newline inside a block is a `hardBreak`, and a `hardBreak`
 * serializes back to a single newline. CommonMark would call that a soft break
 * and render it as a space; we render it as a break, so treating it as one
 * keeps what the user sees and what the file says in agreement, with no
 * trailing-backslash noise in a file the agent also reads.
 *
 * ## What markdown cannot hold, and what happens to it
 *
 * Four editor states have no spelling in a file, so they are normalized on the
 * way out rather than written and lost on the way back in. Each one drops
 * nothing a reader could see:
 *
 * - **A hard break at the edge of a block** — leading or trailing — is the
 *   block's own boundary, not a line break, and a blank first or last line
 *   ends the block instead of living inside it. Dropped.
 * - **Consecutive hard breaks** are a blank line, which likewise ends a block.
 *   Collapsed to one.
 * - **A hard break in a heading** becomes a space: a heading is one line.
 * - **Trailing whitespace on a line** is invisible, means "hard break" to
 *   CommonMark, and a line of nothing but spaces would read back as a blank
 *   line and split the block. Trimmed, except inside a code block, where
 *   spacing is content.
 * - **A block with nothing left in it** is dropped: a blank line is how
 *   markdown separates blocks, so it cannot also be one.
 * - **Two adjacent lists of the same kind** read back as one. Nothing between
 *   them survives to say otherwise, in this format or in CommonMark, and a
 *   renumbered `1.` after a `3.` does not split a list.
 *
 * `src/test/note-markdown.test.ts` reimplements these four rules independently
 * and asserts that they are the *only* difference a round trip can make.
 */

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { JSONContent } from "@tiptap/react";

/** Headings deeper than this collapse onto it: the note styles define three. */
export const MAX_HEADING_LEVEL = 3;

/* ------------------------------------------------------------------ *
 * Escaping
 * ------------------------------------------------------------------ */

/**
 * Characters that always carry meaning inline, wherever they appear.
 *
 * Deliberately short. `~`, `[` and `]` are *conditionally* special and are
 * handled below instead: escaping them unconditionally would put a backslash
 * in front of every `[t:12]` chapter marker, every `[1]` reference and every
 * stray tilde in every note, to defend against a construction that needs a
 * closing delimiter to exist at all.
 */
const INLINE_SPECIALS = /[\\`*_]/;

/** A run of one or more backticks, used to size a code span's fence. */
const BACKTICK_RUN = /`+/g;

/**
 * Escape text so it survives a parse unchanged.
 *
 * Three tiers, because a backslash the reader can see is a cost:
 *
 * - **Always**: `\`, a backtick, `*`, and `_` outside a word. Each of these
 *   opens something on its own. Intra-word underscores are left alone —
 *   escaping `snake_case` would also mean a search of the note for
 *   `snake_case` no longer finds it — and the parser will not open emphasis
 *   on a `_` that follows a word character.
 * - **Conditionally**: `~` and `=` only when doubled (a lone tilde is a tilde
 *   and a lone equals sign is an equals sign), and `]` only where it would
 *   close a link, which is before a `(` or anywhere inside a link's own text.
 *   `[` is never escaped: without a closing `](` it means nothing, so
 *   `[t:12]` and `[1]` stay readable.
 * - **In the first column**: the block markers, which is why a paragraph
 *   reading `- not a list` comes back as a paragraph.
 */
function escapeMarkdownText(text: string, atLineStart: boolean, insideLink: boolean): string {
  let escaped = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (INLINE_SPECIALS.test(char)) {
      const intraWord =
        char === "_" &&
        index > 0 &&
        index + 1 < text.length &&
        /\w/.test(text[index - 1]) &&
        /\w/.test(text[index + 1]);
      escaped += intraWord ? char : `\\${char}`;
      continue;
    }
    if ((char === "~" || char === "=") && text[index + 1] === char) {
      escaped += `\\${char}`;
      continue;
    }
    if (char === "]" && (insideLink || text[index + 1] === "(")) {
      escaped += "\\]";
      continue;
    }
    escaped += char;
  }
  if (atLineStart) {
    escaped = escaped.replace(/^([#>+-])/, "\\$1").replace(/^(\d+)([.)])/, "$1\\$2");
  }
  return escaped;
}

/* ------------------------------------------------------------------ *
 * Serialize: ProseMirror -> markdown
 * ------------------------------------------------------------------ */

/** Marks in the order they nest, outermost first. `code` is not here: it has
 * no plain delimiter pair (the fence is sized from the content) so it is
 * emitted whole, innermost, by {@link renderInline}. */
const MARK_ORDER = ["link", "highlight", "bold", "italic", "strike"] as const;

type OrderedMark = { type: string; attrs?: Record<string, unknown> };

/** An open mark, plus the delimiter character actually chosen for it, so the
 * closer cannot disagree with the opener. */
type ActiveMark = OrderedMark & { char: string };

function orderedMarks(
  marks: readonly { type: { name: string }; attrs: Record<string, unknown> }[],
) {
  const ordered: OrderedMark[] = [];
  for (const name of MARK_ORDER) {
    const found = marks.find((mark) => mark.type.name === name);
    if (found) ordered.push({ type: name, attrs: found.attrs });
  }
  return ordered;
}

function sameMark(a: OrderedMark, b: OrderedMark) {
  if (a.type !== b.type) return false;
  if (a.type !== "link") return true;
  return a.attrs?.href === b.attrs?.href;
}

/** How wide the delimiter run for a mark is. `link` is bracketed, not run-based. */
function delimiterWidth(type: string) {
  return type === "italic" ? 1 : 2;
}

/** The delimiter character a mark writes with. Strike and highlight have one
 * spelling each, and neither shares an alphabet with anything else. */
function markChar(type: string) {
  if (type === "strike") return "~";
  if (type === "highlight") return "=";
  return EMPHASIS_CHAR;
}

/**
 * The delimiter character every emphasis mark writes with.
 *
 * Always an asterisk, and that is a decision rather than an oversight.
 * Markdown offers `_`/`__` as a second spelling, and reaching for it to keep a
 * closing run from touching an opening one looks necessary until you follow
 * the runs through: because no emphasis run is shared between two text nodes
 * (see {@link renderInline}), every run the serializer writes is closed by a
 * run of its own width, and a parser that consumes runs greedily from the left
 * splits a merged `*****` back into the `***` and the `**` that made it.
 * Underscore would buy nothing, cannot be used next to a word character
 * anyway, and would put `__bold__` in a file that a person and a model both
 * read.
 */
const EMPHASIS_CHAR = "*";

function openMark(mark: ActiveMark) {
  if (mark.type === "link") return "[";
  return mark.char.repeat(delimiterWidth(mark.type));
}

function closeMark(mark: ActiveMark) {
  if (mark.type !== "link") return mark.char.repeat(delimiterWidth(mark.type));
  const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
  return `](${encodeLinkTarget(href)})`;
}

/** Wrap a URL that would otherwise end the link destination early. */
function encodeLinkTarget(href: string) {
  if (!href) return "";
  return /[\s()<>]/.test(href) ? `<${href.replace(/([<>])/g, "\\$1")}>` : href;
}

/** A code span, fenced with one more backtick than its longest inner run, and
 * padded when the content would otherwise touch the fence. */
function renderCodeSpan(text: string) {
  let longest = 0;
  for (const run of text.match(BACKTICK_RUN) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") || text.trim() !== text ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Serialize a block node's inline content.
 *
 * `allowBreaks` is false for a block markdown writes on one line — a heading.
 * A hard break there becomes a space: the characters survive, which is the
 * promise, and a heading spanning two lines is not something the file can say.
 */
function renderInline(parent: ProseMirrorNode, allowBreaks = true): string {
  let out = "";
  let lineHasContent = false;
  const active: ActiveMark[] = [];

  function closeDownTo(depth: number) {
    for (let index = active.length - 1; index >= depth; index -= 1) {
      out += closeMark(active[index]);
    }
    active.length = depth;
  }

  // A break is only a line break when it has content on both sides: at either
  // edge of the block it is the block's own boundary, and markdown has no way
  // to say otherwise.
  const children: ProseMirrorNode[] = [];
  parent.forEach((child) => {
    children.push(child);
  });
  const isBreak = (node: ProseMirrorNode) => node.type.name === "hardBreak";
  const firstContent = children.findIndex((child) => !isBreak(child));
  const lastContent = children.reduce(
    (found, child, index) => (isBreak(child) ? found : index),
    -1,
  );

  children.forEach((child, index) => {
    if (isBreak(child)) {
      if (index < firstContent || index > lastContent) return;
      // Consecutive breaks are a blank line, which ends a block.
      if (isBreak(children[index - 1])) return;
      if (!allowBreaks) {
        // Close first: a space written while `bold` is still open lands
        // inside the delimiters and comes back as part of the bold text.
        closeDownTo(0);
        if (out && !out.endsWith(" ")) out += " ";
        lineHasContent = true;
        return;
      }
      closeDownTo(0);
      out += "\n";
      lineHasContent = false;
      return;
    }

    const text = child.isText ? (child.text ?? "") : (child.textContent ?? "");
    if (!text) return;

    const target = orderedMarks(child.marks);
    // Only the link is carried across a text-node boundary. Sharing an
    // emphasis run with the next node is what produces an asymmetric
    // sequence — `**` opened, `*` then `**` closed — and reading those back
    // takes the full CommonMark delimiter stack. Closing the group and
    // reopening it costs a few characters in a note nobody writes by hand,
    // and makes every run the serializer emits its own mirror.
    const common =
      active.length > 0 &&
      target.length > 0 &&
      active[0].type === "link" &&
      sameMark(active[0], target[0])
        ? 1
        : 0;
    closeDownTo(common);
    for (let index = common; index < target.length; index += 1) {
      const type = target[index].type;
      const opened: ActiveMark = { ...target[index], char: markChar(type) };
      out += openMark(opened);
      active.push(opened);
      lineHasContent = true;
    }

    if (child.marks.some((mark) => mark.type.name === "code")) {
      out += renderCodeSpan(text);
    } else {
      out += escapeMarkdownText(
        text,
        !lineHasContent,
        active.some((mark) => mark.type === "link"),
      );
    }
    lineHasContent = true;
  });

  closeDownTo(0);
  // Whitespace at the end of a line is invisible, means "hard break" in
  // CommonMark, and a line of only spaces would read back as a blank line.
  return out.replace(/[ \t]+(?=\n|$)/g, "");
}

/** Prefix every line of a rendered block, including the blank ones. */
function prefixLines(block: string, first: string, rest: string) {
  return block
    .split("\n")
    .map((line, index) => {
      const prefix = index === 0 ? first : rest;
      return line ? `${prefix}${line}` : prefix.trimEnd();
    })
    .join("\n");
}

const LIST_NODES = new Set(["bulletList", "orderedList", "taskList"]);

function isListNode(node: ProseMirrorNode) {
  return LIST_NODES.has(node.type.name);
}

/** Render each child of `parent` to its own markdown block. */
function renderBlocks(parent: ProseMirrorNode): string[] {
  const blocks: string[] = [];
  parent.forEach((child) => {
    blocks.push(renderBlock(child));
  });
  return blocks;
}

/** Join a list item's blocks: a nested list hugs the line above it, so a tight
 * list stays tight; anything else takes the usual blank line. */
function joinItemBlocks(item: ProseMirrorNode) {
  let out = "";
  item.forEach((child, _offset, index) => {
    if (index > 0) out += isListNode(child) ? "\n" : "\n\n";
    out += renderBlock(child);
  });
  return out;
}

function renderBlock(node: ProseMirrorNode): string {
  switch (node.type.name) {
    case "paragraph":
      return renderInline(node);

    case "heading": {
      const level = Math.min(Number(node.attrs.level) || 1, MAX_HEADING_LEVEL);
      const text = renderInline(node, false);
      return `${"#".repeat(level)} ${text}`.trimEnd();
    }

    case "horizontalRule":
      return "---";

    case "codeBlock": {
      const language = typeof node.attrs.language === "string" ? node.attrs.language : "";
      const body = node.textContent;
      let longest = 2;
      for (const run of body.match(/^`{3,}/gm) ?? []) longest = Math.max(longest, run.length);
      const fence = "`".repeat(longest + 1);
      return `${fence}${language}\n${body}\n${fence}`;
    }

    case "blockquote": {
      const inner = renderBlocks(node).join("\n\n");
      return prefixLines(inner, "> ", "> ");
    }

    case "bulletList": {
      const items: string[] = [];
      node.forEach((item) => {
        items.push(prefixLines(joinItemBlocks(item), "- ", "  "));
      });
      return items.join("\n");
    }

    case "taskList": {
      const items: string[] = [];
      node.forEach((item) => {
        const box = item.attrs.checked ? "- [x] " : "- [ ] ";
        // Continuations indent by the bullet, not by the box: see the note in
        // `matchListMarker`.
        items.push(prefixLines(joinItemBlocks(item), box, "  "));
      });
      return items.join("\n");
    }

    case "orderedList": {
      const start = Number(node.attrs.start) || 1;
      const items: string[] = [];
      node.forEach((item, _offset, index) => {
        const marker = `${start + index}. `;
        items.push(prefixLines(joinItemBlocks(item), marker, " ".repeat(marker.length)));
      });
      return items.join("\n");
    }

    default:
      // A node this module does not know how to write is still the user's
      // text: keep the characters rather than dropping the block.
      return node.isTextblock ? renderInline(node) : node.textContent;
  }
}

/** The note body as markdown. The only writer of a note's stored content. */
export function docToMarkdown(doc: ProseMirrorNode): string {
  return renderBlocks(doc).join("\n\n").trim();
}

/* ------------------------------------------------------------------ *
 * Parse: markdown -> ProseMirror
 * ------------------------------------------------------------------ */

const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))(\s+)(.*)$/;

type ListMarker = {
  indent: number;
  ordered: boolean;
  /** A bullet whose text opens with a checkbox. `null` for every other item. */
  checked: boolean | null;
  start: number;
  contentIndent: number;
  rest: string;
};

/** `- [ ] ` and `- [x] `, the spelling every other tool uses. */
const TASK_BOX = /^\[([ xX])\]\s+(.*)$/;

function matchListMarker(line: string): ListMarker | null {
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  const [, indentText, bullet, digits, , spacing, rest] = match;
  const indent = indentText.length;
  // Four spaces past the marker is a code block's indentation, not content.
  const spacingWidth = Math.min(spacing.length, 4);
  const markerWidth = (bullet ? 1 : digits.length + 1) + spacingWidth;

  const box = bullet ? TASK_BOX.exec(rest) : null;
  if (box) {
    // The checkbox is content, not part of the marker, so an item's
    // continuation is indented by the bullet alone. That is what GFM does, and
    // it is what a checklist pasted from anywhere else looks like: two spaces
    // under the dash, not six under the text.
    return {
      indent,
      ordered: false,
      checked: box[1] !== " ",
      start: 1,
      contentIndent: indent + markerWidth,
      rest: box[2],
    };
  }

  return {
    indent,
    ordered: !bullet,
    checked: null,
    start: bullet ? 1 : Number(digits),
    contentIndent: indent + markerWidth,
    rest,
  };
}

function leadingSpaces(line: string) {
  const match = /^\s*/.exec(line);
  return match ? match[0].length : 0;
}

/** True when this line opens a block and therefore ends a paragraph. */
function startsBlock(line: string) {
  if (!line.trim()) return true;
  return (
    HEADING.test(line) ||
    FENCE.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    matchListMarker(line) !== null
  );
}

function parseList(lines: string[], from: number): { node: JSONContent; next: number } {
  const first = matchListMarker(lines[from]);
  if (!first) throw new Error("parseList called off a list line");
  const items: JSONContent[] = [];
  let index = from;

  while (index < lines.length) {
    // Look past the blank lines a loose list puts between its items: stopping
    // at the first one would split one list into several, which is what the
    // note generator's own output looks like.
    let cursor = index;
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
    const marker = matchListMarker(lines[cursor] ?? "");
    if (
      !marker ||
      marker.indent !== first.indent ||
      marker.ordered !== first.ordered ||
      (marker.checked === null) !== (first.checked === null)
    ) {
      break;
    }
    index = cursor;

    const itemLines: string[] = [marker.rest];
    index += 1;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        // A blank line continues the item only when indented content follows.
        let ahead = index;
        while (ahead < lines.length && !lines[ahead].trim()) ahead += 1;
        if (ahead < lines.length && leadingSpaces(lines[ahead]) >= marker.contentIndent) {
          for (let blank = index; blank < ahead; blank += 1) itemLines.push("");
          index = ahead;
          continue;
        }
        break;
      }
      if (leadingSpaces(line) >= marker.contentIndent) {
        itemLines.push(line.slice(marker.contentIndent));
        index += 1;
        continue;
      }
      break;
    }

    let content = parseBlocks(itemLines);
    // Both `listItem` and a nested `taskItem` open on a paragraph: an item
    // that starts with a nested list still needs that slot filled.
    if (content.length === 0 || content[0].type !== "paragraph") {
      content = [{ type: "paragraph" }, ...content];
    }
    items.push(
      marker.checked === null
        ? { type: "listItem", content }
        : { type: "taskItem", attrs: { checked: marker.checked }, content },
    );
  }

  if (first.checked !== null) {
    return { node: { type: "taskList", content: items }, next: index };
  }
  const node: JSONContent = first.ordered
    ? { type: "orderedList", attrs: { start: first.start }, content: items }
    : { type: "bulletList", content: items };
  return { node, next: index };
}

function parseBlocks(lines: string[]): JSONContent[] {
  const blocks: JSONContent[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const language = fence[2].trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const closing = FENCE.exec(lines[index]);
        if (closing && closing[1][0] === marker && closing[1].length >= fence[1].length) {
          index += 1;
          break;
        }
        body.push(lines[index]);
        index += 1;
      }
      blocks.push({
        type: "codeBlock",
        attrs: { language: language || null },
        content: body.length ? [{ type: "text", text: body.join("\n") }] : undefined,
      });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "horizontalRule" });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, MAX_HEADING_LEVEL);
      blocks.push({
        type: "heading",
        attrs: { level },
        content: parseInline(heading[2].trim()),
      });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (index < lines.length) {
        const quoted = QUOTE.exec(lines[index]);
        if (!quoted) break;
        inner.push(quoted[1]);
        index += 1;
      }
      const content = parseBlocks(inner);
      blocks.push({
        type: "blockquote",
        content: content.length ? content : [{ type: "paragraph" }],
      });
      continue;
    }

    if (matchListMarker(line)) {
      const { node, next } = parseList(lines, index);
      blocks.push(node);
      index = next;
      continue;
    }

    // Paragraph: every following line until one that opens a block.
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && !startsBlock(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", content: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}

/** The note's markdown as a ProseMirror document. */
export function markdownToDoc(markdown: string): JSONContent {
  const content = parseBlocks((markdown ?? "").replace(/\r\n?/g, "\n").split("\n"));
  // `doc` is `block+`: an empty note still needs somewhere to type.
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

/* ------------------------------------------------------------------ *
 * Inline parsing
 * ------------------------------------------------------------------ */

/** What a backslash may legally hide. Mirrors what {@link escapeMarkdownText}
 * writes, plus the block markers it escapes in the first column. */
const ESCAPABLE = /[\\`*~=[\]_#>+\-.)]/;

type InlineMarkJson = { type: string; attrs?: Record<string, unknown> };

function textNode(text: string, marks: InlineMarkJson[]): JSONContent {
  if (!marks.length) return { type: "text", text };
  return { type: "text", text, marks: marks.map((mark) => ({ ...mark })) };
}

/** Advance past a code span or an escape, so a delimiter hidden inside one is
 * never mistaken for a closer. Returns the next index, or -1 to keep scanning
 * one character at a time. */
function skipOpaque(source: string, index: number): number {
  const char = source[index];
  if (char === "\\") return index + 2;
  if (char === "`") {
    const run = /^`+/.exec(source.slice(index))?.[0] ?? "`";
    const closing = source.indexOf(run, index + run.length);
    return closing === -1 ? source.length : closing + run.length;
  }
  return -1;
}

/** Position of the closing single-character delimiter, or -1. */
function findClosing(source: string, from: number, delimiter: string): number {
  let index = from;
  while (index < source.length) {
    const skipped = skipOpaque(source, index);
    if (skipped !== -1) {
      index = skipped;
      continue;
    }
    if (source.startsWith(delimiter, index)) return index;
    index += 1;
  }
  return -1;
}

/**
 * Position of a closing run of `char` at least `width` long, or -1.
 *
 * An underscore run additionally has to be a legal closer: CommonMark will not
 * close emphasis on an underscore followed by a word character, and neither
 * will we. That single rule is what lets `_` be used as a delimiter at all
 * around a word like `snake_case_word`, whose own underscores are left
 * unescaped so that searching the note for `snake_case_word` still finds it.
 */
function findClosingRun(source: string, from: number, char: string, width: number): number {
  let index = from;
  while (index < source.length) {
    const skipped = skipOpaque(source, index);
    if (skipped !== -1) {
      index = skipped;
      continue;
    }
    if (source[index] === char) {
      let end = index;
      while (end < source.length && source[end] === char) end += 1;
      const closes = char !== "_" || end >= source.length || !/\w/.test(source[end]);
      if (end - index >= width && closes) return index;
      index = end;
      continue;
    }
    index += 1;
  }
  return -1;
}

type EmphasisMatch = { content: string; end: number; marks: InlineMarkJson[] };

/**
 * Emphasis, matched by delimiter *run length* rather than by a fixed pair.
 *
 * Matching `**` and `*` as two separate rules is what makes `***both***` come
 * back as bold text starting with a stray asterisk, which the serializer emits
 * for any text carrying bold and italic at once. Reading the whole run and
 * looking for a closing run of the same width is the only version where a
 * document survives its own serialization.
 */
function matchEmphasis(source: string, index: number): EmphasisMatch | null {
  const char = source[index];
  if (char !== "*" && char !== "_" && char !== "~" && char !== "=") return null;
  // `snake_case` is a word, not emphasis.
  if (char === "_" && index > 0 && /\w/.test(source[index - 1])) return null;

  let runEnd = index;
  while (runEnd < source.length && source[runEnd] === char) runEnd += 1;
  const runLength = runEnd - index;

  const paired = char === "~" || char === "=";
  const width = paired ? 2 : Math.min(runLength, 3);
  // A lone `~` is a tilde and a lone `=` is an equals sign.
  if (paired && runLength < 2) return null;

  const contentFrom = index + width;
  const closing = findClosingRun(source, contentFrom, char, width);
  if (closing <= contentFrom) return null;

  const marks: InlineMarkJson[] =
    char === "~"
      ? [{ type: "strike" }]
      : char === "="
        ? [{ type: "highlight" }]
        : width === 1
          ? [{ type: "italic" }]
          : width === 2
            ? [{ type: "bold" }]
            : [{ type: "bold" }, { type: "italic" }];

  return { content: source.slice(contentFrom, closing), end: closing + width, marks };
}

function readLinkDestination(source: string, from: number): { href: string; end: number } | null {
  if (source[from] === "<") {
    const closing = source.indexOf(">", from + 1);
    if (closing === -1 || source[closing + 1] !== ")") return null;
    return { href: source.slice(from + 1, closing).replace(/\\([<>])/g, "$1"), end: closing + 2 };
  }
  let index = from;
  let depth = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (/\s/.test(char)) return null;
    if (char === "(") depth += 1;
    if (char === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
    index += 1;
  }
  if (index >= source.length || source[index] !== ")") return null;
  return { href: source.slice(from, index), end: index + 1 };
}

function parseInlineWithin(source: string, marks: InlineMarkJson[]): JSONContent[] {
  const out: JSONContent[] = [];
  let buffer = "";
  let index = 0;

  function flush() {
    if (!buffer) return;
    out.push(textNode(buffer, marks));
    buffer = "";
  }

  while (index < source.length) {
    const char = source[index];

    if (char === "\\" && index + 1 < source.length && ESCAPABLE.test(source[index + 1])) {
      buffer += source[index + 1];
      index += 2;
      continue;
    }

    if (char === "\n") {
      flush();
      out.push({ type: "hardBreak" });
      index += 1;
      continue;
    }

    if (char === "`") {
      const run = /^`+/.exec(source.slice(index))?.[0] ?? "`";
      const closing = source.indexOf(run, index + run.length);
      if (closing !== -1) {
        flush();
        let code = source.slice(index + run.length, closing);
        if (code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        out.push(textNode(code, [...marks, { type: "code" }]));
        index = closing + run.length;
        continue;
      }
    }

    if (char === "[") {
      const closingBracket = findClosing(source, index + 1, "]");
      if (closingBracket !== -1 && source[closingBracket + 1] === "(") {
        const destination = readLinkDestination(source, closingBracket + 2);
        if (destination) {
          flush();
          out.push(
            ...parseInlineWithin(source.slice(index + 1, closingBracket), [
              ...marks,
              { type: "link", attrs: { href: destination.href } },
            ]),
          );
          index = destination.end;
          continue;
        }
      }
    }

    if (char === "*" || char === "_" || char === "~" || char === "=") {
      const emphasis = matchEmphasis(source, index);
      if (emphasis) {
        flush();
        out.push(...parseInlineWithin(emphasis.content, [...marks, ...emphasis.marks]));
        index = emphasis.end;
        continue;
      }
      // No closing run: the whole run is literal. Consuming it in one step is
      // what keeps `**` from being re-tested and re-failing character by
      // character, and keeps the output a single text node.
      let runEnd = index;
      while (runEnd < source.length && source[runEnd] === char) runEnd += 1;
      buffer += source.slice(index, runEnd);
      index = runEnd;
      continue;
    }

    buffer += char;
    index += 1;
  }

  flush();
  return out;
}

function parseInline(source: string): JSONContent[] {
  return parseInlineWithin(source, []);
}
