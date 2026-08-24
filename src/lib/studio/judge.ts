/**
 * A judge: a model looking at what was made and saying what is weak.
 *
 * This is the feedback loop, and it is the piece that was missing. A pipeline
 * with no judge can only get better by the user noticing - which they do, on
 * the sixth shot, after paying for all six. A judge looks at the panels before
 * the video spend, and at the assembled cut before the user does, and names
 * the shots worth doing again.
 *
 * Three rules, all of them learned the expensive way.
 *
 * **A judge never blocks.** It is best-effort at every level: no vision model,
 * a refusal, a timeout, unparseable output - each degrades to "no opinion" and
 * the production carries on. A quality tool that can stop a paid run from
 * finishing is a liability, not a feature.
 *
 * **The app decides what a verdict means.** The model returns scores and
 * weaknesses. Whether that clears a bar is a threshold *here*, so it can be
 * tuned, tested, and explained, rather than a mood the model was in.
 *
 * **Its output is parsed defensively.** Models wrap JSON in prose, in fences,
 * in an apology. Anything that cannot be read is no opinion, never a crash.
 */

import { mediaJson } from "./client";
import type { MediaModel } from "./types";

/** One thing being judged: a panel, a shot, a whole film. */
export interface JudgeSubject {
  /** How the verdict should refer to it. */
  label: string;
  /** What it was meant to be, if that is known. */
  intent?: string;
  /** A picture of it, as a data URI. */
  imageDataUri?: string;
}

export interface JudgeWeakness {
  label: string;
  why: string;
}

export interface JudgeVerdict {
  /** 0 to 10. */
  score: number;
  /** Whether it clears the bar. Decided here, not by the model. */
  passes: boolean;
  summary: string;
  weakest: JudgeWeakness[];
}

/**
 * The bar a judged gate lets through.
 *
 * Seven, not nine. A judge that only passes excellence stops every production
 * it is put in front of, and a gate that always holds is a gate nobody leaves
 * switched on.
 */
export const JUDGE_PASS_SCORE = 7;

export interface JudgeInput {
  /** What the judge is being asked to look at, in order. */
  subjects: readonly JudgeSubject[];
  /** What the whole thing is trying to be. */
  brief?: string;
  /** Identities that must not have drifted, as invariant lines. */
  invariants?: readonly string[];
  /** What this judge is for: continuity, composition, the cut as a whole. */
  lens?: string;
}

const SYSTEM = [
  "You are a film supervisor reviewing work in progress.",
  "You are blunt, specific and short. You never praise.",
  "Reply with JSON only, no prose and no code fence, in exactly this shape:",
  '{"score": <0-10>, "summary": "<one sentence>", "weakest": [{"label": "<the item>", "why": "<what is wrong, concretely>"}]}',
  "Score the work as a whole. List at most three weakest items, worst first.",
  "If everything is fine, return an empty weakest array.",
].join(" ");

/** The chat messages a judge run sends. Pure, so the prompt is testable. */
export function judgeMessages(input: JudgeInput): Array<Record<string, unknown>> {
  const lines: string[] = [];
  if (input.lens) lines.push(`Judge this on ${input.lens}.`);
  if (input.brief) lines.push(`What it is meant to be: ${input.brief}`);
  for (const invariant of input.invariants ?? []) {
    lines.push(`Must not have drifted: ${invariant}`);
  }
  lines.push("");
  input.subjects.forEach((subject, index) => {
    lines.push(
      subject.intent
        ? `${index + 1}. ${subject.label} - meant to be: ${subject.intent}`
        : `${index + 1}. ${subject.label}`,
    );
  });

  const content: Array<Record<string, unknown>> = [{ type: "text", text: lines.join("\n") }];
  for (const subject of input.subjects) {
    if (subject.imageDataUri) {
      content.push({ type: "image_url", image_url: { url: subject.imageDataUri } });
    }
  }
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content },
  ];
}

/**
 * Read a verdict out of whatever the model said.
 *
 * Models wrap JSON in prose, in fences, in an apology. The first balanced
 * object in the reply is taken, and anything that still will not parse is no
 * opinion - which the caller treats as "the judge had nothing to say", never
 * as a failure.
 */
export function parseVerdict(raw: string): JudgeVerdict | undefined {
  const start = raw.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let end = -1;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') inString = !inString;
    if (inString) continue;
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const body = parsed as Record<string, unknown>;

  const rawScore = Number(body.score);
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(10, rawScore)) : 0;
  const summary = typeof body.summary === "string" ? body.summary.trim() : "";
  const weakest = Array.isArray(body.weakest)
    ? body.weakest
        .map((item) => {
          const weakness = (item ?? {}) as Record<string, unknown>;
          const label = typeof weakness.label === "string" ? weakness.label.trim() : "";
          const why = typeof weakness.why === "string" ? weakness.why.trim() : "";
          return label || why ? { label: label || "Unnamed", why } : undefined;
        })
        .filter((item): item is JudgeWeakness => item !== undefined)
        .slice(0, 3)
    : [];

  if (!summary && weakest.length === 0 && !Number.isFinite(rawScore)) return undefined;
  return { score, passes: score >= JUDGE_PASS_SCORE, summary, weakest };
}

/**
 * Run a judge. Never throws: an opinion is a bonus, not a dependency.
 */
export async function judge(
  input: JudgeInput,
  model: string,
  signal?: AbortSignal,
): Promise<JudgeVerdict | undefined> {
  if (!model || input.subjects.length === 0) return undefined;
  try {
    const response = await mediaJson<{
      choices?: Array<{ message?: { content?: unknown } }>;
    }>(
      "/chat/completions",
      {
        model,
        messages: judgeMessages(input),
        temperature: 0.2,
        max_tokens: 700,
      },
      signal,
    );
    const content = response.choices?.[0]?.message?.content;
    return typeof content === "string" ? parseVerdict(content) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A model that can actually look at the work.
 *
 * Not "the first text model": handing pictures to a model that does not read
 * them costs a call and returns a confident opinion about nothing, which is
 * worse than no opinion at all. Preference goes to the smaller ones - a
 * supervisor's note is a short answer about an obvious thing.
 */
export function pickJudgeModel(
  models: ReadonlyArray<
    Pick<MediaModel, "id" | "name" | "mediaType" | "supportsVision" | "offline">
  >,
): string | undefined {
  const seeing = models.filter(
    (model) => model.mediaType === "text" && model.supportsVision && !model.offline,
  );
  if (seeing.length === 0) return undefined;
  // "mini", "fast", "flash", "small": the published shorthand for the cheap
  // tier across every family the catalog carries.
  const cheap = seeing.find((model) => /mini|fast|flash|small|lite/i.test(model.id));
  return (cheap ?? seeing[0]).id;
}

/** A verdict as one line a surface can show without ceremony. */
export function verdictLine(verdict: JudgeVerdict): string {
  const weak = verdict.weakest.map((item) => `${item.label}: ${item.why}`).join(" ");
  return `${verdict.score}/10. ${verdict.summary}${weak ? ` ${weak}` : ""}`.trim();
}
