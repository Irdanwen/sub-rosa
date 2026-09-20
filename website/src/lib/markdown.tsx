import type { ReactNode } from "react";

/**
 * A reader for note bodies, on the website.
 *
 * Deliberately not the app's renderer. `src/lib/simple-markdown.tsx` is built
 * for chat inside a webview: it routes every tap through a Rust open command
 * because neither webview honors `target="_blank"`, it renders `subrosa:*`
 * chat blocks, and it imports the app's icon set. None of that exists here,
 * and sharing one component across the two would be exactly the single
 * semantic layer [ADR 0052](../../../docs/adr/0052-the-surfaces-share-primitives-not-a-stylesheet.md)
 * refuses. The surfaces share the primitives underneath, not the component.
 *
 * What it will render is the subset `note-markdown.ts` can write, and nothing
 * else. No raw HTML reaches the DOM: every node here is a React element built
 * from parsed text, so a note body cannot carry markup into this page.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="reader">{blocks(text)}</div>;
}

/** Only ever an absolute web link, and only ever one this page will not be
 * navigated away by accident. Anything else stays literal text: a reader who
 * sees the raw target can judge it, where a link dressed up as safe cannot be
 * judged at all. */
function webLink(raw: string): string | null {
  if (raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let index = 0;
  let key = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().startsWith("```")) {
      const language = line.trim().slice(3).trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      out.push(
        <pre key={key++} data-language={language || undefined}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const Tag = `h${Math.min(heading[1].length + 1, 6)}` as "h2";
      out.push(<Tag key={key++}>{inline(heading[2])}</Tag>);
      index += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key++} />);
      index += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      out.push(<blockquote key={key++}>{blocks(body.join("\n"))}</blockquote>);
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    for (const [pattern, Tag] of [
      [bullet, "ul"],
      [numbered, "ol"],
    ] as const) {
      if (!pattern.test(line)) continue;
      const items: ReactNode[] = [];
      while (index < lines.length && pattern.test(lines[index])) {
        items.push(<li key={items.length}>{inline(lines[index].replace(pattern, ""))}</li>);
        index += 1;
      }
      out.push(<Tag key={key++}>{items}</Tag>);
    }
    if (bullet.test(line) || numbered.test(line)) continue;
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().startsWith("```") &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index]) &&
      !bullet.test(lines[index]) &&
      !numbered.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    out.push(<p key={key++}>{inline(paragraph.join("\n"))}</p>);
  }
  return out;
}

function inline(text: string): ReactNode[] {
  const pattern = /`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*\*[^*]+\*\*|_[^_]+_|\*[^*]+\*/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let match = pattern.exec(text);
  while (match) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const target = link ? webLink(link[2]) : null;
      nodes.push(
        link && target ? (
          <a key={key++} href={target} target="_blank" rel="noreferrer noopener">
            {link[1]}
          </a>
        ) : (
          token
        ),
      );
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
