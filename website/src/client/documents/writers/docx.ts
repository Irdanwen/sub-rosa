/**
 * A Markdown document as a Word file: a port of `src-tauri/src/docx.rs` and
 * `deliverables/docx_content.rs` (ADR-0089, ADR-0090), held to them part by
 * part by `documents-fixtures.json`. Headings use Word's own styles, lists a
 * numbering part (each numbered list restarts at 1), links are hyperlink
 * relationships, tables are tables, and every run is escaped.
 */
import { coreXml, DOCUMENTS, DocumentInvalid, type Part } from "./exported";
import {
  chars,
  isAlphanumeric,
  isObject,
  isWhitespace,
  type Json,
  jsonCompact,
  jsonNumber,
  lines,
  take,
  trim,
  trimEnd,
  trimStart,
  words,
  xmlText,
  asU64,
} from "./text";

export type Inline =
  | { kind: "text"; text: string; bold: boolean; italic: boolean; code: boolean }
  | { kind: "link"; text: string; url: string };

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph" | "bullet" | "quote" | "code"; text: string }
  | { kind: "numbered"; list: number; text: string }
  | { kind: "table"; rows: string[][] };

function heading(line: string): { level: number; text: string } | null {
  let hashes = 0;
  while (line[hashes] === "#") hashes++;
  if (hashes === 0 || hashes > 6) return null;
  const rest = line.slice(hashes);
  if (!rest.startsWith(" ")) return null;
  return { level: Math.min(hashes, 3), text: trim(rest.slice(1)) };
}

function numberedItem(line: string): string | null {
  let digits = 0;
  while (digits < line.length && line[digits] >= "0" && line[digits] <= "9") digits++;
  if (digits === 0 || digits > 4) return null;
  const rest = line.slice(digits);
  if (rest.startsWith(". ") || rest.startsWith(") ")) return trim(rest.slice(2));
  return null;
}

/** A table row's cells; `\|` is a pipe inside a cell. */
export function tableCells(line: string): string[] {
  let inner = trim(line).replace(/^\|+/, "");
  if (inner.endsWith("|") && !inner.endsWith("\\|")) inner = inner.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const c of inner) {
    if (c === "|" && !escaped) {
      cells.push(trim(current));
      current = "";
    } else current += c;
    escaped = c === "\\" && !escaped;
  }
  cells.push(trim(current));
  return cells;
}

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let lists = 0;
  let inNumbered = false;
  const all = lines(markdown);
  const flush = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  let index = 0;
  while (index < all.length) {
    const line = trimEnd(all[index]);
    index++;
    const trimmed = trimStart(line);
    if (trimmed.startsWith("```")) {
      flush();
      inNumbered = false;
      while (index < all.length) {
        const code = all[index];
        index++;
        if (trimStart(code).startsWith("```")) break;
        blocks.push({ kind: "code", text: code });
      }
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }
    const head = heading(trimmed);
    if (head) {
      flush();
      inNumbered = false;
      blocks.push({ kind: "heading", ...head });
      continue;
    }
    if (trimmed === "---" || trimmed === "***" || trimmed === "___") {
      flush();
      inNumbered = false;
      continue;
    }
    if (trimmed.startsWith("|")) {
      flush();
      inNumbered = false;
      const rows = [tableCells(trimmed)];
      while (index < all.length) {
        const next = trim(all[index]);
        if (!next.startsWith("|")) break;
        const cells = tableCells(next);
        const separator = cells.every((cell) => cell !== "" && /^[-:]+$/.test(cell));
        if (!separator) rows.push(cells);
        index++;
      }
      blocks.push({ kind: "table", rows });
      continue;
    }
    const bullet = ["- ", "* ", "+ "].find((prefix) => trimmed.startsWith(prefix));
    if (bullet) {
      flush();
      inNumbered = false;
      blocks.push({ kind: "bullet", text: trim(trimmed.slice(2)) });
      continue;
    }
    const item = numberedItem(trimmed);
    if (item !== null) {
      flush();
      if (!inNumbered) {
        lists++;
        inNumbered = true;
      }
      blocks.push({ kind: "numbered", list: lists, text: item });
      continue;
    }
    if (trimmed.startsWith(">")) {
      flush();
      inNumbered = false;
      blocks.push({ kind: "quote", text: trim(trimmed.slice(1)) });
      continue;
    }
    inNumbered = false;
    paragraph.push(trimmed);
  }
  flush();
  return blocks;
}

