/**
 * Deep research's pure parts, ported from `src-tauri/src/research/`
 * (ADR-0089): the request and note texts, the reading of what the model
 * answers, the plan's clamp, the ceiling of a depth and the report's
 * assembly. The prompts, limits and depths are Rust's own values
 * (`packages/chat-core/web/research.json`); the tests hold every function
 * here to what Rust answers for the same inputs.
 */
import exported from "@subrosa/chat-core/web/research.json";

export type Depth = "quick" | "standard" | "deep";
export const DEPTHS: Depth[] = ["quick", "standard", "deep"];

interface DepthBudget {
  maxSources: number;
  maxQueries: number;
  resultsPerQuery: number;
  ownSources: number;
}
export interface ResearchExport {
  promptVersion: number;
  prompts: { clarify: string; plan: string; note: string; report: string };
  maxTokens: { clarify: number; plan: number; note: number; report: number };
  readPageChars: number;
  maxQuestionChars: number;
  maxSections: number;
  maxAnswerChars: number;
  depths: Record<Depth, DepthBudget>;
  sourceHeadings: string[];
}
export const RESEARCH = exported as unknown as ResearchExport;

export interface PlanSection {
  title: string;
  queries: string[];
}
export interface ResearchPlan {
  title: string;
  sections: PlanSection[];
}

const chars = (text: string) => Array.from(text);
const take = (text: string, max: number) => chars(text).slice(0, max).join("");
const squash = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

/** `prompts::request_text`: the request as the planning passes read it. */
export function requestText(question: string, questions: string[], answers: string[]): string {
  let out = `Request: ${question.trim()}\n`;
  const pairs = questions
    .map((asked, index) => [asked, (answers[index] ?? "").trim()] as const)
    .filter(([, answer]) => answer);
  if (pairs.length) {
    out += "\nClarifications:\n";
    for (const [asked, answer] of pairs) out += `- ${asked.trim()}: ${answer}\n`;
  }
  return out;
}

function planOutline(plan: ResearchPlan): string {
  let out = `Report: ${plan.title.trim()}\n`;
  for (const section of plan.sections) out += `- ${section.title.trim()}\n`;
  return out;
}

/** `prompts::note_user`. */
export function noteUser(
  request: string,
  plan: ResearchPlan,
  title: string,
  url: string,
  text: string,
): string {
  const read = take(text, RESEARCH.readPageChars);
  return `${request}\nPlan:\n${planOutline(plan)}\nSource: ${title.trim()} (${url.trim()})\n\n${read.trim()}\n`;
}

/** `prompts::report_user`: the notes numbered the way the report must cite. */
export function reportUser(
  request: string,
  plan: ResearchPlan,
  notes: [number, string, string][],
): string {
  let out = `${request}\nPlan:\n${planOutline(plan)}\nSource notes:\n\n`;
  for (const [index, title, text] of notes) out += `[${index}] ${title.trim()}\n${text.trim()}\n\n`;
  return out;
}

/** `prompts::json_object`: the object wherever the model put it. */
export function jsonObject(reply: string): Record<string, unknown> | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(reply.slice(start, end + 1)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function strings(value: unknown, max: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map(squash)
    .filter(Boolean)
    .map((text) => take(text, maxChars))
    .slice(0, max);
}

/** At most three questions; none when the reply has none to offer. */
export function parseQuestions(reply: string): string[] {
  const value = jsonObject(reply);
  return value ? strings(value.questions, 3, 300) : [];
}

/** `prompts::parse_plan`: the proposed plan, or one section over the
 * question when the model answered with something else. */
export function parsePlan(reply: string, question: string): ResearchPlan {
  const value = jsonObject(reply);
  const rawTitle = typeof value?.title === "string" ? value.title.trim() : "";
  const title = rawTitle ? take(rawTitle, 160) : null;
  const sections: PlanSection[] = [];
  if (Array.isArray(value?.sections))
    for (const section of value.sections as unknown[]) {
      if (sections.length >= 8) break;
      if (!section || typeof section !== "object") continue;
      const entry = section as Record<string, unknown>;
      if (typeof entry.title !== "string") continue;
      const sectionTitle = take(entry.title.trim(), 160);
      const queries = strings(entry.queries, 3, 200);
      if (sectionTitle && queries.length) sections.push({ title: sectionTitle, queries });
    }
  const questionTitle = take(question.trim(), 160);
  if (!sections.length)
    return {
      title: title ?? questionTitle,
      sections: [{ title: questionTitle, queries: [questionTitle] }],
    };
  return { title: title ?? questionTitle, sections };
}

/** `prompts::is_irrelevant`. */
export function isIrrelevant(note: string): boolean {
  const head = take(note.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""), 12);
  return new TextEncoder().encode(note.trim()).length < 40 && head.toLowerCase() === "irrelevant";
}

