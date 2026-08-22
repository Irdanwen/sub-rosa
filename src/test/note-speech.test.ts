import { describe, expect, it } from "vitest";
import { speakableText } from "../lib/note-speech";

describe("what a note sounds like", () => {
  it("turns a generated note into sentences a voice can read", () => {
    const note = [
      "# Decisions",
      "",
      "- The **rollout** slips a week, per [the plan](https://example.com/plan).",
      "- Marie owns the `migration` script.",
      "",
      "## Follow-ups",
      "1. Ana sends the numbers.",
    ].join("\n");
    expect(speakableText(note)).toBe(
      [
        "Decisions.",
        "The rollout slips a week, per the plan.",
        "Marie owns the migration script.",
        "Follow-ups.",
        "Ana sends the numbers.",
      ].join("\n"),
    );
  });

  it("drops what reads as gibberish out loud", () => {
    const note = [
      "| Column | Value |",
      "| --- | --- |",
      "| Alpha | 1 |",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "---",
      "",
      "Only this line survives.",
    ].join("\n");
    expect(speakableText(note)).toBe("Only this line survives.");
  });

  it("caps what one press of play can cost, and says nothing for an empty note", () => {
    // Speech is billed per character; an accidental novel must not be read.
    const long = speakableText("word ".repeat(5_000));
    expect(long.length).toBeLessThanOrEqual(4_001);
    expect(long.endsWith("…")).toBe(true);
    expect(speakableText("")).toBe("");
    expect(speakableText("# Heading only\n\n```\ncode\n```")).toBe("Heading only.");
  });
});
