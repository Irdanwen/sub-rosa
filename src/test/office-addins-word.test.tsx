import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WordApi, WordContext, WordRange } from "../../office-addins/src/word/host";
import { wordHost, wordText } from "../../office-addins/src/word/host";
import { WordPane } from "../../office-addins/src/word/WordPane";
import { fill, OFFICE } from "../../office-addins/src/words";
import { fakeEngine, lastUser } from "./office-addins-fakes";
import { text } from "./website-client-fakes";

/** A Word whose document is one selection, with every insertion recorded. */
function fakeWord(initial: string) {
  const state = { selection: initial, inserted: [] as [string, string][] };
  const word: WordApi = {
    async run(batch) {
      const range: WordRange = {
        text: "",
        load() {
          range.text = state.selection;
        },
        insertText(value, location) {
          state.inserted.push([value, location]);
          return range;
        },
      };
      const context: WordContext = {
        document: { getSelection: () => range },
        sync: async () => undefined,
      };
      return batch(context);
    },
  };
  return { word, state };
}

describe("the Word adapter", () => {
  it("reads the selection and replaces it only while it is the same passage", async () => {
    const { word, state } = fakeWord("old text");
    const host = wordHost(word);
    expect(await host.readSelection()).toBe("old text");
    state.selection = "edited since";
    expect(await host.replaceSelection("old text", "new")).toBe("changed");
    expect(state.inserted).toEqual([]);
    state.selection = "old text";
    expect(await host.replaceSelection("old text", "new")).toBe("replaced");
    expect(state.inserted).toEqual([["new", "Replace"]]);
  });

  it("inserts at the cursor, or after a selection", async () => {
    const { word, state } = fakeWord("");
    await wordHost(word).insert("Draft");
    state.selection = "chosen";
    await wordHost(word).insert("More");
    expect(state.inserted).toEqual([
      ["Draft", "End"],
      ["More", "After"],
    ]);
  });

  it("turns blank lines into single paragraph breaks", () => {
    expect(wordText("One.\n\nTwo.\r\n\r\n\r\nThree.")).toBe("One.\nTwo.\nThree.");
  });
});

describe("the Word pane", () => {
  it("proposes a rewrite with the note editor's words and replaces only on confirmation", async () => {
    const { word, state } = fakeWord("teh passage");
    const { engine, calls } = fakeEngine(() => text("the passage"));
    render(<WordPane host={wordHost(word)} engine={engine} language="en-US" />);
    await userEvent.click(screen.getByRole("button", { name: "Correct" }));
    await screen.findByText("the passage");
    const body = calls[0].body;
    expect((body.messages as { content: string }[])[0].content).toBe(OFFICE.rewrite.system);
    expect(lastUser(body)).toBe(fill(OFFICE.rewrite.messages.correct, { text: "teh passage" }));
    expect(body.temperature).toBe(OFFICE.rewrite.temperature);
    // Proposed, not applied.
    expect(state.inserted).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Replace the selection" }));
    await waitFor(() => expect(state.inserted).toEqual([["the passage", "Replace"]]));
  });

  it("says so when the selection moved before the person confirmed", async () => {
    const { word, state } = fakeWord("first");
    const { engine } = fakeEngine(() => text("First."));
    render(<WordPane host={wordHost(word)} engine={engine} language="en-US" />);
    await userEvent.click(screen.getByRole("button", { name: "Rewrite" }));
    await screen.findByText("First.");
    state.selection = "something else";
    await userEvent.click(screen.getByRole("button", { name: "Replace the selection" }));
    await screen.findByText(/The selection changed/);
    expect(state.inserted).toEqual([]);
  });

  it("translates into the chosen language and drafts at the cursor through the agent turn", async () => {
    const { word, state } = fakeWord("Bonjour");
    const { engine, calls } = fakeEngine((body) =>
      lastUser(body).includes("Translate") ? text("Hello") : text("A draft paragraph."),
    );
    render(<WordPane host={wordHost(word)} engine={engine} language="fr-FR" />);
    await userEvent.selectOptions(screen.getByRole("combobox"), "en");
    await userEvent.click(screen.getByRole("button", { name: "Translate" }));
    await screen.findByText("Hello");
    expect(lastUser(calls[0].body)).toContain("Translate the passage into English.");
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));

    await userEvent.click(screen.getByRole("tab", { name: "Draft" }));
    await userEvent.type(screen.getByRole("textbox"), "An opening line");
    await userEvent.click(screen.getByRole("button", { name: "Draft" }));
    await screen.findByText("A draft paragraph.");
    const draft = calls[1].body;
    const system = (draft.messages as { content: string }[])[0].content;
    expect(system).toContain(OFFICE.word.draft);
    expect(lastUser(draft)).toContain("<context>\nBonjour\n</context>");
    // The draft turn offers the web tools and nothing that reads the account.
    const tools = (draft.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(tools.sort()).toEqual(["fetch_page", "web_search"]);
    expect(state.inserted).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Insert at the cursor" }));
    await waitFor(() => expect(state.inserted).toEqual([["A draft paragraph.", "After"]]));
  });

  it("refuses an empty selection without calling the model", async () => {
    const { word } = fakeWord("");
    const { engine, calls } = fakeEngine(() => text("x"));
    render(<WordPane host={wordHost(word)} engine={engine} language="en-US" />);
    await userEvent.click(screen.getByRole("button", { name: "Shorten" }));
    await screen.findByText("Select some text first.");
    expect(calls).toEqual([]);
    vi.restoreAllMocks();
  });
});
