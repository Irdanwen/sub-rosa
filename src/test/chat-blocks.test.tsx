import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn(async (command: string, _args?: unknown) => {
  if (command === "render_map_card") {
    return { dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
  }
  if (command === "places_photo_data_url") {
    return { dataUrl: "data:image/jpeg;base64,/9j/photo" };
  }
  return undefined;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

import {
  chatBlockKindOf,
  chatBlocksToClipboardText,
  parseChatBlock,
  resolveChatBlockFence,
} from "../lib/chat-blocks";
import { SimpleMarkdown } from "../lib/simple-markdown";

const LINKS_BODY = JSON.stringify({
  v: 1,
  title: "Sources",
  links: [
    { title: "Alpha", url: "https://www.example.com/a", snippet: "First one." },
    { title: "Beta", url: "https://beta.example.org/b" },
  ],
});

function fenced(info: string, body: string, terminated = true) {
  return `Intro line.\n\n\`\`\`${info}\n${body}\n${terminated ? "```" : ""}`;
}

describe("chat block parsing", () => {
  it("recognizes subrosa fence info strings only", () => {
    expect(chatBlockKindOf("subrosa:links")).toBe("links");
    expect(chatBlockKindOf("  SUBROSA:LINKS ")).toBe("links");
    expect(chatBlockKindOf("subrosa:")).toBeNull();
    expect(chatBlockKindOf("ts")).toBeNull();
    expect(chatBlockKindOf("")).toBeNull();
  });

  it("parses a valid links block and derives domains itself", () => {
    const block = parseChatBlock("subrosa:links", LINKS_BODY);
    if (block?.kind !== "links") throw new Error("expected links");
    expect(block.links).toHaveLength(2);
    expect(block.links[0].domain).toBe("example.com");
    expect(block.links[1].domain).toBe("beta.example.org");
  });

  it("drops non-https and title-less links, and rejects an all-invalid payload", () => {
    const mixed = JSON.stringify({
      v: 1,
      links: [
        { title: "Plain http", url: "http://example.com" },
        { title: "Scripty", url: "javascript:alert(1)" },
        { url: "https://example.com/no-title" },
        { title: "Kept", url: "https://example.com/ok" },
      ],
    });
    const mixedBlock = parseChatBlock("subrosa:links", mixed);
    if (mixedBlock?.kind !== "links") throw new Error("expected links");
    expect(mixedBlock.links.map((l) => l.title)).toEqual(["Kept"]);
    const allBad = JSON.stringify({ v: 1, links: [{ title: "x", url: "http://example.com" }] });
    expect(parseChatBlock("subrosa:links", allBad)).toBeNull();
  });

  it("clamps to six links and caps long strings", () => {
    const many = JSON.stringify({
      v: 1,
      links: Array.from({ length: 9 }, (_, i) => ({
        title: `Link ${i}`,
        url: `https://example.com/${i}`,
        snippet: "s".repeat(500),
      })),
    });
    const block = parseChatBlock("subrosa:links", many);
    if (block?.kind !== "links") throw new Error("expected links");
    expect(block.links).toHaveLength(6);
    expect(block.links[0].snippet?.length).toBeLessThanOrEqual(280);
    expect(block.links[0].snippet?.endsWith("…")).toBe(true);
  });

  it("rejects malformed JSON, wrong versions, and unknown kinds", () => {
    expect(parseChatBlock("subrosa:links", "{not json")).toBeNull();
    expect(parseChatBlock("subrosa:links", JSON.stringify({ v: 2, links: [] }))).toBeNull();
    expect(parseChatBlock("subrosa:mystery", LINKS_BODY)).toBeNull();
    expect(parseChatBlock("json", LINKS_BODY)).toBeNull();
  });
});

describe("resolveChatBlockFence (the decision both renderers share)", () => {
  it("routes valid, streaming, degraded, and non-block fences", () => {
    expect(resolveChatBlockFence("subrosa:links", LINKS_BODY, true, false)?.type).toBe("card");
    // A complete payload shows the card even before the closing fence.
    expect(resolveChatBlockFence("subrosa:links", LINKS_BODY, false, true)?.type).toBe("card");
    expect(resolveChatBlockFence("subrosa:links", '{"v":1,"li', false, true)?.type).toBe(
      "skeleton",
    );
    expect(resolveChatBlockFence("subrosa:links", "{broken", true, false)?.type).toBe("code");
    expect(resolveChatBlockFence("subrosa:links", "{broken", false, false)?.type).toBe("code");
    expect(resolveChatBlockFence("ts", LINKS_BODY, true, false)).toBeNull();
  });
});

describe("chatBlocksToClipboardText", () => {
  it("turns valid blocks into readable lists and leaves everything else verbatim", () => {
    const reply = `Intro.\n\n\`\`\`subrosa:links\n${LINKS_BODY}\n\`\`\`\n\nAnd some code:\n\n\`\`\`ts\nconst a = 1;\n\`\`\``;
    const copied = chatBlocksToClipboardText(reply);
    expect(copied).toContain("Sources");
    expect(copied).toContain("- Alpha: https://www.example.com/a");
    expect(copied).not.toContain("subrosa:links");
    expect(copied).toContain("```ts\nconst a = 1;\n```");
  });

  it("keeps an invalid block fence verbatim (it is what the user saw)", () => {
    const reply = "```subrosa:links\n{broken\n```";
    expect(chatBlocksToClipboardText(reply)).toBe(reply);
  });
});

const PLACES_BODY = JSON.stringify({
  v: 1,
  title: "Experts-comptables",
  attribution: "osm",
  places: [
    {
      name: "Sogeca Experts",
      lat: 46.19,
      lng: 6.23,
      category: "Accountant",
      rating: 4.96,
      reviews: 8,
      url: "https://sogeca.example.com",
      note: "Le mieux noté d'Annemasse.",
    },
    { name: "Off the globe", lat: 200, lng: 6.2 },
    { name: "", lat: 46.2, lng: 6.24 },
  ],
});

describe("places block parsing", () => {
  it("keeps valid places, rounds ratings, and defaults attribution to osm", () => {
    const block = parseChatBlock("subrosa:places", PLACES_BODY);
    expect(block?.kind).toBe("places");
    if (block?.kind !== "places") throw new Error("expected places");
    expect(block.places).toHaveLength(1);
    expect(block.places[0].rating).toBe(5);
    expect(block.places[0].url).toBe("https://sogeca.example.com/");
    expect(block.attribution).toBe("osm");
    const unattributed = parseChatBlock(
      "subrosa:places",
      JSON.stringify({ v: 1, places: [{ name: "X", lat: 1, lng: 1 }], attribution: "bing" }),
    );
    if (unattributed?.kind !== "places") throw new Error("expected places");
    expect(unattributed.attribution).toBe("osm");
  });

  it("turns a places block into a readable clipboard list", () => {
    const copied = chatBlocksToClipboardText(`\`\`\`subrosa:places\n${PLACES_BODY}\n\`\`\``);
    expect(copied).toContain("Experts-comptables");
    expect(copied).toContain("- Sogeca Experts (Accountant, 5/5");
    expect(copied).not.toContain("subrosa:places");
  });
});

describe("photoRef validation", () => {
  it("keeps well-shaped Google refs and drops everything else", () => {
    const body = (photoRef: unknown) =>
      JSON.stringify({
        v: 1,
        attribution: "google",
        places: [{ name: "X", lat: 1, lng: 1, photoRef }],
      });
    const good = parseChatBlock("subrosa:places", body("places/abc-1/photos/def_2"));
    if (good?.kind !== "places") throw new Error("expected places");
    expect(good.places[0].photoRef).toBe("places/abc-1/photos/def_2");
    for (const bad of ["photos/def", "places/abc/photos/../x", "places/a photos/b", 42]) {
      const block = parseChatBlock("subrosa:places", body(bad));
      if (block?.kind !== "places") throw new Error("expected places");
      expect(block.places[0].photoRef).toBeUndefined();
    }
  });
});

describe("PlacesCard rendering", () => {
  it("renders the list immediately and the map with its pins once Rust answers", async () => {
    const { container } = render(<SimpleMarkdown text={fenced("subrosa:places", PLACES_BODY)} />);
    expect(screen.getByRole("region", { name: "Experts-comptables" })).toBeInTheDocument();
    expect(screen.getByText("Sogeca Experts")).toBeInTheDocument();
    expect(screen.getByText(/★ 5/)).toBeInTheDocument();
    expect(screen.getByText("Le mieux noté d'Annemasse.")).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(container.querySelector(".chat-block-map img")).not.toBeNull();
    });
    expect(container.querySelector(".chat-block-pin")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "© OpenStreetMap contributors" }),
    ).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith(
      "render_map_card",
      expect.objectContaining({
        request: expect.objectContaining({ height: 200 }),
      }),
    );
  });

  it("shows the place photo once Rust resolves it, with the index on its corner", async () => {
    const withPhoto = JSON.stringify({
      v: 1,
      attribution: "google",
      places: [
        {
          name: "Sogeca Experts",
          lat: 46.19,
          lng: 6.23,
          rating: 5,
          photoRef: "places/abc/photos/one",
        },
      ],
    });
    const { container } = render(<SimpleMarkdown text={fenced("subrosa:places", withPhoto)} />);
    await vi.waitFor(() => {
      expect(container.querySelector(".chat-block-place-thumb img")).not.toBeNull();
    });
    expect(container.querySelector(".chat-block-place-thumb-index")?.textContent).toBe("1");
    expect(invokeMock).toHaveBeenCalledWith(
      "places_photo_data_url",
      expect.objectContaining({
        request: expect.objectContaining({ photoRef: "places/abc/photos/one" }),
      }),
    );
  });

  it("keeps the card usable when the map render fails", async () => {
    invokeMock.mockRejectedValueOnce(new Error("offline"));
    const { container } = render(<SimpleMarkdown text={fenced("subrosa:places", PLACES_BODY)} />);
    await vi.waitFor(() => {
      expect(screen.getByText(/Data: © OpenStreetMap contributors/)).toBeInTheDocument();
    });
    expect(container.querySelector(".chat-block-map")).toBeNull();
    expect(screen.getByText("Sogeca Experts")).toBeInTheDocument();
  });
});

