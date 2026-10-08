/**
 * Image generation with thinking (ADR-0088): a picture is checked against its
 * prompt by a model that can see it, and, unless it already does what was
 * asked, edited once with what the check found, at most twice. The critique's
 * instructions, the edit prompt's suffix, the pass limit and the edit models
 * are Rust's (`image_refine.rs`, exported to `agent-lite.json`); the price,
 * an edit's price times the passes, is shown before the person confirms.
 */
import { type Operator, streamCompletion } from "./carpe-diem";
import { AGENT_LITE } from "./codec";
import { editImage, type ImageCall, type Picture } from "./images";

export interface Critique {
  satisfied: boolean;
  issues: string[];
  instruction?: string;
}

const clip = (text: string, max: number) => Array.from(text.trim()).slice(0, max).join("");

/** `parse_critique`: the first `{` to the last `}`; a verdict with nothing to
 * do is a satisfied one, so no credits go to re-rendering the same picture. */
export function parseCritique(text: string): Critique | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const instruction =
    typeof value.instruction === "string" && value.instruction.trim()
      ? clip(value.instruction, 1000)
      : undefined;
  const issues = Array.isArray(value.issues)
    ? value.issues
        .filter((issue): issue is string => typeof issue === "string" && !!issue.trim())
        .slice(0, 5)
        .map((issue) => clip(issue, 240))
    : [];
  return { satisfied: value.satisfied === true || !instruction, issues, instruction };
}

/** `edit_prompt`: the fix, then the rest of the picture left alone. */
export function refineEditPrompt(instruction: string): string {
  const trimmed = instruction.trim();
  const stop = /[.!?]$/.test(trimmed) ? "" : ".";
  return `${trimmed}${stop}${AGENT_LITE.editing.refine.editSuffix}`;
}

export async function critique(
  operator: Operator,
  key: string,
  visionModel: string,
  prompt: string,
  image: string,
  signal?: AbortSignal,
): Promise<Critique> {
  const reply = await streamCompletion(
    operator,
    key,
    {
      model: visionModel,
      temperature: 0.2,
      max_tokens: 2000,
      messages: [
        { role: "system", content: AGENT_LITE.editing.refine.critiqueSystem },
        {
          role: "user",
          content: [
            { type: "text", text: `The request:\n${clip(prompt, 5000)}` },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
    },
    () => undefined,
    signal,
  );
  return parseCritique(reply.content) ?? { satisfied: true, issues: [] };
}

export interface RefineStep {
  pass: number;
  critique: Critique;
  picture?: Picture;
}

/** The loop: check, edit, check again, at most `maxPasses` edits. Each pass
 * works on the previous output; every version is reported as it lands. */
export async function refine(
  call: ImageCall,
  options: {
    visionModel: string;
    editModel: string;
    picture: Picture;
    passes?: number;
    onStep?: (step: RefineStep) => void;
  },
): Promise<Picture> {
  const passes = Math.min(
    options.passes ?? AGENT_LITE.editing.refine.maxPasses,
    AGENT_LITE.editing.refine.maxPasses,
  );
  let current = options.picture;
  for (let pass = 1; pass <= passes; pass++) {
    const verdict = await critique(
      call.operator,
      call.key,
      options.visionModel,
      options.picture.prompt,
      current.dataUrl,
      call.signal,
    );
    if (verdict.satisfied || !verdict.instruction) {
      options.onStep?.({ pass, critique: verdict });
      return current;
    }
    const edited = await editImage(call, {
      model: options.editModel,
      prompt: refineEditPrompt(verdict.instruction),
      image: current.dataUrl,
    });
    current = { ...edited, prompt: options.picture.prompt };
    options.onStep?.({ pass, critique: verdict, picture: current });
  }
  return current;
}
