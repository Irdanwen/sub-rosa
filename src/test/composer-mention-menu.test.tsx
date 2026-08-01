import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  ComposerEditor,
  type ComposerEditorHandle,
} from "../components/agent/composer/ComposerEditor";
import type { ComposerMentionItem } from "../lib/agent-mentions";
import { promptWithMentions } from "../lib/agent-mentions";

const ITEMS: ComposerMentionItem[] = [
  { kind: "file", label: "report.md", detail: "notes/report.md", path: "/root/notes/report.md" },
  { kind: "note", label: "Team sync", detail: "Note", noteId: "note-7" },
];

function renderComposer(onChange = vi.fn()) {
  const ref = createRef<ComposerEditorHandle>();
  render(
    <div className="agent-composer-box">
      <ComposerEditor
        ref={ref}
        placeholder="Message Sub Rosa"
        mentionItems={async (query) =>
          ITEMS.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()))
        }
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    </div>,
  );
  return { ref, onChange };
}

describe("composer mention menu", () => {
  it("turns a picked file into a chip that reads as prose and resolves to a path", async () => {
    const user = userEvent.setup();
    const { ref, onChange } = renderComposer();

    const editor = await screen.findByRole("textbox");
    await user.click(editor);
    await user.keyboard("Summarize @rep");

    const option = await screen.findByRole("option", { name: /report\.md/ });
    await user.click(option);

    await waitFor(() => {
      // The message still reads like a sentence: the chip serializes to
      // "@report.md", not to a path dumped mid-prose.
      const [text] = onChange.mock.calls.at(-1) ?? [];
      expect(text).toContain("Summarize @report.md");
      expect(text).not.toContain("/root/notes/report.md");
    });

    // The path travels with the mention, and only reaches the agent through
    // the reference block appended at send time.
    const mentions = ref.current?.mentions() ?? [];
    expect(mentions).toEqual([{ kind: "file", label: "report.md", path: "/root/notes/report.md" }]);
    expect(promptWithMentions("Summarize @report.md", mentions)).toContain("/root/notes/report.md");
  });

  it("mentions a note by id rather than by path", async () => {
    const user = userEvent.setup();
    const { ref } = renderComposer();

    const editor = await screen.findByRole("textbox");
    await user.click(editor);
    await user.keyboard("@Team");
    await user.click(await screen.findByRole("option", { name: /Team sync/ }));

    await waitFor(() => {
      expect(ref.current?.mentions()).toEqual([
        { kind: "note", label: "Team sync", noteId: "note-7" },
      ]);
    });
  });

  it("does not open the palette for an email address", async () => {
    const user = userEvent.setup();
    renderComposer();

    const editor = await screen.findByRole("textbox");
    await user.click(editor);
    // "@" glued to the end of a word is an address, not a mention trigger.
    await user.keyboard("write to me@example");

    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
