import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
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
    expect(block).not.toBeNull();
    expect(block?.kind).toBe("links");
    expect(block?.links).toHaveLength(2);
    expect(block?.links[0].domain).toBe("example.com");
    expect(block?.links[1].domain).toBe("beta.example.org");
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
    expect(parseChatBlock("subrosa:links", mixed)?.links.map((l) => l.title)).toEqual(["Kept"]);
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
    expect(block?.links).toHaveLength(6);
    expect(block?.links[0].snippet?.length).toBeLessThanOrEqual(280);
    expect(block?.links[0].snippet?.endsWith("…")).toBe(true);
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
