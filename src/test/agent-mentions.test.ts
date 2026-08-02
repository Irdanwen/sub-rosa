import { describe, expect, it } from "vitest";
import {
  composerMentionItems,
  isImageMention,
  promptWithMentions,
  stripMentionPromptBlock,
  type ComposerMention,
} from "../lib/agent-mentions";
import { displayedComposerUserMessageText } from "../lib/agent-chat-runtime";
import { mentionedImageAttachments } from "../components/agent/AgentWorkspace";
import { pendingImageAttachments } from "../lib/hermes-image-attach";

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
    // The path is absolute: the agent opens the real file, in place. Quoted as
    // inline code so the runtime reads a name, not a file to attach.
    expect(prompt).toContain('- File "report.md": `/Users/me/work/report.md`');
    // The mention carries a reference, never the file's content — inlining it
    // would blow the context on a large document and pin a stale copy.
    expect(prompt).not.toContain("```");
  });

  it("distinguishes a folder and a note from a file", () => {
    const prompt = promptWithMentions("Tidy these", [
      { kind: "folder", label: "reports", path: "/Users/me/work/reports" },
      { kind: "note", label: "Team sync", noteId: "note-7" },
    ]);
    expect(prompt).toContain('- Folder "reports": `/Users/me/work/reports`');
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

describe("image mentions", () => {
  it("recognizes the image extensions the runtime can look at", () => {
    for (const path of ["/w/shot.png", "/w/a.JPG", "/w/b.jpeg", "/w/c.webp", "/w/d.heic"]) {
      expect(isImageMention({ kind: "file", label: "x", path })).toBe(true);
    }
    // Everything else is a document the agent opens with its file tools.
    for (const path of ["/w/report.md", "/w/data.csv", "/w/deck.pdf", "/w/clip.mp4"]) {
      expect(isImageMention({ kind: "file", label: "x", path })).toBe(false);
    }
    // A folder or a note is never an image, whatever it is called.
    expect(isImageMention({ kind: "folder", label: "shots.png", path: "/w/shots.png" })).toBe(
      false,
    );
    expect(isImageMention({ kind: "note", label: "Screenshot", noteId: "n-1" })).toBe(false);
  });

  it("tells the agent the picture is on the turn, not somewhere to go open", () => {
    // The reported failure: handed only a path, the agent never tried to look
    // at the image and asked the user to describe it instead.
    const prompt = promptWithMentions("voilà les images @shot.png", [
      { kind: "file", label: "shot.png", path: "/w/shot.png" },
    ]);
    expect(prompt).toContain('- Image "shot.png": attached to this message, look at it directly.');
    expect(prompt).toContain("/w/shot.png");
    // A non-image mention keeps the plain reference wording.
    expect(promptWithMentions("x", [FILE_MENTION])).toContain('- File "report.md":');
  });
});

/**
 * Mirrors the pinned runtime's `extract_image_refs`: bare absolute paths ending
 * in an image extension are attached to the turn AT NATIVE SIZE, except where
 * they sit inside inline code. Returns what the runtime would re-attach.
 */
function runtimeWouldReattach(prompt: string): string[] {
  const IMAGE_PATH =
    /(?<![/:\w.])(?:~\/|\/)(?:[\w.-]+\/)*[\w.-]+\.(?:png|jpe?g|gif|webp|bmp|tiff?)\b/gi;
  const codeSpans = [...prompt.matchAll(/`[^`\n]+`/g)].map(
    (match) => [match.index ?? 0, (match.index ?? 0) + match[0].length] as const,
  );
  return [...prompt.matchAll(IMAGE_PATH)]
    .filter((match) => {
      const at = match.index ?? 0;
      return !codeSpans.some(([start, end]) => start <= at && at < end);
    })
    .map((match) => match[0]);
}

describe("paths the runtime must not mistake for attachments", () => {
  // The reported failure: a mentioned image is already attached to the turn,
  // resized to fit the request. Naming its path in the open made the runtime
  // attach the ORIGINAL a second time at native size, and two ordinary
  // screenshots (2.4 MB each) put the request 7 MB over the wire caps.
  const IMAGE: ComposerMention = {
    kind: "file",
    label: "1img1.png",
    // No spaces: a real working folder, unlike the app-support path whose
    // spaces happen to break the runtime's regex. Do not "simplify" this.
    path: "/Users/morgan/Documents/SubRosa/Film_1/1img1.png",
  };

  it("proves the regression check can actually fail", () => {
    // Guard the guard: the same line without backticks IS re-attached.
    expect(runtimeWouldReattach(`- Image "1img1.png": attached. Saved at ${IMAGE.path}.`)).toEqual([
      IMAGE.path,
    ]);
  });

  it("never leaves a bare image path in the prompt", () => {
    const prompt = promptWithMentions("Vois tu ces images ?", [IMAGE]);
    expect(runtimeWouldReattach(prompt)).toEqual([]);
    // The path is still there for the agent to use, just quoted.
    expect(prompt).toContain(`\`${IMAGE.path}\``);
  });

  it("quotes a non-image path too, so no extension is one runtime change away", () => {
    const prompt = promptWithMentions("Tidy these", [
      { kind: "file", label: "report.md", path: "/Users/morgan/work/report.md" },
      { kind: "folder", label: "shots", path: "/Users/morgan/work/shots" },
    ]);
    expect(prompt).toContain("`/Users/morgan/work/report.md`");
    expect(prompt).toContain("`/Users/morgan/work/shots`");
  });

  it("cannot be broken out of by a filename containing a backtick", () => {
    const prompt = promptWithMentions("x", [
      { kind: "file", label: "odd.png", path: "/Users/morgan/a`b/odd.png" },
    ]);
    expect(runtimeWouldReattach(prompt)).toEqual([]);
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

describe("mentionedImageAttachments", () => {
  it("makes a mentioned image an image attachment the send will carry", () => {
    const attachments = mentionedImageAttachments([
      { kind: "file", label: "shot.png", path: "/w/shot.png" },
      { kind: "file", label: "report.md", path: "/w/report.md" },
      { kind: "note", label: "Team sync", noteId: "n-1" },
    ]);

    // Only the image: a document and a note stay plain references.
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      name: "shot.png",
      // Points at where the file already lives — a mention copies nothing.
      path: "/w/shot.png",
    });
    // `kind: "image"` + `status: "imported"` is what makes the send pick it up
    // for image.attach_bytes (see pendingImageAttachments).
    expect(attachments[0]?.attach).toMatchObject({
      kind: "image",
      status: "imported",
      workspacePath: "/w/shot.png",
    });
    expect(pendingImageAttachments(attachments.map((item) => item.attach))).toHaveLength(1);
  });
});