function linkAt(text: string[]): { label: string; url: string; consumed: number } | null {
  const close = text.indexOf("]");
  if (close < 0 || text[close + 1] !== "(") return null;
  const after = text.slice(close + 2).indexOf(")");
  if (after < 0) return null;
  const end = after + close + 2;
  const label = text.slice(1, close).join("");
  const url = trim(text.slice(close + 2, end).join(""));
  const lower = url.toLowerCase();
  if (!(lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("mailto:")))
    return null;
  return { label, url, consumed: end + 1 };
}

/** The marks of a line: `**bold**`, `*italic*` or `_italic_`, `` `code` `` and
 * `[text](url)`; a backslash keeps the next character literal. */
export function parseInline(line: string): Inline[] {
  const cs = chars(line);
  const out: Inline[] = [];
  let current = "";
  let bold = false;
  let italic = false;
  const push = () => {
    if (current) out.push({ kind: "text", text: current, bold, italic, code: false });
    current = "";
  };
  let i = 0;
  while (i < cs.length) {
    const c = cs[i];
    if (c === "\\" && i + 1 < cs.length) {
      current += cs[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const end = cs.slice(i + 1).indexOf("`");
      if (end >= 0) {
        push();
        out.push({
          kind: "text",
          text: cs.slice(i + 1, i + 1 + end).join(""),
          bold,
          italic,
          code: true,
        });
        i += end + 2;
        continue;
      }
    }
    if (c === "[") {
      const link = linkAt(cs.slice(i));
      if (link) {
        push();
        out.push({ kind: "link", text: link.label, url: link.url });
        i += link.consumed;
        continue;
      }
    }
    if (c === "*" && cs[i + 1] === "*") {
      push();
      bold = !bold;
      i += 2;
      continue;
    }
    if (c === "*" || c === "_") {
      const prev = i > 0 ? cs[i - 1] : undefined;
      const next = cs[i + 1];
      const opens =
        !italic &&
        next !== undefined &&
        !isWhitespace(next) &&
        (c === "*" || prev === undefined || !isAlphanumeric(prev));
      const closes =
        italic &&
        prev !== undefined &&
        !isWhitespace(prev) &&
        (c === "*" || next === undefined || !isAlphanumeric(next));
      if (opens || closes) {
        push();
        italic = !italic;
        i++;
        continue;
      }
    }
    current += c;
    i++;
  }
  push();
  return out;
}

/** A line's text without its marks. */
export const plain = (text: string) =>
  parseInline(text)
    .map((inline) => inline.text)
    .join("");

function run(text: string, bold: boolean, italic: boolean, code: boolean, link: boolean): string {
  let properties = "";
  if (link) properties += '<w:rStyle w:val="Hyperlink"/>';
  if (code) properties += '<w:rStyle w:val="CodeChar"/>';
  if (bold) properties += "<w:b/>";
  if (italic) properties += "<w:i/>";
  const wrapped = properties ? `<w:rPr>${properties}</w:rPr>` : "";
  return `<w:r>${wrapped}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`;
}

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

class Writer {
  body = "";
  links: string[] = [];
  numberedLists = 0;

  runs(text: string): string {
    let out = "";
    for (const inline of parseInline(text)) {
      if (inline.kind === "text")
        out += run(inline.text, inline.bold, inline.italic, inline.code, false);
      else {
        this.links.push(inline.url);
        out += `<w:hyperlink r:id="rLink${this.links.length}" w:history="1">${run(inline.text, false, false, false, true)}</w:hyperlink>`;
      }
    }
    return out;
  }

  paragraph(style: string | null, numbering: number | null, text: string) {
    this.pushParagraph(style, numbering, this.runs(text));
  }

  pushParagraph(style: string | null, numbering: number | null, runs: string) {
    let properties = "";
    if (style) properties += `<w:pStyle w:val="${style}"/>`;
    if (numbering !== null)
      properties += `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numbering}"/></w:numPr>`;
    this.body += properties
      ? `<w:p><w:pPr>${properties}</w:pPr>${runs}</w:p>`
      : `<w:p>${runs}</w:p>`;
  }

  table(rows: string[][]) {
    const columns = Math.max(0, ...rows.map((row) => row.length));
    if (columns === 0) return;
    let xml =
      '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>';
    xml += "<w:gridCol/>".repeat(columns);
    xml += "</w:tblGrid>";
    rows.forEach((row, index) => {
      xml += "<w:tr>";
      for (let column = 0; column < columns; column++) {
        const text = row[column] ?? "";
        const runs = index === 0 ? run(plain(text), true, false, false, false) : this.runs(text);
        xml += `<w:tc><w:p>${runs}</w:p></w:tc>`;
      }
      xml += "</w:tr>";
    });
    xml += "</w:tbl>";
    this.body += xml;
    this.body += "<w:p/>";
  }
}

function documentXml(title: string, markdown: string) {
  const writer = new Writer();
  const blocks = parseBlocks(markdown);
  const first = blocks[0];
  const opensWithTitle =
    first?.kind === "heading" && first.level === 1 && trim(plain(first.text)) === trim(title);
  if (!opensWithTitle && trim(title)) writer.paragraph("Title", null, trim(title));
  blocks.forEach((block, index) => {
    switch (block.kind) {
      case "heading":
        if (block.level === 1 && index === 0 && opensWithTitle)
          writer.paragraph("Title", null, block.text);
        else writer.paragraph(`Heading${block.level}`, null, block.text);
        break;
      case "paragraph":
        writer.paragraph(null, null, block.text);
        break;
      case "bullet":
        writer.paragraph("ListParagraph", 1, block.text);
        break;
      case "numbered":
        writer.numberedLists = Math.max(writer.numberedLists, block.list);
        writer.paragraph("ListParagraph", block.list + 1, block.text);
        break;
      case "quote":
        writer.paragraph("Quote", null, block.text);
        break;
      case "code":
        writer.pushParagraph("Code", null, run(block.text, false, false, false, false));
        break;
      case "table":
        writer.table(block.rows);
        break;
    }
  });
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${writer.body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return { xml, links: writer.links, numberedLists: writer.numberedLists };
}

function numberingXml(numberedLists: number): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;
  for (let list = 1; list <= numberedLists; list++)
    xml += `<w:num w:numId="${list + 1}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`;
  return `${xml}</w:numbering>`;
}

function documentRels(links: string[]): string {
  let xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>';
  links.forEach((url, index) => {
    xml += `<Relationship Id="rLink${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlText(url)}" TargetMode="External"/>`;
  });
  return `${xml}</Relationships>`;
}

/** `markdown_to_docx`, as the package's parts. */
export function markdownToDocx(title: string, markdown: string, now?: Date): Part[] {
  const { xml, links, numberedLists } = documentXml(title, markdown);
  const t = DOCUMENTS.templates.docx;
  return [
    { name: "[Content_Types].xml", text: t.contentTypes },
    { name: "_rels/.rels", text: t.rootRels },
    { name: "docProps/core.xml", text: coreXml(title, now) },
    { name: "word/document.xml", text: xml },
    { name: "word/styles.xml", text: t.styles },
    { name: "word/numbering.xml", text: numberingXml(numberedLists) },
    { name: "word/_rels/document.xml.rels", text: documentRels(links) },
  ];
}

// ── What the tool's `content` is (docx_content.rs) ──────────────────────────

const MAX_SECTIONS = 200;
const MAX_ROWS = 500;
const MAX_CHARS = 400_000;

function cellText(value: Json): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return jsonNumber(value);
  if (typeof value === "boolean") return String(value);
  if (value === null) return "";
  return undefined;
}