/** `research::clamp_plan`: trimmed, empty searches and sections dropped, no
 * more searches than the depth runs. Null when nothing is left to search. */
export function clampPlan(plan: ResearchPlan, depth: Depth): ResearchPlan | null {
  let budget = RESEARCH.depths[depth].maxQueries;
  const sections: PlanSection[] = [];
  for (const section of plan.sections.slice(0, RESEARCH.maxSections)) {
    const queries = section.queries
      .map(squash)
      .filter(Boolean)
      .map((query) => take(query, 200))
      .slice(0, budget);
    budget -= queries.length;
    const title = take(section.title.trim(), 160);
    if (queries.length) sections.push({ title: title || queries[0], queries });
  }
  if (!sections.length) return null;
  const title = take(plan.title.trim(), 160);
  return { title: title || sections[0].title, sections };
}

export interface ResearchEstimate {
  depth: Depth;
  searches: number;
  pageReads: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
}

/** `research::estimate`: the ceiling of a run of `depth`. Every source is
 * counted as a page read, the most a depth can cost. */
export function estimate(depth: Depth, searches: number): ResearchEstimate {
  const pageReads = RESEARCH.depths[depth].maxSources;
  const pageTokens = Math.floor(RESEARCH.readPageChars / 4) + 600;
  const noteTokens = RESEARCH.maxTokens.note;
  return {
    depth,
    searches,
    pageReads,
    modelCalls: pageReads + 1,
    promptTokens: pageReads * pageTokens + pageReads * noteTokens + 1_500,
    completionTokens: pageReads * noteTokens + RESEARCH.maxTokens.report,
  };
}

/** Per-token prices of the run's model, and the operator's per-call prices
 * of the two web routes, USD, multiplier applied. A price not known is
 * absent. */
export interface ResearchPrices {
  inputUsdPerMtok?: number;
  outputUsdPerMtok?: number;
  searchUsd?: number;
  readUsd?: number;
}
export interface ResearchCeiling {
  modelUsd?: number;
  searchesUsd?: number;
  readsUsd?: number;
  /** Undefined when any part is: a ceiling that leaves out part of the bill
   * is not one (ADR-0089 addendum). */
  totalUsd?: number;
}

export function ceiling(estimated: ResearchEstimate, prices: ResearchPrices): ResearchCeiling {
  const modelUsd =
    prices.inputUsdPerMtok === undefined || prices.outputUsdPerMtok === undefined
      ? undefined
      : (estimated.promptTokens * prices.inputUsdPerMtok +
          estimated.completionTokens * prices.outputUsdPerMtok) /
        1_000_000;
  const searchesUsd =
    prices.searchUsd === undefined ? undefined : estimated.searches * prices.searchUsd;
  const readsUsd = prices.readUsd === undefined ? undefined : estimated.pageReads * prices.readUsd;
  const totalUsd =
    modelUsd === undefined || searchesUsd === undefined || readsUsd === undefined
      ? undefined
      : modelUsd + searchesUsd + readsUsd;
  return { modelUsd, searchesUsd, readsUsd, totalUsd };
}

/** The prices in the operator's pricing table (the shape `/pricing` serves:
 * `models` with per-token prices, `fixedCost` with per-call ones). */
export function pricesFrom(table: unknown, model: string): ResearchPrices {
  const value = (table && typeof table === "object" ? table : {}) as Record<string, unknown>;
  const finite = (number: unknown) =>
    typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : undefined;
  const fixed = Array.isArray(value.fixedCost)
    ? (value.fixedCost as Record<string, unknown>[])
    : [];
  const call = (id: string) => finite(fixed.find((entry) => entry?.model === id)?.costUsd);
  const models = Array.isArray(value.models) ? (value.models as Record<string, unknown>[]) : [];
  const row = models.find((entry) => entry?.model === model);
  const input = finite(row?.inputPrice);
  const output = finite(row?.outputPrice);
  return {
    ...(input !== undefined && output !== undefined
      ? { inputUsdPerMtok: input, outputUsdPerMtok: output }
      : {}),
    ...(call("augment-search") !== undefined ? { searchUsd: call("augment-search") } : {}),
    ...(call("augment-scrape") !== undefined ? { readUsd: call("augment-scrape") } : {}),
  };
}

// ── The report ─────────────────────────────────────────────────────────────

