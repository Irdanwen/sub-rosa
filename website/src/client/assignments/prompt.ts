/**
 * What a run is told and what it may use: `assignments/prompt.rs`, assembled
 * here from the words Rust exported, and checked against the prompts Rust
 * rendered (`vectors` in the export), so the two cannot drift.
 */
import { ASSIGNMENTS, type ToolGroup } from "./words";

export type Autonomy = "ask" | "act";

export function parseAutonomy(raw: string): Autonomy {
  return raw === "act" ? "act" : "ask";
}

/** The groups a run gets: ticked, known, and allowed by the autonomy. */
export function effectiveGroups(tools: string[], autonomy: Autonomy): ToolGroup[] {
  return ASSIGNMENTS.toolGroups
    .filter((group) => tools.includes(group.id))
    .filter((group) => autonomy === "act" || !group.acts);
}

/** The agent-lite tools those groups turn on. */
export function liteTools(groups: ToolGroup[]): Set<string> {
  return new Set(groups.flatMap((group) => group.lite));
}

/**
 * Whether a run may be offered a tool, as `assistants::runtime::allows_tool`
 * decides for a phone run: a connector tool (`<connector>__<tool>`) when the
 * connectors group is ticked, a skill when one is asked for, otherwise only
 * the tools of the run's groups. What no group names (a document, Python)
 * is not offered to a run on the phone, nor here, and the finances only when
 * the run's definition ticks the "personal" group.
 */
export function allowToolFor(groups: ToolGroup[]): (name: string) => boolean {
  const tools = liteTools(groups);
  return (name) => {
    if (name.includes("__")) return tools.has("connectors");
    if (name === "load_skill") return true;
    return tools.has(name);
  };
}

export interface Reviewed {
  when: string;
  approved: boolean;
  feedback: string | null;
  result: string | null;
}

export interface RunPrompt {
  kind: string;
  title: string;
  goal: string;
  autonomy: Autonomy;
  /** The slot, written for a person, when the run is late. */
  lateFor: string | null;
  reviewed: Reviewed[];
  /** A proposal the person approved, to carry out now. */
  approvedProposal: string | null;
}

function chars(text: string): string[] {
  return Array.from(text);
}

/** Rust's `trim`: Unicode white space at both ends. */
function trim(text: string): string {
  return text.replace(/^\s+|\s+$/gu, "");
}

function clipped(text: string, limit: number): string {
  const trimmed = trim(text);
  const all = chars(trimmed);
  return all.length <= limit ? trimmed : `${all.slice(0, limit).join("")}…`;
}

/** `prompt::run_prompt`: the user turn a run's chat starts from. */
export function runPrompt(input: RunPrompt): string {
  const words = ASSIGNMENTS.words;
  if (input.approvedProposal !== null)
    return `${words.approvedBeforeTitle}${trim(input.title)}${words.approvedAfterTitle}${clipped(
      input.approvedProposal,
      words.maxProposalChars,
    )}`;
  const parts: string[] = [];
  parts.push(
    input.kind === "task"
      ? `${words.taskBeforeTitle}${trim(input.title)}${words.taskAfterTitle}${trim(input.goal)}`
      : `${words.assignmentBeforeTitle}${trim(input.title)}${words.assignmentAfterTitle}${trim(
          input.goal,
        )}`,
  );
  parts.push(input.autonomy === "ask" ? words.askRule : words.actRule);
  const reviewed = input.reviewed.slice(0, ASSIGNMENTS.feedbackInPrompt).map((review) => {
    let line = `- ${review.when}: ${review.approved ? words.approved : words.rejected}${words.yourResult}`;
    if (review.result && trim(review.result))
      line += `${words.resultOpen}${clipped(review.result, ASSIGNMENTS.maxResultInPrompt)}${words.resultClose}`;
    if (review.feedback && trim(review.feedback))
      line += `${words.myFeedback}${trim(review.feedback)}`;
    return line;
  });
  if (reviewed.length) parts.push(`${words.feedbackHeader}${reviewed.join("\n")}`);
  if (input.lateFor !== null)
    parts.push(`${words.lateBeforeSlot}${input.lateFor}${words.lateAfterSlot}`);
  parts.push(words.summaryRule);
  return parts.join("\n\n");
}

/** `prompt::result_summary`: the summary the run was asked for, or its first
 * real line, at most 240 characters. */
export function resultSummary(answer: string): string {
  const lines = answer.split("\n").map(trim);
  const heading = lines.findIndex(
    (line) =>
      trim(line.replace(/^#+/, ""))
        .replace(/^\*+|\*+$/g, "")
        .replace(/:+$/, "")
        .toLowerCase() === "result",
  );
  const from = heading < 0 ? 0 : heading + 1;
  const line =
    lines
      .slice(from)
      .find((item) => item !== "" && !item.startsWith("#") && !item.startsWith("---")) ?? "";
  return clipped(line.replace(/^[-*•]+/, "").replaceAll("**", ""), 240);
}