describe("SimpleMarkdown chat-block rendering", () => {
  it("renders a valid closed fence as a link card that opens externally", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<SimpleMarkdown text={fenced("subrosa:links", LINKS_BODY)} />);
    expect(screen.getByRole("region", { name: "Sources" })).toBeInTheDocument();
    const row = screen.getByRole("button", { name: /Alpha/ });
    fireEvent.click(row);
    expect(open).toHaveBeenCalledWith("https://www.example.com/a", "_blank", "noopener");
    open.mockRestore();
  });

  it("degrades an invalid payload to the plain code block", () => {
    render(<SimpleMarkdown text={fenced("subrosa:links", "{broken")} />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });

  it("shows a skeleton for an unterminated fence while streaming", () => {
    const { container } = render(
      <SimpleMarkdown text={fenced("subrosa:links", '{"v":1,"links":[{"ti', false)} streaming />,
    );
    expect(container.querySelector(".chat-block-skeleton")).not.toBeNull();
  });

  it("renders the card as soon as the streamed payload is complete, even before the closing fence", () => {
    render(<SimpleMarkdown text={fenced("subrosa:links", LINKS_BODY, false)} streaming />);
    expect(screen.getByRole("region", { name: "Sources" })).toBeInTheDocument();
  });

  it("falls back to a readable code block for an unterminated fence in a finished reply", () => {
    render(<SimpleMarkdown text={fenced("subrosa:links", "{broken", false)} />);
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });
});
