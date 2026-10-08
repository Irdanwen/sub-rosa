/// <reference path="./pdfjs-worker.d.ts" />
/**
 * Reading a document in the browser (ADR-0085, decision 7, on the web): the
 * text of a PDF, Word, Excel or PowerPoint file, or a text file, in the shape
 * the app's extractors give it (`assistants/references.rs::extract_bytes`),
 * so a chat or a project reads the same text whichever device added it.
 *
 * - PDF: pdf.js, bundled with the site and loaded only when a PDF arrives. It
 *   runs on the page's thread (no worker URL, which Trusted Types would
 *   refuse), page by page: `[Page n]`. A PDF with no text is a scan, and is
 *   said to be one rather than read as empty.
 * - Word: the text of `word/document.xml` under `[Document]`.
 * - PowerPoint: each `ppt/slides/slideN.xml` as `[Slide n]`, in slide order.
 * - Excel: each `xl/worksheets/sheetN.xml` as `[Sheet n]`, one line per cell
 *   (`A1: value`), shared strings resolved.
 * - Text, Markdown, CSV and JSON: as they are, up to 512 KB.
 *
 * Nothing is sent anywhere to read a file.
 */
import { readZipText } from "./unzip";

export type DocumentFormat = "pdf" | "docx" | "xlsx" | "pptx" | "txt" | "md" | "csv" | "json";

export interface ReadDocument {
  name: string;
  format: DocumentFormat;
  text: string;
  pages: number;
  sheets: number;
  slides: number;
}

export class DocumentError extends Error {
  constructor(
    public code: "unsupported" | "too_large" | "scan" | "empty" | "unreadable",
    message: string,
  ) {
    super(message);
  }
}

/** The app's limits: 20 MB in, 4 MB of text out, 512 KB for a text file. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 512 * 1024;
const MAX_EXTRACTED_BYTES = 4 * 1024 * 1024;

const TEXT_FORMATS: DocumentFormat[] = ["txt", "md", "csv", "json"];

export function documentFormat(name: string): DocumentFormat | null {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  const format = extension === "markdown" ? "md" : extension === "text" ? "txt" : extension;
  return (["pdf", "docx", "xlsx", "pptx", ...TEXT_FORMATS] as string[]).includes(format)
    ? (format as DocumentFormat)
    : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** `xml_text`: every text node, and a line break after each paragraph, table
 * row and shared string. */
export function xmlText(xml: string): string {
  let out = "";
  const pattern = /<(\/?)([\w.-]+:)?([\w.-]+)[^>]*?(\/?)>|([^<]+)/g;
  for (const match of xml.matchAll(pattern)) {
    if (match[5] !== undefined) {
      out += decodeEntities(match[5]);
      continue;
    }
    const closing = match[1] === "/";
    const local = match[3];
    if (closing && (local === "p" || local === "row" || local === "si")) out += "\n";
  }
  return out;
}

function numbered(names: string[], pattern: RegExp): string[] {
  return names
    .map((name) => ({ name, number: Number(pattern.exec(name)?.[1] ?? Number.NaN) }))
    .filter((entry) => Number.isFinite(entry.number))
    .sort((a, b) => a.number - b.number)
    .map((entry) => entry.name);
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  for (const item of xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)) {
    let value = "";
    for (const part of item[1].matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g))
      value += decodeEntities(part[1]);
    strings.push(value);
  }
  return strings;
}

/** `sheet_text`: one `ref: value` line per cell. */
function sheetText(xml: string, shared: string[]): string {
  let out = "";
  for (const cell of xml.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
    const attributes = cell[1];
    const inner = cell[2] ?? "";
    const ref = /\br="([^"]*)"/.exec(attributes)?.[1] ?? "";
    const type = /\bt="([^"]*)"/.exec(attributes)?.[1] ?? "";
    let value = "";
    for (const part of inner.matchAll(/<(?:\w+:)?(v|t)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?\1>/g))
      value += decodeEntities(part[2]);
    if (type === "s") value = shared[Number(value)] ?? "";
    if (value) out += `${ref}: ${value}\n`;
  }
  return out;
}

