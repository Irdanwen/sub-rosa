// What a reply sounds like when it is read aloud, and how it is cut so the
// first words play fast (src/lib/speakable-text.ts).

import { afterEach, describe, expect, it } from "vitest";
import { applyLocale } from "../lib/i18n";
import {
  MAX_SPOKEN_REPLY_CHARS,
  speakableMarkdown,
  speakableReply,
  speechChunks,
} from "../lib/speakable-text";

afterEach(() => applyLocale("en"));

describe("a reply read aloud", () => {
  it("reads the prose and none of the markup", () => {
    const reply = [
      "## Plan",
      "",
      "Here is **the plan**, see [the doc](https://example.com/doc).",
      "",
      "1. Book the `train`",
      "- Pack ~~light~~ warm",
      "> Bring an umbrella",
      "![map](https://example.com/map.png)",
    ].join("\n");
    expect(speakableReply(reply)).toBe(
      [
        "Plan.",
        "Here is the plan, see the doc.",
        "Book the train",
        "Pack light warm",
        "Bring an umbrella",
      ].join("\n"),
    );
  });

  it("names a card or a code block instead of reading it", () => {
    const reply = [
      "Three places nearby:",
      "```subrosa:places",
      '{"v":1,"places":[{"name":"Le Bouchon"}]}',
      "```",
      "And the sources:",
      "```subrosa:links",
      '{"v":1,"links":[]}',
      "```",
      "```ts",
      "const a = 1;",
      "```",
      "```subrosa:proposal",
      "{}",
      "```",
    ].join("\n");
    expect(speakableReply(reply)).toBe(
      [
        "Three places nearby:",
        "There are places here.",
        "And the sources:",
        "There are links here.",
        "There is some code here.",
        "There is a card here.",
      ].join("\n"),
    );
    applyLocale("fr");
    expect(speakableReply("```subrosa:notes\n{}\n```")).toBe("Il y a des notes ici.");
  });

  it("reads a table by its cells and skips the separator row", () => {
    const table = ["| City | Price |", "| --- | :-: |", "| Lyon | 12 € |"].join("\n");
    expect(speakableReply(table)).toBe("City, Price.\nLyon, 12 €.");
    // A note's recap still drops tables and code entirely.
    expect(speakableMarkdown(`${table}\n\n\`\`\`\ncode\n\`\`\`\nDone`)).toBe("Done");
  });

  it("caps what one press can cost", () => {
    const spoken = speakableReply("word ".repeat(10_000));
    expect(spoken.length).toBeLessThanOrEqual(MAX_SPOKEN_REPLY_CHARS + 1);
    expect(spoken.endsWith("…")).toBe(true);
    expect(speakableReply("```\nonly code\n```")).toBe("There is some code here.");
    expect(speakableReply("   ")).toBe("");
  });
});

describe("speech chunks", () => {
  const prose = Array.from(
    { length: 60 },
    (_, index) => `Sentence number ${index + 1} says a little more than nothing.`,
  ).join(" ");

  it("starts with a short chunk and keeps every word, in order", () => {
    const chunks = speechChunks(prose, { first: 120, rest: 600 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].length).toBeLessThanOrEqual(120);
    for (const chunk of chunks.slice(1)) expect(chunk.length).toBeLessThanOrEqual(600);
    expect(chunks.join(" ")).toBe(prose);
    // Cut at sentence ends, never mid-sentence.
    for (const chunk of chunks) expect(chunk.endsWith(".")).toBe(true);
  });

  it("cuts a sentence longer than a chunk at a space", () => {
    const long = "lorem ".repeat(300).trim();
    const chunks = speechChunks(long, { first: 100, rest: 400 });
    expect(chunks.every((chunk) => chunk.length <= 400 && chunk.length > 0)).toBe(true);
    expect(chunks.every((chunk) => !chunk.startsWith(" ") && !chunk.endsWith(" "))).toBe(true);
    expect(chunks.join(" ")).toBe(long);
  });

  it("treats a line break as a sentence end and says nothing for nothing", () => {
    expect(speechChunks("Plan.\nBook the train\nPack", { first: 12, rest: 100 })).toEqual([
      "Plan.",
      "Book the train Pack",
    ]);
    expect(speechChunks("")).toEqual([]);
  });
});
