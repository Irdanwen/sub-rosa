import { beforeEach, describe, expect, it, vi } from "vitest";

const mediaJson = vi.fn();
vi.mock("../lib/studio/client", () => ({ mediaJson: (...args: unknown[]) => mediaJson(...args) }));

import {
  JUDGE_PASS_SCORE,
  judge,
  judgeMessages,
  parseVerdict,
  pickJudgeModel,
  verdictLine,
} from "../lib/studio/judge";

beforeEach(() => mediaJson.mockReset());

describe("what a judge is asked", () => {
  it("puts the intent next to each item and the pictures after the text", () => {
    const messages = judgeMessages({
      lens: "continuity",
      brief: "A rain-soaked chase.",
      invariants: ["Nera: green coat."],
      subjects: [
        { label: "Shot 1", intent: "Nera turns", imageDataUri: "data:image/png;base64,AA" },
        { label: "Shot 2", imageDataUri: "data:image/png;base64,BB" },
      ],
    });
    const user = messages[1] as { content: Array<Record<string, unknown>> };
    const text = String((user.content[0] as { text: string }).text);
    expect(text).toContain("Judge this on continuity.");
    expect(text).toContain("A rain-soaked chase.");
    expect(text).toContain("Must not have drifted: Nera: green coat.");
    expect(text).toContain("1. Shot 1 - meant to be: Nera turns");
    expect(text).toContain("2. Shot 2");
    expect(user.content.filter((part) => part.type === "image_url").length).toBe(2);
  });

  it("sends no picture for a subject that has none", () => {
    const messages = judgeMessages({ subjects: [{ label: "Shot 1" }] });
    const user = messages[1] as { content: Array<Record<string, unknown>> };
    expect(user.content.length).toBe(1);
  });
});

describe("reading a verdict", () => {
  it("finds the JSON inside whatever the model wrapped it in", () => {
    // Models wrap JSON in prose, in fences, in an apology. All three are the
    // normal case, not the exception.
    const wrapped = [
      "Sure! Here is my review:",
      "```json",
      '{"score": 8, "summary": "Holds up.", "weakest": [{"label": "Shot 3", "why": "coat reads blue"}]}',
      "```",
      "Let me know if you want more detail.",
    ].join("\n");
    const verdict = parseVerdict(wrapped);
    expect(verdict).toEqual({
      score: 8,
      passes: true,
      summary: "Holds up.",
      weakest: [{ label: "Shot 3", why: "coat reads blue" }],
    });
  });

  it("survives a brace inside a string", () => {
    const verdict = parseVerdict('{"score": 5, "summary": "the { is fine", "weakest": []}');
    expect(verdict?.summary).toBe("the { is fine");
  });

  it("decides passing here, not in the model's mood", () => {
    expect(parseVerdict(`{"score": ${JUDGE_PASS_SCORE}, "summary": "ok"}`)?.passes).toBe(true);
    expect(parseVerdict(`{"score": ${JUDGE_PASS_SCORE - 1}, "summary": "ok"}`)?.passes).toBe(false);
  });

  it("clamps a score outside the scale rather than trusting it", () => {
    expect(parseVerdict('{"score": 99, "summary": "ok"}')?.score).toBe(10);
    expect(parseVerdict('{"score": -4, "summary": "ok"}')?.score).toBe(0);
  });

  it("keeps at most three weaknesses, and drops the empty ones", () => {
    const verdict = parseVerdict(
      JSON.stringify({
        score: 4,
        summary: "Rough.",
        weakest: [
          { label: "a", why: "x" },
          { label: "b", why: "y" },
          { label: "c", why: "z" },
          { label: "d", why: "w" },
          {},
        ],
      }),
    );
    expect(verdict?.weakest.map((item) => item.label)).toEqual(["a", "b", "c"]);
  });

  it("has no opinion rather than crashing on nonsense", () => {
    expect(parseVerdict("I would rather not.")).toBeUndefined();
    expect(parseVerdict("{not json")).toBeUndefined();
    expect(parseVerdict("{}")).toBeUndefined();
  });
});

describe("running a judge", () => {
  it("returns the verdict when the model answers", async () => {
    mediaJson.mockResolvedValue({
      choices: [{ message: { content: '{"score": 9, "summary": "Good."}' } }],
    });
    const verdict = await judge({ subjects: [{ label: "Shot 1" }] }, "kimi-k3");
    expect(verdict?.passes).toBe(true);
  });

  it("never throws, whatever goes wrong", async () => {
    // A quality tool that can stop a paid production from finishing is a
    // liability. Every failure is "no opinion".
    mediaJson.mockRejectedValue(new Error("502"));
    await expect(judge({ subjects: [{ label: "Shot 1" }] }, "kimi-k3")).resolves.toBeUndefined();

    mediaJson.mockResolvedValue({ choices: [{ message: { content: "sorry" } }] });
    await expect(judge({ subjects: [{ label: "Shot 1" }] }, "kimi-k3")).resolves.toBeUndefined();
  });

  it("does not call anything when there is no model or nothing to look at", async () => {
    await expect(judge({ subjects: [{ label: "Shot 1" }] }, "")).resolves.toBeUndefined();
    await expect(judge({ subjects: [] }, "kimi-k3")).resolves.toBeUndefined();
    expect(mediaJson).not.toHaveBeenCalled();
  });
});

describe("verdictLine", () => {
  it("says the score, the summary and what is weak, in one line", () => {
    expect(
      verdictLine({
        score: 6,
        passes: false,
        summary: "Drifts.",
        weakest: [{ label: "Shot 3", why: "coat reads blue" }],
      }),
    ).toBe("6/10. Drifts. Shot 3: coat reads blue");
  });
});

describe("picking a judge", () => {
  const model = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: id,
    mediaType: "text" as const,
    offline: false,
    ...over,
  });

  it("only ever picks a model that can look at pictures", () => {
    // Handing images to a model that does not read them costs a call and
    // returns a confident opinion about nothing, which is worse than silence.
    expect(pickJudgeModel([model("blind"), model("seeing", { supportsVision: true })])).toBe(
      "seeing",
    );
    expect(pickJudgeModel([model("blind")])).toBeUndefined();
    expect(pickJudgeModel([])).toBeUndefined();
  });

  it("prefers the cheap tier: a supervisor's note is a short answer", () => {
    expect(
      pickJudgeModel([
        model("frontier-pro", { supportsVision: true }),
        model("kimi-k3-fast-api", { supportsVision: true }),
      ]),
    ).toBe("kimi-k3-fast-api");
  });

  it("will not pick a model that is offline, or one of the wrong type", () => {
    expect(
      pickJudgeModel([model("down", { supportsVision: true, offline: true })]),
    ).toBeUndefined();
    expect(
      pickJudgeModel([model("painter", { supportsVision: true, mediaType: "image" })]),
    ).toBeUndefined();
  });
});
