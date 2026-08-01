import { describe, expect, it } from "vitest";
import {
  composerMentionItems,
  promptWithMentions,
  stripMentionPromptBlock,
  type ComposerMention,
} from "../lib/agent-mentions";
import { displayedComposerUserMessageText } from "../lib/agent-chat-runtime";

const FILE_MENTION: ComposerMention = {
  kind: "file",
  label: "report.md",
  path: "/Users/me/work/report.md",
};

describe("promptWithMentions", () => {
  it("resolves each mention to something the agent can act on", () => {
    const prompt = promptWithMentions("Summarize @report.md", [FILE_MENTION]);
    // The sentence the user wrote survives verbatim at the top.
    expect(prompt.startsWith("Summarize @report.md")).toBe(true);
    // The path is absolute: the agent opens the real file, in place.
    expect(prompt).toContain('- File "report.md": /Users/me/work/report.md');
    // The mention carries a reference, never the file's content — inlining it
    // would blow the context on a large document and pin a stale copy.
    expect(prompt).not.toContain("```");
  });

  it("distinguishes a folder and a note from a file", () => {
    const prompt = promptWithMentions("Tidy these", [
      { kind: "folder", label: "reports", path: "/Users/me/work/reports" },
      { kind: "note", label: "Team sync", noteId: "note-7" },
    ]);
    expect(prompt).toContain('- Folder "reports": /Users/me/work/reports');
    // A note is not a path: the agent needs the id and the tool that reads it.
    expect(prompt).toContain('- Note "Team sync" (note id note-7)');
    expect(prompt).toContain("get_note");
  });

  it("leaves a message with no mentions untouched", () => {
    expect(promptWithMentions("Just a message", [])).toBe("Just a message");
  });

  it("stands in for an empty message", () => {
    // Sending only a mention is a legitimate ask ("this file, please").
    expect(promptWithMentions("", [FILE_MENTION])).toContain("Use the mentioned document(s).");
  });
});

describe("stripMentionPromptBlock", () => {
  it("hides the resolved block so the transcript shows what was typed", () => {
    const prompt = promptWithMentions("Summarize @report.md", [FILE_MENTION]);
    expect(stripMentionPromptBlock(prompt)).toBe("Summarize @report.md");
    // Also through the composer's display pipeline, which is what the
    // transcript actually calls.
    expect(displayedComposerUserMessageText(prompt)).toBe("Summarize @report.md");
  });

  it("leaves ordinary messages alone, including ones that mention a path", () => {
    const message = "Look at /Users/me/work/report.md and tell me what you think";
    expect(stripMentionPromptBlock(message)).toBe(message);
  });
});

describe("composerMentionItems", () => {
  const entries = [
    {
      name: "report.md",
      relativePath: "report.md",
      path: "/root/report.md",
      kind: "file" as const,
    },
    {
      name: "draft.md",
      relativePath: "notes/draft.md",
      path: "/root/notes/draft.md",
      kind: "file" as const,
    },
  ];

  it("offers files, then notes, with the location as secondary text", async () => {
    const items = await composerMentionItems({
      query: "",
      listEntries: async () => entries,
      listNotes: async () => [{ id: "note-1", title: "Team sync" }],
    });

    expect(items.map((item) => item.label)).toEqual(["report.md", "draft.md", "Team sync"]);
    // A file at the root has no location worth repeating; a nested one does.
    expect(items[0]?.detail).toBeUndefined();
    expect(items[1]?.detail).toBe("notes/draft.md");
    expect(items[2]).toMatchObject({ kind: "note", noteId: "note-1" });
  });

  it("filters notes by the typed query", async () => {
    const items = await composerMentionItems({
      query: "sync",
      listEntries: async () => [],
      listNotes: async () => [
        { id: "note-1", title: "Team sync" },
        { id: "note-2", title: "Budget" },
      ],
    });
    expect(items.map((item) => item.label)).toEqual(["Team sync"]);
  });

  it("still lists what worked when one source fails", async () => {
    // No session root yet, or a notes store that errors: the palette degrades
    // rather than showing nothing.
    const withoutFiles = await composerMentionItems({
      query: "",
      listEntries: async () => {
        throw new Error("no root");
      },
      listNotes: async () => [{ id: "note-1", title: "Team sync" }],
    });
    expect(withoutFiles.map((item) => item.label)).toEqual(["Team sync"]);

    const withoutNotes = await composerMentionItems({
      query: "",
      listEntries: async () => entries,
      listNotes: async () => {
        throw new Error("db locked");
      },
    });
    expect(withoutNotes.map((item) => item.label)).toEqual(["report.md", "draft.md"]);
  });
});
