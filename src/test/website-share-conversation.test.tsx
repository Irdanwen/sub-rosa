import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { splitChatBlocks } from "../../website/src/lib/chat-blocks";
import { isSharedDocument } from "../../website/src/lib/share";
import { ConversationReader } from "../../website/src/pages/share";

const places = [
  "Two cafés nearby:",
  "```subrosa:places",
  JSON.stringify({
    v: 1,
    title: "Cafés",
    attribution: "osm",
    places: [
      { name: "Café Rose", lat: 46.2, lng: 6.1, address: "1 rue du Lac", rating: 4.5, reviews: 12 },
      { name: "<img src=x onerror=alert(1)>", lat: 46.2, lng: 6.1 },
    ],
  }),
  "```",
  "Enjoy.",
].join("\n");

const links = [
  "```subrosa:links",
  JSON.stringify({
    v: 1,
    links: [
      { title: "Lake guide", url: "https://example.org/lake" },
      { title: "Sneaky", url: "javascript:alert(1)" },
    ],
  }),
  "```",
].join("\n");

describe("a shared conversation on the website", () => {
  it("accepts a conversation of user and assistant turns, and nothing else", () => {
    const base = { v: 1, title: "Trip", body: "", shared_at: "2026-10-07T10:00:00Z" };
    expect(
      isSharedDocument({
        ...base,
        kind: "conversation",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).toBe(true);
    expect(isSharedDocument({ ...base, kind: "note", body: "text" })).toBe(true);
    expect(
      isSharedDocument({
        ...base,
        kind: "conversation",
        messages: [{ role: "system", content: "rules" }],
      }),
    ).toBe(false);
    expect(isSharedDocument({ ...base, kind: "conversation", messages: [] })).toBe(false);
    expect(isSharedDocument({ ...base, kind: "recording" })).toBe(false);
  });

  it("keeps prose and chat blocks apart, in order", () => {
    const parts = splitChatBlocks(places);
    expect(parts.map((part) => part.kind)).toEqual(["text", "block", "text"]);
    expect(parts[1]).toMatchObject({ kind: "block", name: "places" });
  });

  it("renders turns as bubbles and chat blocks as plain readable lists", () => {
    const { container } = render(
      <ConversationReader
        messages={[
          { role: "user", content: "Where can I get a coffee by the lake?" },
          { role: "assistant", content: places },
          { role: "assistant", content: links },
          { role: "assistant", content: '```subrosa:media\n{"v":1}\n```' },
        ]}
      />,
    );
    const turns = screen.getAllByRole("listitem").filter((item) => item.matches(".share-turn"));
    expect(turns).toHaveLength(4);
    expect(turns[0]).toHaveAttribute("data-role", "user");
    expect(turns[1]).toHaveAttribute("data-role", "assistant");

    const cafés = within(turns[1]).getByRole("heading", { name: "Cafés" });
    expect(cafés).toBeInTheDocument();
    expect(within(turns[1]).getByText("Café Rose")).toBeInTheDocument();
    expect(within(turns[1]).getByText(/1 rue du Lac/)).toBeInTheDocument();
    expect(within(turns[1]).getByText("Enjoy.")).toBeInTheDocument();
    // A value is text, never markup.
    expect(container.querySelector("img")).toBeNull();
    expect(within(turns[1]).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();

    // Only a web link becomes a link.
    expect(within(turns[2]).getByRole("link", { name: "Lake guide" })).toHaveAttribute(
      "href",
      "https://example.org/lake",
    );
    expect(within(turns[2]).queryByRole("link", { name: "Sneaky" })).toBeNull();

    // What only the app can show is named, not dropped silently.
    expect(within(turns[3]).getByText(/only the app can display/)).toBeInTheDocument();
    // No raw JSON reaches the page.
    expect(container.textContent).not.toContain('"places"');
  });
});
