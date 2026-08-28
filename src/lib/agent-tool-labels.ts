type ToolPayload = Record<string, unknown>;

const GENERIC_TOOL_NAMES = new Set([
  "bash",
  "command",
  "exec",
  "exec_command",
  "run_command",
  "shell",
  "terminal",
]);

export function toolActivityLabel(toolName: string | undefined, payload?: unknown) {
  const records = payloadRecords(payload);
  const rawName =
    nonEmptyString(toolName) ?? firstString(records, ["name", "tool_name", "tool"]) ?? "tool";
  const normalized = normalizeToolName(rawName);
  const command = firstString(records, ["command", "cmd", "script", "shell_command"]);
  const commandLabel = command ? labelFromCommand(command) : undefined;
  if (commandLabel) return commandLabel;

  const payloadLabel = labelFromPayload(records, normalized);
  if (payloadLabel) return payloadLabel;

  const nameLabel = labelFromName(normalized);
  if (nameLabel) return nameLabel;

  return humanizeToolName(rawName);
}

export function toolActivitySentence(toolName: string | undefined, payload?: unknown) {
  const label = toolActivityLabel(toolName, payload);
  return label === "Tool" ? "Using a tool." : `${label}.`;
}

/** A coarse activity family, derived from the human label so the UI can pick a
 * matching glyph without re-classifying. The renderer owns the label -> icon
 * map (this module stays free of view concerns / icon imports). Unknown or
 * humanized labels fall through to "tool". */
export type ToolActivityKind =
  | "command"
  | "browse"
  | "search"
  | "search-images"
  | "edit"
  | "read"
  | "images"
  | "github"
  | "repo"
  | "tests"
  | "build"
  | "check"
  | "tool";

const ACTIVITY_KIND_BY_LABEL: Record<string, ToolActivityKind> = {
  "Running command": "command",
  Browsing: "browse",
  "Searching web": "search",
  Searching: "search",
  "Searching files": "search",
  "Searching images": "search-images",
  "Editing files": "edit",
  "Reading files": "read",
  "Working with images": "images",
  "Using GitHub": "github",
  "Inspecting repository": "repo",
  "Running tests": "tests",
  Building: "build",
  "Checking code": "check",
};

export function toolActivityKind(label: string): ToolActivityKind {
  return ACTIVITY_KIND_BY_LABEL[label] ?? "tool";
}

/**
 * The same activity, once it is over.
 *
 * These labels are written in the present because they are minted while the
 * step runs - and then kept, unchanged, for as long as the transcript exists.
 * A finished session read as a wall of twenty identical "Running command"
 * rows, all claiming to be happening now, with nothing to separate the one
 * that actually was.
 *
 * Only the labels this module mints are rewritten. Anything else is a tool
 * name humanized from the wire (`humanizeToolName`), and there is no safe way
 * to put an arbitrary name into the past - "Fetch data" would become nonsense.
 * Those are left exactly as they are.
 */
const SETTLED_LABELS: Record<string, string> = {
  "Running command": "Ran command",
  Browsing: "Browsed",
  "Searching web": "Searched the web",
  Searching: "Searched",
  "Searching files": "Searched files",
  "Searching images": "Searched images",
  "Editing files": "Edited files",
  "Reading files": "Read files",
  "Working with images": "Worked with images",
  "Using GitHub": "Used GitHub",
  "Inspecting repository": "Inspected the repository",
  "Running tests": "Ran tests",
  Building: "Built",
  "Checking code": "Checked code",
};

export function settledToolLabel(label: string): string {
  const known = SETTLED_LABELS[label];
  if (known) return known;
  // `labelFromCommand` mints "Running <something>" for commands it recognises
  // by name, so the same rewrite has to reach those too.
  return label.startsWith("Running ") ? `Ran ${label.slice("Running ".length)}` : label;
}

