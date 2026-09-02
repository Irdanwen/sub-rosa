import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconClipboard } from "central-icons/IconClipboard";
import { type ReactNode, useState } from "react";
import { ChatBlockSkeleton, ChatBlockView } from "../components/chat-blocks/ChatBlockView";
import { resolveChatBlockFence } from "./chat-blocks";
import { safeExternalHref } from "./external-link";
import { openExternalUrl } from "./tauri";

/**
 * Small markdown renderer for mobile chat bubbles: bold, italic, inline code,
 * links, headings, bullet/numbered lists, pipe tables, and fenced code blocks
 * (with a language label, a copy button, and lightweight syntax highlighting).
 * The desktop agent has a full renderer coupled to Hermes event shapes
 * (AgentWorkspace); chat answers only need this well-understood subset.
 */
export function SimpleMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  /** True while the reply is still arriving (live stream or typewriter
   * reveal): an unterminated `subrosa:*` fence then renders as a card
   * skeleton instead of flashing half-written JSON. */
  streaming?: boolean;
}) {
  return <div className="simple-markdown">{renderBlocks(text, streaming)}</div>;
}

function renderBlocks(text: string, streaming = false): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      const terminated = index < lines.length;
      index += 1;
      const body = code.join("\n");
      // Chat blocks (ADR-0024): a `subrosa:*` fence renders as a card when
      // its payload validates, as a skeleton while it is still streaming in,
      // and degrades to the plain code block below otherwise.
      const chatBlock = resolveChatBlockFence(lang, body, terminated, streaming);
      if (chatBlock?.type === "card") {
        blocks.push(<ChatBlockView key={key++} block={chatBlock.block} />);
        continue;
      }
      if (chatBlock?.type === "skeleton") {
        blocks.push(<ChatBlockSkeleton key={key++} />);
        continue;
      }
      blocks.push(<CodeBlock key={key++} code={body} lang={lang} />);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <strong key={key++} className="simple-markdown-heading" data-level={heading[1].length}>
          {renderInline(heading[2])}
        </strong>,
      );
      index += 1;
      continue;
    }

    // Pipe table: a row with `|` immediately followed by a `---|---` separator.
    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const header = splitTableRow(line);
      const aligns = tableAligns(lines[index + 1], header.length);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push(
        <div key={key++} className="simple-markdown-table-wrap">
          <table className="simple-markdown-table">
            <thead>
              <tr>
                {header.map((cell, i) => (
                  <th key={i} style={{ textAlign: aligns[i] }}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {header.map((_, c) => (
                    <td key={c} style={{ textAlign: aligns[c] }}>
                      {renderInline(row[c] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const items: ReactNode[] = [];
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      while (index < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[index])) {
        items.push(
          <li key={key++}>{renderInline(lines[index].replace(/^\s*([-*]|\d+[.)])\s+/, ""))}</li>,
        );
        index += 1;
      }
      blocks.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().startsWith("```") &&
      !/^(#{1,4})\s+/.test(lines[index]) &&
      !/^\s*([-*]|\d+[.)])\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={key++}>{renderInline(paragraph.join(" "))}</p>);
  }

  return blocks;
}

// --- tables ------------------------------------------------------------------

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function tableAligns(separator: string, count: number): Array<"left" | "center" | "right"> {
  const cells = splitTableRow(separator);
  return Array.from({ length: count }, (_, i) => {
    const cell = cells[i] ?? "";
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

// --- code block --------------------------------------------------------------

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Copy is a convenience; ignore transient clipboard failures.
    }
  };
  return (
    <div className="simple-markdown-code">
      <div className="simple-markdown-code-head">
        <span className="simple-markdown-code-lang">{lang || "code"}</span>
        <button
          type="button"
          className="simple-markdown-code-copy"
          onClick={copy}
          aria-label="Copy code"
        >
          {copied ? <IconCheckmark1Small size={13} /> : <IconClipboard size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{highlight(code, lang)}</code>
      </pre>
    </div>
  );
}

/** Conservative, language-agnostic highlighter: strings and comments are
 * consumed first (so keywords inside them are never recoloured), then numbers
 * and a shared keyword set. Good enough for chat snippets; never throws. */
const HIGHLIGHT = new RegExp(
  [
    "(/\\*[\\s\\S]*?\\*/|//[^\\n]*|#[^\\n]*)", // 1: comments
    "(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|`(?:\\\\.|[^`\\\\])*`)", // 2: strings
    "(\\b\\d[\\d_.]*\\b)", // 3: numbers
    `(\\b(?:${KEYWORDS()})\\b)`, // 4: keywords
  ].join("|"),
  "g",
);

function KEYWORDS(): string {
  return [
    "const",
    "let",
    "var",
    "function",
    "func",
    "fn",
    "def",
    "class",
    "struct",
    "enum",
    "impl",
    "trait",
    "interface",
    "type",
    "return",
    "if",
    "else",
    "elif",
    "for",
    "while",
    "loop",
    "match",
    "switch",
    "case",
    "break",
    "continue",
    "import",
    "from",
    "export",
    "package",
    "use",
    "pub",
    "async",
    "await",
    "new",
    "try",
    "catch",
    "except",
    "finally",
    "throw",
    "raise",
    "yield",
    "with",
    "as",
    "in",
    "of",
    "do",
    "then",
    "end",
    "public",
    "private",
    "protected",
    "static",
    "void",
    "true",
    "false",
    "null",
    "nil",
    "None",
    "True",
    "False",
    "undefined",
    "self",
    "this",
    "lambda",
    "print",
    "and",
    "or",
    "not",
    "is",
  ].join("|");
}

function highlight(code: string, lang: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  HIGHLIGHT.lastIndex = 0;
  let match = HIGHLIGHT.exec(code);
  while (match) {
    if (match.index > last) nodes.push(code.slice(last, match.index));
    const [token, comment, str, num, kw] = match;
    const cls = comment
      ? "tok-comment"
      : str
        ? "tok-string"
        : num
          ? "tok-number"
          : kw
            ? "tok-keyword"
            : undefined;
    nodes.push(
      cls ? (
        <span key={key++} className={cls}>
          {token}
        </span>
      ) : (
        token
      ),
    );
    last = match.index + token.length;
    match = HIGHLIGHT.exec(code);
  }
  if (last < code.length) nodes.push(code.slice(last));
  // Plain-text languages (or none declared) read fine without spans, but the
  // pass above is harmless; keep `lang` reserved for future per-language rules.
  void lang;
  return nodes;
}

// --- inline ------------------------------------------------------------------

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters: code first (its content is inert), then links, bold, italic.
  const pattern = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)/g;
  let last = 0;
  let key = 0;
  let match = pattern.exec(text);
  while (match) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      // The webview drops target="_blank", so a tap routes through the Rust
      // open command (Safari on iOS, browser on desktop). An href the app
      // cannot open would not open a browser either — it would navigate the
      // app's own webview away — so it stays literal text instead of becoming
      // a link. `safeExternalUrl` is the same gate the desktop renderer uses.
      const target = link ? safeExternalHref(link[2]) : null;
      if (link && target) {
        nodes.push(
          <a
            key={key++}
            href={target}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              event.preventDefault();
              void openExternalUrl(target);
            }}
          >
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
    match = pattern.exec(text);
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
