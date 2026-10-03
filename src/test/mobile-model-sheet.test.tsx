/**
 * The shared model sheet, given the two things a long catalog needs beyond
 * search: a first cut by group, and one-word facts under each row.
 *
 * Both are opt-in. The chat opens the same sheet with neither, and must see
 * exactly what it saw before.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSheet } from "../components/mobile/ModelSheet";

vi.mock("../lib/haptics", () => ({ hapticSelection: vi.fn() }));

const ENTRIES = [
  {
    id: "kling-v3-4k",
    name: "Kling V3 4K",
    subtitle: "Premium",
    tags: [
      { label: "Text" },
      { label: "References" },
      { label: "+ opening frame", tone: "note" as const },
    ],
    groups: ["text", "reference"],
  },
  {
    id: "veo",
    name: "Veo",
    subtitle: "Premium",
    tags: [{ label: "Text" }],
    groups: ["text"],
  },
  {
    id: "seedance-2-5",
    name: "Seedance 2.5",
    subtitle: "Standard",
    tags: [{ label: "Text" }, { label: "Image" }, { label: "References" }],
    groups: ["text", "image", "reference"],
    keywords: ["r2v"],
  },
];

const FILTERS = [
  { id: "text", label: "From a prompt" },
  { id: "image", label: "Animate an image" },
  { id: "reference", label: "From references" },
];

/** The model names on screen, in list order. */
function rowNames(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((item) => item.querySelector(".mobile-sheet-item-title")?.textContent ?? "")
    .filter(Boolean);
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("the model sheet's filters and tags", () => {
  it("shows each row's tags, the note tone marked apart", () => {
    render(
      <ModelSheet
        title="Video model"
        entries={ENTRIES}
        selectedId="veo"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const kling = screen.getByRole("button", { name: /Kling V3 4K/ });
    expect(within(kling).getByText("References")).toBeTruthy();
    const note = within(kling).getByText("+ opening frame");
    expect(note.getAttribute("data-tone")).toBe("note");
    // No filter row was asked for, so none is there.
    expect(screen.queryByRole("group", { name: "Filter models" })).toBeNull();
  });

  it("narrows the list to one group, and back to all", async () => {
    render(
      <ModelSheet
        title="Video model"
        entries={ENTRIES}
        selectedId="veo"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        filters={FILTERS}
        filtersLabel="Filter video models"
      />,
    );
    const group = screen.getByRole("group", { name: "Filter video models" });
    expect(within(group).getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await userEvent.click(within(group).getByRole("button", { name: "From references" }));
    expect(screen.queryByRole("button", { name: /^Veo/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Kling V3 4K/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Seedance 2.5/ })).toBeTruthy();
    await userEvent.click(within(group).getByRole("button", { name: "Animate an image" }));
    expect(rowNames()).toEqual(["Seedance 2.5"]);
    await userEvent.click(within(group).getByRole("button", { name: "All" }));
    expect(screen.getByRole("button", { name: /^Veo/ })).toBeTruthy();
  });

  it("opens on the filter the surface asked for, and searches within it", async () => {
    render(
      <ModelSheet
        title="Video model"
        entries={ENTRIES}
        selectedId="veo"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        filters={FILTERS}
        initialFilter="reference"
      />,
    );
    expect(
      screen.getByRole("button", { name: "From references" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: /^Veo/ })).toBeNull();
    await userEvent.type(screen.getByPlaceholderText("Search models"), "seedance");
    expect(screen.queryByRole("button", { name: /Kling V3 4K/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Seedance 2.5/ })).toBeTruthy();
  });

  it("ignores an initial filter that is not offered", () => {
    render(
      <ModelSheet
        title="Video model"
        entries={ENTRIES}
        selectedId="veo"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        filters={FILTERS}
        initialFilter="video"
      />,
    );
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("finds a row by one of its tags", async () => {
    render(
      <ModelSheet
        title="Video model"
        entries={ENTRIES}
        selectedId="veo"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText("Search models"), "opening frame");
    expect(screen.getByRole("button", { name: /Kling V3 4K/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Veo/ })).toBeNull();
  });
});