export function humanizeToolName(value: string) {
  const cleaned = value
    .replace(/^tools?[._-]/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Tool";
  const lower = cleaned.toLowerCase();
  return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
}

function labelFromPayload(records: ToolPayload[], normalizedName: string) {
  if (records.some((record) => hasAnyKey(record, ["url", "href", "uri"]))) {
    return "Browsing";
  }
  if (records.some((record) => hasAnyKey(record, ["search_query", "web_query", "url_query"]))) {
    return "Searching web";
  }
  if (records.some((record) => hasAnyKey(record, ["image_query", "image_search_query"]))) {
    return "Searching images";
  }
  if (records.some((record) => hasAnyKey(record, ["query", "q"]))) {
    if (isWebToolName(normalizedName)) return "Searching web";
    if (isFileToolName(normalizedName)) return "Searching files";
    return "Searching";
  }
  if (records.some((record) => hasAnyKey(record, ["path", "file", "files"]))) {
    if (isEditToolName(normalizedName)) return "Editing files";
    if (isSearchToolName(normalizedName)) return "Searching files";
    return "Reading files";
  }
  return undefined;
}

function labelFromCommand(command: string) {
  const lower = command.toLowerCase();
  if (/\bhttps?:\/\//.test(lower) || /\b(curl|wget)\b/.test(lower)) {
    return "Browsing";
  }
  if (/\bgh\s+/.test(lower)) return "Using GitHub";
  if (/\bgit\s+(status|diff|show|log|grep|ls-files|branch|fetch)\b/.test(lower)) {
    return "Inspecting repository";
  }
  if (/\b(rg|grep|fd|find)\b/.test(lower)) return "Searching files";
  if (/\b(cat|sed|awk|head|tail|nl|ls|pwd|tree)\b/.test(lower)) {
    return "Reading files";
  }
  if (
    /\b(pnpm|npm|yarn|bun)\s+(run\s+)?(test|vitest)\b/.test(lower) ||
    /\b(cargo\s+test|pytest|vitest)\b/.test(lower)
  ) {
    return "Running tests";
  }
  if (
    /\b(pnpm|npm|yarn|bun)\s+(run\s+)?build\b/.test(lower) ||
    /\b(cargo\s+build|tauri\s+build)\b/.test(lower)
  ) {
    return "Building";
  }
  if (
    /\b(pnpm|npm|yarn|bun)\s+(run\s+)?(lint|check|typecheck)\b/.test(lower) ||
    /\b(eslint|tsc|prettier)\b/.test(lower) ||
    /\bcargo\s+(clippy|fmt|check)\b/.test(lower)
  ) {
    return "Checking code";
  }
  if (/\b(git\s+(add|apply|commit|push)|apply_patch)\b/.test(lower)) {
    return "Editing files";
  }
  return undefined;
}

function labelFromName(normalizedName: string) {
  if (GENERIC_TOOL_NAMES.has(normalizedName)) return "Running command";
  if (isWebSearchToolName(normalizedName)) return "Searching web";
  if (isWebToolName(normalizedName)) return "Browsing";
  if (isImageToolName(normalizedName)) return "Working with images";
  if (isEditToolName(normalizedName)) return "Editing files";
  if (isSearchToolName(normalizedName)) return "Searching files";
  if (isReadToolName(normalizedName)) return "Reading files";
  if (hasSegment(normalizedName, ["git", "github", "gh"])) {
    return "Using GitHub";
  }
  if (hasSegment(normalizedName, ["test", "vitest", "pytest"])) {
    return "Running tests";
  }
  if (hasSegment(normalizedName, ["build", "compile"])) return "Building";
  if (hasSegment(normalizedName, ["lint", "typecheck", "check"])) {
    return "Checking code";
  }
  return undefined;
}

function isWebToolName(value: string) {
  return (
    hasSegment(value, ["browser", "browse", "web", "visit", "navigate"]) ||
    hasPhrase(value, ["fetch_url", "open_url"]) ||
    hasSegment(value, ["http", "url"])
  );
}

function isWebSearchToolName(value: string) {
  return hasPhrase(value, [
    "web_search",
    "search_query",
    "search_web",
    "internet_search",
    "search_internet",
  ]);
}

function isImageToolName(value: string) {
  return hasSegment(value, ["image", "screenshot", "vision"]);
}

function isFileToolName(value: string) {
  return isReadToolName(value) || isEditToolName(value) || isSearchToolName(value);
}

function isReadToolName(value: string) {
  return (
    hasSegment(value, ["read", "cat", "list", "ls", "glob", "view"]) ||
    hasPhrase(value, ["open_file", "view_file", "file_read"])
  );
}

function isEditToolName(value: string) {
  return (
    hasSegment(value, ["write", "edit", "patch", "create", "delete", "remove", "move", "copy"]) ||
    hasPhrase(value, ["apply_patch"])
  );
}

function isSearchToolName(value: string) {
  return hasSegment(value, ["search", "grep", "rg", "find", "ripgrep"]);
}

function payloadRecords(payload: unknown): ToolPayload[] {
  const root = objectRecord(payload);
  if (!root) return [];
  const records: ToolPayload[] = [root];
  for (const key of ["arguments", "args", "input", "parameters"]) {
    const child = objectRecord(root[key]);
    if (child) records.push(child);
  }
  return records;
}

function objectRecord(value: unknown): ToolPayload | undefined {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return objectRecord(parsed);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as ToolPayload;
}

function firstString(records: ToolPayload[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = nonEmptyString(record[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function hasAnyKey(record: ToolPayload, keys: string[]) {
  return keys.some((key) => meaningfulValue(record[key]));
}

function meaningfulValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeToolName(value: string) {
  return value
    .replace(/^tools?[._-]/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function hasSegment(value: string, segments: string[]) {
  const parts = new Set(value.split("_").filter(Boolean));
  return segments.some((segment) => parts.has(segment));
}

function hasPhrase(value: string, phrases: string[]) {
  return phrases.some((phrase) => value.includes(phrase));
}
