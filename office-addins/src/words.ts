import office from "@subrosa/chat-core/web/office.json";

/**
 * What the panes say to a model, rendered by Rust
 * (`src-tauri/src/agent_lite/web_features/office.rs`, ADR-0102 and
 * ADR-0104). The rewrites are the note editor's own messages.
 */
export interface OfficeExport {
  promptVersion: string;
  rewrite: {
    system: string;
    temperature: number;
    maxChars: number;
    promptVersion: string;
    messages: Record<RewriteKind, string>;
  };
  word: { draft: string; draftWithContext: string };
  excel: {
    system: string;
    explain: string;
    write: string;
    analyse: string;
    analyseMessage: string;
    selectionFile: string;
  };
  powerpoint: { section: string; withNote: string; proposed: string; refused: string };
}

export type RewriteKind =
  | "correct"
  | "reformulate"
  | "shorten"
  | "translate"
  | "custom"
  | "summarize";

export const OFFICE = office as unknown as OfficeExport;

/**
 * Fills `{name}` placeholders in one pass: a value is never read again, so a
 * selection that happens to contain `{instruction}` stays text. A placeholder
 * without a value is left as it is.
 */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z]+)\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? values[name] : whole,
  );
}