export interface HandedSource {
  /** The number the model was shown. */
  index: number;
  kind: string;
  title: string;
  url?: string | null;
}
export interface Assembled {
  markdown: string;
  cited: HandedSource[];
  /** Numbers cited that named no source the model was handed. */
  invented: number[];
}

/** The report up to a sources section of its own, if the model wrote one. */
function withoutModelSources(markdown: string): string {
  let offset = 0;
  for (const line of markdown.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      const heading = trimmed.replace(/^#+/, "").trim().replace(/:+$/, "").trim().toLowerCase();
      if (RESEARCH.sourceHeadings.includes(heading)) return markdown.slice(0, offset);
    }
    offset += line.length;
  }
  return markdown;
}

const isDigits = (text: string) => /^\d+$/.test(text);

/** `1`, `1, 3`, `2-4`; null when the brackets hold anything else. */
function citationNumbers(inner: string): number[] | null {
  const numbers: number[] = [];
  for (const raw of inner.split(/[,;]/)) {
    const part = raw.trim();
    if (!part) return null;
    const range = part.split(/[-–]/);
    if (range.length >= 2) {
      const [from, to] = [range[0].trim(), range.slice(1).join("-").trim()];
      if (!isDigits(from) || !isDigits(to)) return null;
      const [a, b] = [Number(from), Number(to)];
      if (b < a || b - a > 20) return null;
      for (let number = a; number <= b; number++) numbers.push(number);
    } else {
      if (!isDigits(part)) return null;
      numbers.push(Number(part));
    }
  }
  return numbers.length ? numbers : null;
}

function rewriteCitations(text: string, resolve: (number: number) => number | null): string {
  let out = "";
  let rest = text;
  for (;;) {
    const open = rest.indexOf("[");
    if (open < 0) break;
    out += rest.slice(0, open);
    const after = rest.slice(open + 1);
    const close = after.indexOf("]");
    if (close < 0) return out + rest.slice(open);
    const inner = after.slice(0, close);
    const tail = after.slice(close + 1);
    // `[text](url)` is a link, not a citation.
    const numbers = tail.startsWith("(") ? null : citationNumbers(inner);
    if (numbers) {
      const kept: number[] = [];
      for (const number of numbers) {
        const resolved = resolve(number);
        if (resolved !== null && !kept.includes(resolved)) kept.push(resolved);
      }
      if (!kept.length) out = out.replace(/ +$/, "");
      else out += kept.map((number) => `[${number}]`).join("");
    } else out += `[${inner}]`;
    rest = tail;
  }
  return out + rest;
}

function sourceLine(number: number, source: HandedSource): string {
  const title = source.title.replaceAll("[", "(").replaceAll("]", ")").trim();
  if (source.url) return `${number}. [${title}](${source.url.replaceAll(" ", "%20")})`;
  return source.kind === "note" ? `${number}. ${title} · note` : `${number}. ${title} · document`;
}

/** `report::assemble`: the model numbers, the app resolves (ADR-0044). */
export function assemble(title: string, raw: string, handed: HandedSource[]): Assembled {
  const body = withoutModelSources(raw).trim();
  const order: number[] = [];
  const invented: number[] = [];
  const rewritten = rewriteCitations(body, (number) => {
    if (handed.some((source) => source.index === number)) {
      let position = order.indexOf(number);
      if (position < 0) {
        order.push(number);
        position = order.length - 1;
      }
      return position + 1;
    }
    if (!invented.includes(number)) invented.push(number);
    return null;
  });
  let markdown = rewritten.trimStart().startsWith("# ") ? "" : `# ${title.trim()}\n\n`;
  markdown += rewritten.trim();
  const cited = order
    .map((number) => handed.find((source) => source.index === number))
    .filter((source): source is HandedSource => !!source);
  if (cited.length)
    markdown += `\n\n## Sources\n\n${cited.map((source, at) => sourceLine(at + 1, source)).join("\n")}`;
  return { markdown: `${markdown}\n`, cited, invented };
}

/** `report::report_title`. */
export function reportTitle(markdown: string, fallback: string): string {
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      const title = trimmed.slice(2).trim();
      if (title) return title;
      break;
    }
  }
  return fallback.trim();
}

/** `report::without_title`. */
export function withoutTitle(markdown: string): string {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith("# ")) return trimmed.trim();
  const newline = trimmed.indexOf("\n");
  return newline < 0 ? "" : trimmed.slice(newline + 1).trim();
}

/** `backend::source_key`: a page found twice is one source. */
export function sourceKey(url: string): string {
  return url.trim().split("#")[0].replace(/\/+$/, "");
}
