import { describe, expect, it } from "vitest";

import {
  goalDispatchNoticeText,
  matchBuiltinComposerSlashCommands,
  parseBuiltinComposerSlashCommand,
  parseSlashFileArguments,
  parseSlashGoalArgument,
  resolveSlashModel,
  slashModelResolutionError,
} from "../lib/agent-composer-slash-commands";

describe("agent composer built-in slash commands", () => {
  it("parses reserved model and file commands", () => {
    expect(parseBuiltinComposerSlashCommand("/model kimi")).toEqual({
      name: "model",
      argument: "kimi",
    });
    expect(parseBuiltinComposerSlashCommand("  /file ./notes.md  ")).toEqual({
      name: "file",
      argument: "./notes.md",
    });
    expect(parseBuiltinComposerSlashCommand("/image a red bicycle")).toEqual({
      name: "image",
      argument: "a red bicycle",
    });
    expect(parseBuiltinComposerSlashCommand("/repo-build-pr fix it")).toBeNull();
    expect(parseBuiltinComposerSlashCommand("/Users/alex/Desktop/report.pdf summarize")).toBeNull();
  });

  it("parses the goal command", () => {
    expect(parseBuiltinComposerSlashCommand("/goal finish the comparison")).toEqual({
      name: "goal",
      argument: "finish the comparison",
    });
  });

  it("hides image generation from built-in slash suggestions", () => {
    expect(matchBuiltinComposerSlashCommands("")).toEqual([
      expect.objectContaining({ name: "model" }),
      expect.objectContaining({ name: "file" }),
      expect.objectContaining({ name: "goal" }),
    ]);
    expect(matchBuiltinComposerSlashCommands("image")).toEqual([]);
  });

  it("maps goal arguments to the runtime's subcommands", () => {
    expect(parseSlashGoalArgument("")).toEqual({ kind: "status" });
    expect(parseSlashGoalArgument("  Status ")).toEqual({ kind: "status" });
    expect(parseSlashGoalArgument("pause")).toEqual({ kind: "pause" });
    expect(parseSlashGoalArgument("resume")).toEqual({ kind: "resume" });
    // stop/done are the runtime's aliases of clear.
    expect(parseSlashGoalArgument("clear")).toEqual({ kind: "clear" });
    expect(parseSlashGoalArgument("STOP")).toEqual({ kind: "clear" });
    expect(parseSlashGoalArgument("done")).toEqual({ kind: "clear" });
    expect(parseSlashGoalArgument("run all 234 calls, then score them")).toEqual({
      kind: "set",
      goal: "run all 234 calls, then score them",
    });
    // A goal that merely starts with a verb is still a goal.
    expect(parseSlashGoalArgument("pause the pipeline after step 3")).toEqual({
      kind: "set",
      goal: "pause the pipeline after step 3",
    });
  });

  it("keeps only the first line of a goal dispatch result for the notice", () => {
    expect(
      goalDispatchNoticeText({
        type: "send",
        notice: "⊙ Goal set (20-turn budget): ship it\nI'll keep working until the goal is done.",
        message: "ship it",
      }),
    ).toBe("⊙ Goal set (20-turn budget): ship it");
    expect(goalDispatchNoticeText({ type: "exec", output: "✓ Goal cleared." })).toBe(
      "✓ Goal cleared.",
    );
    expect(goalDispatchNoticeText({})).toBe("Goal updated.");
  });

  it("parses quoted file paths", () => {
    expect(parseSlashFileArguments('"/Users/alex/Desktop/Q2 report.pdf" ./notes.md')).toEqual({
      status: "ok",
      paths: ["/Users/alex/Desktop/Q2 report.pdf", "./notes.md"],
    });
  });

  it("preserves quoted Windows file paths", () => {
    expect(parseSlashFileArguments('"C:\\Users\\alex\\Desktop\\Q2 report.pdf"')).toEqual({
      status: "ok",
      paths: ["C:\\Users\\alex\\Desktop\\Q2 report.pdf"],
    });
  });

  it("reports unmatched quotes without dropping the command", () => {
    expect(parseSlashFileArguments('"/Users/alex/Desktop/Q2 report.pdf')).toEqual({
      status: "error",
      message: "Could not parse /file paths. Close the quote and try again.",
    });
  });

  it("resolves model ids and friendly model names", () => {
    const models = [
      { id: "zai-org-glm-5-2", name: "GLM 5.2" },
      { id: "moonshotai-kimi-k2-6", name: "Kimi K2.6" },
    ];

    expect(resolveSlashModel("glm-5", models)).toEqual({
      status: "resolved",
      model: models[0],
    });
    expect(resolveSlashModel("moonshotai-kimi-k2-6", models)).toEqual({
      status: "resolved",
      model: models[1],
    });
  });

  it("reports ambiguous model aliases", () => {
    const resolution = resolveSlashModel("kimi", [
      { id: "provider-a-kimi", name: "Kimi base" },
      { id: "provider-b-kimi", name: "Kimi tuned" },
    ]);

    expect(resolution.status).toBe("ambiguous");
    if (resolution.status !== "resolved") {
      expect(slashModelResolutionError(resolution)).toBe(
        'Model "kimi" matches Kimi base, Kimi tuned. Type a longer name.',
      );
    }
  });
});