async function officeText(bytes: Uint8Array, format: "docx" | "xlsx" | "pptx"): Promise<string> {
  const wanted =
    format === "docx"
      ? (name: string) => name === "word/document.xml"
      : format === "pptx"
        ? (name: string) => /^ppt\/slides\/slide\d+\.xml$/.test(name)
        : (name: string) =>
            name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
  const files = await readZipText(bytes, wanted);
  if (format === "docx") {
    const xml = files.get("word/document.xml");
    if (xml === undefined) throw new DocumentError("unreadable", "This Word file has no text.");
    return `[Document]\n${xmlText(xml)}\n`;
  }
  if (format === "pptx")
    return numbered([...files.keys()], /slide(\d+)\.xml$/)
      .map((name, index) => `[Slide ${index + 1}]\n${xmlText(files.get(name) ?? "")}\n`)
      .join("");
  const shared = sharedStrings(files.get("xl/sharedStrings.xml"));
  return numbered([...files.keys()], /sheet(\d+)\.xml$/)
    .map((name) => {
      const number = /sheet(\d+)\.xml$/.exec(name)?.[1];
      return `[Sheet ${number}]\n${sheetText(files.get(name) ?? "", shared)}\n`;
    })
    .join("");
}

/** The page texts of a PDF. Swappable in tests, where pdf.js has no DOM. */
export type PdfReader = (bytes: Uint8Array) => Promise<string[]>;

/** pdf.js, on the page's thread. Importing the worker module first registers
 * its handler on `globalThis`, which pdf.js uses instead of spawning a worker
 * from a URL. */
export const pdfJsReader: PdfReader = async (bytes) => {
  await import("pdfjs-dist/build/pdf.worker.mjs");
  const pdfjs = await import("pdfjs-dist");
  const task = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: false,
  });
  const document = await task.promise;
  try {
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items)
        if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
      pages.push(text);
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
};

function counted(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/** Reads one file. Refuses what the app refuses, with the same reasons. */
export async function readDocument(
  file: { name: string; bytes: Uint8Array },
  pdf: PdfReader = pdfJsReader,
): Promise<ReadDocument> {
  const format = documentFormat(file.name);
  if (!format)
    throw new DocumentError(
      "unsupported",
      "This file type cannot be read. Attach a PDF, Word, Excel, PowerPoint, text or CSV file.",
    );
  const limit = TEXT_FORMATS.includes(format) ? MAX_TEXT_FILE_BYTES : MAX_DOCUMENT_BYTES;
  if (file.bytes.byteLength > limit)
    throw new DocumentError("too_large", "This file is too large.");
  let text: string;
  try {
    if (format === "pdf") {
      const pages = await pdf(file.bytes);
      if (pages.length && pages.every((page) => !page.trim()))
        throw new DocumentError(
          "scan",
          "This PDF is a scan: it has no text to read. Export it with text, or paste the text.",
        );
      text = pages.map((page, index) => `[Page ${index + 1}]\n${page}\n`).join("");
    } else if (format === "docx" || format === "xlsx" || format === "pptx")
      text = await officeText(file.bytes, format);
    else text = new TextDecoder().decode(file.bytes);
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError("unreadable", "This file could not be read.");
  }
  if (new TextEncoder().encode(text).length > MAX_EXTRACTED_BYTES)
    throw new DocumentError("too_large", "This file has more text than can be read at once.");
  if (!text.replace(/\[(Page|Sheet|Slide) \d+\]|\[Document\]/g, "").trim())
    throw new DocumentError("empty", "This document has no text to read.");
  return {
    name: file.name,
    format,
    text,
    pages: counted(text, "[Page "),
    sheets: counted(text, "[Sheet "),
    slides: counted(text, "[Slide "),
  };
}
