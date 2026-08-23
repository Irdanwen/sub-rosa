import { describe, expect, it } from "vitest";
import { parseChapters, parseTimestamp, turnIdForTime } from "../lib/chapters";

describe("parseTimestamp", () => {
  it("reads both the hour and the minute forms", () => {
    expect(parseTimestamp("00:00")).toBe(0);
    expect(parseTimestamp("01:05")).toBe(65_000);
    expect(parseTimestamp("01:02:03")).toBe(3_723_000);
  });

  it("refuses anything that is not a clock", () => {
    // These are the shapes a model produces when it invents a label, and the
    // reason the app resolves markers itself (ADR-0027).
    expect(parseTimestamp("12")).toBeNull();
    expect(parseTimestamp("1:2:3:4")).toBeNull();
    expect(parseTimestamp("01:99")).toBeNull();
    expect(parseTimestamp("aa:bb")).toBeNull();
    expect(parseTimestamp("-1:00")).toBeNull();
  });
});

describe("parseChapters", () => {
  const summary = [
    "## [00:00] Opening",
    "He starts with the market.",
    "",
    "## [12:30] The pricing question",
    "They disagree about tiers.",
    "",
    "### [01:02:03] A digression on churn",
    "Worth keeping.",
  ].join("\n");

  it("reads the headings the summary wrote, in order", () => {
    const chapters = parseChapters(summary);

    expect(chapters.map((chapter) => chapter.title)).toEqual([
      "Opening",
      "The pricing question",
      "A digression on churn",
    ]);
    expect(chapters[1].startMs).toBe(750_000);
    expect(chapters[2].level).toBe(3);
  });

  it("leaves an ordinary heading alone rather than guessing at it", () => {
    const chapters = parseChapters("## Just a heading\n\n## [05:00] A chapter");

    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("A chapter");
  });

  it("ignores a heading inside a code fence, which is code", () => {
    const chapters = parseChapters(
      ["```markdown", "## [00:10] Not a chapter", "```", "## [00:20] A chapter"].join("\n"),
    );

    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("A chapter");
  });

  it("returns nothing for an untimed summary, rather than failing", () => {
    // A transcript with no turn bounds yields an untimed summary on purpose.
    expect(parseChapters("## Opening\nBody.\n\n## Closing\nBody.")).toEqual([]);
    expect(parseChapters(null)).toEqual([]);
    expect(parseChapters("")).toEqual([]);
  });

  it("skips a heading whose time is not a real clock", () => {
    expect(parseChapters("## [99:99:99] Nope")).toEqual([]);
  });
});

describe("turnIdForTime", () => {
  const turns = [
    { id: "a", startMs: 0 },
    { id: "b", startMs: 30_000 },
    { id: "c", startMs: 90_000 },
  ];

  it("lands on the first turn at or after the chapter", () => {
    expect(turnIdForTime(turns, 0)).toBe("a");
    expect(turnIdForTime(turns, 20_000)).toBe("b");
    expect(turnIdForTime(turns, 90_000)).toBe("c");
  });

  it("falls back to the last turn when the chapter is past every one", () => {
    expect(turnIdForTime(turns, 10_000_000)).toBe("c");
  });

  it("ignores turns with no time of their own", () => {
    const mixed = [
      { id: "untimed", startMs: null },
      { id: "timed", startMs: 5_000 },
    ];
    expect(turnIdForTime(mixed, 1_000)).toBe("timed");
  });

  it("has nothing to answer when no turn is timed", () => {
    expect(turnIdForTime([{ id: "x", startMs: null }], 1_000)).toBeNull();
    expect(turnIdForTime([], 0)).toBeNull();
  });
});