function strings(value: Json | undefined): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value.map(cellText).filter((item): item is string => item !== undefined);
  return [];
}

const oneLine = (text: string) => words(text).join(" ");

function pushBlock(out: string[], block: string) {
  if (block) out.push(block);
}

/** `map.get(a).or_else(|| map.get(b))`: the first key that is present. */
function either(map: Record<string, Json>, a: string, b: string): Json | undefined {
  return a in map ? map[a] : map[b];
}

function tableMarkdown(table: Json): string {
  let header: Json | undefined;
  let rows: Json | undefined;
  if (isObject(table)) {
    header = either(table, "header", "columns");
    rows = table.rows;
  } else if (Array.isArray(table)) rows = table;
  const rowCells = (row: Json): string[] =>
    Array.isArray(row)
      ? row.map((cell) => oneLine(cellText(cell) ?? jsonCompact(cell)).replaceAll("|", "\\|"))
      : [oneLine(cellText(row) ?? "").replaceAll("|", "\\|")];
  const all: string[][] = [];
  if (header !== undefined) all.push(rowCells(header));
  if (Array.isArray(rows)) all.push(...rows.slice(0, MAX_ROWS).map(rowCells));
  if (!all.length) return "";
  const columns = Math.max(1, ...all.map((cells) => cells.length));
  const line = (cells: string[]) => {
    const padded = [...cells];
    while (padded.length < columns) padded.push("");
    return `| ${padded.slice(0, columns).join(" | ")} |`;
  };
  return [line(all[0]), `|${"---|".repeat(columns)}`, ...all.slice(1).map(line)].join("\n");
}

