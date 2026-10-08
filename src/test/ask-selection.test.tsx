import { act, render, screen, waitFor } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComposerEditor,
  type ComposerEditorHandle,
} from "../components/agent/composer/ComposerEditor";
import { ChatComposer } from "../components/mobile/ChatComposer";
import {
  ASK_ABOUT_SELECTION_EVENT,
  askAboutSelection,
  MAX_QUOTE_CHARS,
  quoteSelection,
  takePendingQuote,
} from "../lib/ask-selection";

/**
 * "Ask Sub Rosa" on a selection: the passage reaches the chat as a quote,
 * exactly once, whether the composer was on screen or mounts afterwards.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "ios" }));
vi.mock("../lib/tauri", () => ({ mobileDictationStart: vi.fn(), mobileDictationStop: vi.fn() }));
vi.mock("../lib/haptics", () => ({
  hapticImpact: vi.fn(),
  hapticNotify: vi.fn(),
  hapticSelection: vi.fn(),
}));

afterEach(() => {
  takePendingQuote();
});

describe("quoting a selection", () => {
  it("quotes every line, keeps paragraph breaks, and leaves a line to type on", () => {
    expect(quoteSelection("First line\nsecond\n\n\n\nnext paragraph")).toBe(
      "> First line\n> second\n>\n> next paragraph\n\n",
    );
  });

  it("quotes nothing for an empty selection", () => {
    expect(quoteSelection("  \n ")).toBe("");
    askAboutSelection("   ");
    expect(takePendingQuote()).toBeNull();
  });

  it("cuts a quote past its bound", () => {
    const quote = quoteSelection("a".repeat(MAX_QUOTE_CHARS + 50));
    expect(quote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS + 4);
    expect(quote).toContain("…");
  });

  it("hands the quote over once", () => {
    const heard: unknown[] = [];
    const listener = (event: Event) => heard.push((event as CustomEvent).detail);
    window.addEventListener(ASK_ABOUT_SELECTION_EVENT, listener);
    askAboutSelection("Budget is 12k");
    window.removeEventListener(ASK_ABOUT_SELECTION_EVENT, listener);
    expect(heard).toEqual([{ quote: "> Budget is 12k\n\n" }]);
    expect(takePendingQuote()).toBe("> Budget is 12k\n\n");
    expect(takePendingQuote()).toBeNull();
  });
});

describe("the desktop composer", () => {
  it("takes a quote asked for before it mounted", async () => {
    askAboutSelection("Ship on Friday");
    const onChange = vi.fn();
    render(<ComposerEditor placeholder="Message" onChange={onChange} onSubmit={vi.fn()} />);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)?.[0]).toBe("> Ship on Friday\n\n");
    expect(takePendingQuote()).toBeNull();
  });

  it("puts a quote on top of what is already typed", async () => {
    const onChange = vi.fn();
    const ref = createRef<ComposerEditorHandle>();
    render(
      <ComposerEditor ref={ref} placeholder="Message" onChange={onChange} onSubmit={vi.fn()} />,
    );
    await screen.findByRole("textbox");
    act(() => {
      ref.current?.setContent("Is this right?", null, { focus: false });
    });
    act(() => {
      askAboutSelection("Line one");
    });
    await waitFor(() =>
      expect(onChange.mock.calls.at(-1)?.[0]).toBe("> Line one\n\nIs this right?"),
    );
  });
});

describe("the phone composer", () => {
  function Harness() {
    const [draft, setDraft] = useState("What does this mean?");
    return (
      <>
        <output data-testid="draft">{draft}</output>
        <ChatComposer
          draft={draft}
          onDraftChange={setDraft}
          attachments={[]}
          onAttachmentsChange={vi.fn()}
          placeholder="Ask"
          canSend
          onSend={vi.fn()}
          onError={vi.fn()}
        />
      </>
    );
  }

  it("puts the quote above the draft", async () => {
    render(<Harness />);
    act(() => {
      askAboutSelection("The figure was 40%");
    });
    await waitFor(() =>
      expect(screen.getByTestId("draft").textContent).toBe(
        "> The figure was 40%\n\nWhat does this mean?",
      ),
    );
  });
});
