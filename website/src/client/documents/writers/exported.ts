/**
 * What the writers read from Rust (`agent_lite/web_features/documents.rs`):
 * the fixed XML parts, the tool's declaration and its reply. The prose and the
 * templates are never written a second time here (ADR-0101).
 */
import exported from "@subrosa/chat-core/web/documents.json";
import type { ToolDefinition } from "../../codec";
import { trim, xmlText } from "./text";

export interface DocumentsExport {
  tool: ToolDefinition;
  replies: Record<"docx" | "xlsx" | "pptx", { plain: string; warned: string }>;
  templates: {
    docx: { contentTypes: string; rootRels: string; styles: string };
    xlsx: { rootRels: string };
    pptx: {
      ns: string;
      rootRels: string;
      slideMaster: string;
      slideMasterRels: string;
      slideLayout: string;
      slideLayoutRels: string;
      notesMaster: string;
      notesMasterRels: string;
      theme: string;
      presProps: string;
      viewProps: string;
      tableStyles: string;
    };
  };
  tables: Record<string, { kind: "artifact"; columns: string[] }>;
}

export const DOCUMENTS = exported as unknown as DocumentsExport;

/** One part of a package, as text. */
export interface Part {
  name: string;
  text: string;
}

/** `docProps/core.xml`, shared by the three writers. */
export function coreXml(title: string, now = new Date()): string {
  const created = `${now.toISOString().slice(0, 19)}Z`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(trim(title))}</dc:title><dc:creator>Sub Rosa</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>`;
}

/** A writer's failure: a sentence for the model, as Rust's `invalid`. */
export class DocumentInvalid extends Error {}
