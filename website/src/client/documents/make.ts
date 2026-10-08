/**
 * `make_document` in the browser (ADR-0090): the request read as
 * `deliverables::parse_request` reads it, the file built by the ported
 * writers, and the reply and `subrosa:file` block the app gives.
 */
import { contentMarkdown, markdownToDocx } from "./writers/docx";
import { DOCUMENTS, DocumentInvalid, type Part } from "./writers/exported";
import { buildPptx } from "./writers/pptx";
import {
  asciiLower,
  chars,
  isControl,
  isObject,
  type Json,
  take,
  trim,
  words,
} from "./writers/text";
import { buildXlsx } from "./writers/xlsx";
import { writeZip } from "./writers/zip";

export type DocumentKind = "docx" | "xlsx" | "pptx";
const MAX_TITLE = 120;

export const MIME: Record<DocumentKind, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function parseKind(raw: string): DocumentKind | null {
  const value = asciiLower(trim(raw).replace(/^\.+/, ""));
  if (["docx", "word", "document"].includes(value)) return "docx";
  if (["xlsx", "excel", "spreadsheet", "workbook"].includes(value)) return "xlsx";
  if (["pptx", "powerpoint", "presentation", "slides", "deck"].includes(value)) return "pptx";
  return null;
}

function cleanTitle(raw: unknown, kind: DocumentKind): string {
  const title = take(
    chars(words(typeof raw === "string" ? raw : "").join(" "))
      .filter((c) => !isControl(c))
      .join(""),
    MAX_TITLE,
  );
  if (title) return title;
  return kind === "docx" ? "Document" : kind === "xlsx" ? "Workbook" : "Presentation";
}

export interface DocumentRequest {
  kind: DocumentKind;
  title: string;
  content: Json;
}

/** `{kind, title, content}`; a content sent as a JSON string is parsed. */
export function parseRequest(args: Record<string, unknown>): DocumentRequest {
  const rawKind = "kind" in args ? args.kind : args.format;
  const kind = typeof rawKind === "string" ? parseKind(rawKind) : null;
  if (!kind) throw new DocumentInvalid("kind must be docx, xlsx or pptx.");
  const title = cleanTitle(args.title, kind);
  if (!("content" in args) || args.content === undefined)
    throw new DocumentInvalid("content is required.");
  let content = args.content as Json;
  if (typeof content === "string" && kind !== "docx") {
    try {
      content = JSON.parse(content) as Json;
    } catch {
      throw new DocumentInvalid("content must be a JSON object.");
    }
  }
  return { kind, title, content };
}

export interface Built {
  parts: Part[];
  detail: string;
  warnings: string[];
}

function slideCount(content: Json): number {
  const slides = isObject(content) && "slides" in content ? content.slides : content;
  return Array.isArray(slides) ? slides.filter(isObject).length : 0;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The file's parts, as the app's `build` writes them. */
export function build(request: DocumentRequest, now?: Date): Built {
  const { kind, title, content } = request;
  if (kind === "docx") {
    const markdown = contentMarkdown(content);
    return {
      parts: markdownToDocx(title, markdown, now),
      detail: plural(words(markdown).length, "word"),
      warnings: [],
    };
  }
  if (kind === "xlsx") return { ...buildXlsx(title, content, now), warnings: [] };
  const { parts, warnings } = buildPptx(title, content, now);
  return { parts, detail: plural(slideCount(content), "slide"), warnings };
}

const encoder = new TextEncoder();

/** The package's bytes. */
export function packageParts(parts: Part[]): Promise<Uint8Array<ArrayBuffer>> {
  return writeZip(parts.map((part) => ({ name: part.name, bytes: encoder.encode(part.text) })));
}

export interface MadeDocument {
  /** `<uuid>.<ext>`: the gallery name the block carries. */
  file: string;
  title: string;
  kind: DocumentKind;
  bytes: number;
  detail: string;
  warnings: string[];
}

/** The `subrosa:file` block, its JSON as `serde_json` writes it. */
export function fileBlock(made: Pick<MadeDocument, "detail" | "file" | "kind" | "title">): string {
  const payload = JSON.stringify({
    detail: made.detail,
    file: made.file,
    kind: made.kind,
    title: made.title,
    v: 1,
  });
  return `\`\`\`subrosa:file\n${payload}\n\`\`\``;
}

/** What the tool answers the model, in Rust's own words. */
export function toolReply(made: MadeDocument): string {
  const templates = DOCUMENTS.replies[made.kind];
  const placeholderBlock = fileBlock({
    detail: "DETAIL_PLACEHOLDER",
    file: "FILE_PLACEHOLDER",
    kind: made.kind,
    title: "TITLE_PLACEHOLDER",
  });
  const template = made.warnings.length ? templates.warned : templates.plain;
  return template
    .replace(placeholderBlock, () => fileBlock(made))
    .replace("TITLE_PLACEHOLDER", () => made.title)
    .replace("DETAIL_PLACEHOLDER", () => made.detail)
    .replace("WARNINGS_PLACEHOLDER", () => made.warnings.join("; "));
}

/** The reply when nothing was made. */
export const notMade = (reason: string) => `The document was not made: ${reason}`;

export { DocumentInvalid };