function sectionsMarkdown(sections: Json[]): string {
  const out: string[] = [];
  for (const section of sections.slice(0, MAX_SECTIONS)) {
    if (!isObject(section)) {
      if (typeof section === "string") pushBlock(out, trim(section));
      continue;
    }
    const head = either(section, "heading", "title");
    if (typeof head === "string") {
      const level = Math.min(3, Math.max(1, asU64(section.level) ?? 2));
      pushBlock(out, `${"#".repeat(level)} ${oneLine(head)}`);
    }
    for (const paragraph of strings(either(section, "paragraphs", "text")))
      pushBlock(out, trim(paragraph));
    pushBlock(
      out,
      strings(section.bullets)
        .map((item) => `- ${oneLine(item)}`)
        .join("\n"),
    );
    pushBlock(
      out,
      strings(section.numbered)
        .map((item, index) => `${index + 1}. ${oneLine(item)}`)
        .join("\n"),
    );
    if ("table" in section) pushBlock(out, tableMarkdown(section.table));
    if (typeof section.quote === "string")
      pushBlock(
        out,
        lines(section.quote)
          .map((line) => `> ${line}`)
          .join("\n"),
      );
  }
  return out.join("\n\n");
}

/** The Markdown a request's `content` stands for. */
export function contentMarkdown(content: Json): string {
  let text = "";
  if (typeof content === "string") text = content;
  else if (isObject(content)) {
    if (typeof content.markdown === "string") text = content.markdown;
    else if (Array.isArray(content.sections)) text = sectionsMarkdown(content.sections);
  } else if (Array.isArray(content)) text = sectionsMarkdown(content);
  if (!trim(text))
    throw new DocumentInvalid(
      "A document needs content: Markdown text, or content.sections with headings, paragraphs, lists and tables.",
    );
  return take(text, MAX_CHARS);
}
