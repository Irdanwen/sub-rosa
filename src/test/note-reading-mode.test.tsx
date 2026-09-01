import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotePreview } from "../components/note-editor/NotePreview";

/**
 * Reading mode is presentation and nothing else.
 *
 * The point of ADR-0037 is that the file decides what the surface may offer.
 * Reading mode offers nothing new: it is a column width, a face and a line
 * height, so the document that comes out has to be byte-for-byte the document
 * that went in. That is what this asserts, along with the one behavioural
 * change it does make -- the caret is put away, because a mode called reading
 * that you can type into is two modes sharing a name.
 */

vi.mock("../lib/mobile", () => ({ isMobilePlatform: () => false }));

afterEach(() => vi.restoreAllMocks());

const MARKDOWN = [
  "# Séance avec les TPG",
  "",
  "Du texte avec du **gras** et un [lien](https://example.com).",
  "",
  "- une puce",
  "- une autre",
  "",
  "> Une citation.",
  "",
  "```sh",
  "curl -s https://example.com | jq .",
  "```",
].join("\n");

function mount(editable: boolean) {
  const onChange = vi.fn();
  const view = render(
    <NotePreview noteId="n1" markdown={MARKDOWN} onChange={onChange} editable={editable} />,
  );
  const body = view.container.querySelector(".note-preview") as HTMLElement;
  return { view, body, onChange };
}

describe("reading a note", () => {
  it("puts the caret away", () => {
    const { body } = mount(false);

    expect(body.getAttribute("contenteditable")).toBe("false");
  });

  it("hands the caret back", () => {
    const { body } = mount(true);

    expect(body.getAttribute("contenteditable")).toBe("true");
  });

  it("renders the same document either way", () => {
    // Every block the note can hold, so a mode that quietly dropped one would
    // show up here rather than in somebody's note.
    const reading = mount(false);
    const writing = mount(true);

    const shape = (root: HTMLElement) =>
      [...root.querySelectorAll("h1, p, ul, li, blockquote, pre, a, strong")]
        .map((node) => `${node.tagName}:${node.textContent}`)
        .join("|");

    expect(shape(reading.body)).toBe(shape(writing.body));
  });

  it("never writes to the note just by being read", () => {
    const { body, onChange } = mount(false);

    fireEvent.blur(body);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("switches modes without rebuilding the document", () => {
    const onChange = vi.fn();
    const view = render(
      <NotePreview noteId="n1" markdown={MARKDOWN} onChange={onChange} editable />,
    );
    const before = view.container.querySelector(".note-preview")?.innerHTML;

    view.rerender(
      <NotePreview noteId="n1" markdown={MARKDOWN} onChange={onChange} editable={false} />,
    );
    const body = view.container.querySelector(".note-preview") as HTMLElement;

    // Same nodes, only the switch flipped: a rebuild here would throw away the
    // undo history for what is a change of presentation.
    expect(body.innerHTML).toBe(before);
    expect(body.getAttribute("contenteditable")).toBe("false");
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});
