/**
 * Names and rules, ported from `connectors/mod.rs`, `agent.rs`, `policy.rs`
 * and `research.rs`, and checked against the vectors Rust exports
 * (`src/test/website-connectors.test.ts`).
 *
 * A tool is offered as `<connector>__<tool>`; each is allowed, asked about
 * or turned off. A tool nobody ruled on follows its server's hint: one that
 * says it only reads runs, anything else asks. The hint chooses the default
 * and nothing more.
 */
import type { ToolDefinition } from "../codec";
import type { ToolInfo } from "./mcp";
import { CONNECTORS, fill } from "./words";

export type Rule = "allow" | "ask" | "deny";

/** Lowercase letters, digits and single underscores, at most twenty. */
export function slug(raw: string): string {
  let out = "";
  for (const c of raw) {
    const lower = /[A-Z]/.test(c) ? c.toLowerCase() : c;
    if (/^[a-z0-9]$/.test(lower)) out += lower;
    else if (!out.endsWith("_") && out) out += "_";
    if (out.length >= 20) break;
  }
  out = out.replace(/_+$/, "");
  return out || "connector";
}

/** The name a tool goes by in a conversation: letters, digits, `_`, `-`. */
export function functionName(connectorId: string, tool: string): string {
  const mapped = Array.from(tool, (c) => (/^[A-Za-z0-9-]$/.test(c) ? c : "_"))
    .join("")
    .replace(/^_+|_+$/g, "");
  return `${slug(connectorId)}__${mapped}`.slice(0, 64);
}

export function isConnectorTool(name: string) {
  return name.includes("__");
}

export function parseRule(raw: unknown): Rule | null {
  return raw === "allow" || raw === "ask" || raw === "deny" ? raw : null;
}

export function defaultRule(tool: ToolInfo): Rule {
  return tool.readOnly ? "allow" : "ask";
}

export function effectiveRule(policy: Record<string, string>, tool: ToolInfo): Rule {
  return parseRule(policy[tool.name]) ?? defaultRule(tool);
}

export function parsePolicy(raw: unknown): Record<string, string> {
  if (typeof raw !== "string") return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** `agent::declaration`. */
export function declaration(
  connectorName: string,
  tool: ToolInfo,
  name: string,
  rule: Rule,
): ToolDefinition {
  const template =
    rule === "ask" ? CONNECTORS.declaration.askDescription : CONNECTORS.declaration.description;
  const description = Array.from(
    fill(template, { connector: connectorName, description: tool.description.trim() }),
  )
    .slice(0, 1100)
    .join("");
  const schema =
    JSON.stringify(tool.inputSchema).length > CONNECTORS.limits.maxSchemaBytes
      ? { type: "object", properties: {} }
      : (tool.inputSchema as Record<string, unknown>);
  return { type: "function", function: { name, description, parameters: schema } };
}

const QUERY_FIELDS = ["query", "q", "search", "searchQuery", "text", "keywords"];

/** `research::search_tool`: a tool that reads, runs without asking, is named
 * for searching and takes a text query, with that field. */
export function searchTool(
  tools: ToolInfo[],
  policy: Record<string, string>,
): { tool: ToolInfo; field: string } | null {
  for (const tool of tools) {
    if (effectiveRule(policy, tool) !== "allow") continue;
    const name = tool.name.toLowerCase();
    if (!name.includes("search") && !name.includes("find") && !name.includes("query")) continue;
    const properties = (tool.inputSchema as { properties?: Record<string, { type?: unknown }> })
      ?.properties;
    if (!properties || typeof properties !== "object") continue;
    const field = QUERY_FIELDS.find(
      (key) =>
        key in properties &&
        (properties[key]?.type === undefined ||
          typeof properties[key]?.type !== "string" ||
          properties[key]?.type === "string"),
    );
    if (field) return { tool, field };
  }
  return null;
}
