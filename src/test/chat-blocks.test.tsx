import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn(async (command: string, _args?: unknown) => {
  if (command === "render_map_card") {
    return { dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
  }
  if (command === "places_photo_data_url") {
    return { dataUrl: "data:image/jpeg;base64,/9j/photo" };
  }
  if (command === "action_states") return actionStateRows;
  if (command === "action_execute") {
    if (actionExecuteFails) throw new Error("Sub Rosa needs access to your reminders.");
    return { actionId: "a1", status: "done", detail: "Added to your reminders" };
  }
  return undefined;
});
/** What the durable rows say this proposal already did. */
let actionStateRows: Array<{ actionId: string; status: string; detail?: string }> = [];
let actionExecuteFails = false;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

// Call history is per-test: several tests count render_map_card invocations.
beforeEach(() => invokeMock.mockClear());

import {
  chatBlockKindOf,
  chatBlocksToClipboardText,
  parseChatBlock,
  resolveChatBlockFence,
} from "../lib/chat-blocks";
import { OPEN_NOTE_FROM_CHAT_EVENT } from "../lib/chat-blocks-nav";
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

describe("notes block", () => {
  const NOTES_BODY = JSON.stringify({
    v: 1,
    title: "From your notes",
    notes: [
      { id: "note-abc_1", title: "Standup 12 August", snippet: "Decisions on the rollout." },
      { id: "../etc", title: "Path trickery" },
      { id: "", title: "No id" },
    ],
  });

  it("keeps well-formed note ids only", () => {
    const block = parseChatBlock("subrosa:notes", NOTES_BODY);
    if (block?.kind !== "notes") throw new Error("expected notes");
    expect(block.notes).toHaveLength(1);
    expect(block.notes[0].id).toBe("note-abc_1");
  });

  it("renders rows that dispatch the open-note event", () => {
    const seen: string[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ noteId: string }>).detail.noteId);
    };
    window.addEventListener(OPEN_NOTE_FROM_CHAT_EVENT, listener);
    render(<SimpleMarkdown text={fenced("subrosa:notes", NOTES_BODY)} />);
    fireEvent.click(screen.getByRole("button", { name: /Standup 12 August/ }));
    window.removeEventListener(OPEN_NOTE_FROM_CHAT_EVENT, listener);
    expect(seen).toEqual(["note-abc_1"]);
  });

  it("copies as a readable list", () => {
    const copied = chatBlocksToClipboardText(`\`\`\`subrosa:notes\n${NOTES_BODY}\n\`\`\``);
    expect(copied).toContain("From your notes");
    expect(copied).toContain("- Standup 12 August");
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

  it("re-renders one zoom step in when the zoom control is pressed", async () => {
    const { container } = render(<SimpleMarkdown text={fenced("subrosa:places", PLACES_BODY)} />);
    await vi.waitFor(() => {
      expect(container.querySelector(".chat-block-map img")).not.toBeNull();
    });
    const firstRequest = invokeMock.mock.calls.find(([cmd]) => cmd === "render_map_card")?.[1] as {
      request: { zoom: number };
    };
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await vi.waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === "render_map_card");
      expect(calls.length).toBeGreaterThan(1);
      const last = calls[calls.length - 1][1] as { request: { zoom: number } };
      expect(last.request.zoom).toBe(firstRequest.request.zoom + 1);
    });
  });

  it("pans west when the map is dragged east, re-rendering at the settled center", async () => {
    const { container } = render(<SimpleMarkdown text={fenced("subrosa:places", PLACES_BODY)} />);
    await vi.waitFor(() => {
      expect(container.querySelector(".chat-block-map img")).not.toBeNull();
    });
    const first = invokeMock.mock.calls.find(([cmd]) => cmd === "render_map_card")?.[1] as {
      request: { centerLng: number };
    };
    const map = container.querySelector(".chat-block-map");
    if (!map) throw new Error("expected the map");
    // jsdom has no PointerEvent and its generic events carry no coordinates;
    // MouseEvent with a pointer* type reaches React's pointer handlers with
    // real clientX/button values.
    const pointer = (type: string, clientX: number) =>
      new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 100 });
    fireEvent(map, pointer("pointerdown", 200));
    fireEvent(map, pointer("pointermove", 320));
    fireEvent(map, pointer("pointerup", 320));
    await vi.waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === "render_map_card");
      expect(calls.length).toBeGreaterThan(1);
      const last = calls[calls.length - 1][1] as { request: { centerLng: number } };
      // Content dragged east shows what lies west of the old center.
      expect(last.request.centerLng).toBeLessThan(first.request.centerLng);
    });
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

const PROPOSAL_BODY = JSON.stringify({
  v: 1,
  proposalId: "prop-1",
  title: "Follow-ups",
  actions: [
    { kind: "reminder", id: "a1", label: "Send Ana the numbers", due: "2026-08-25T09:00:00Z" },
    { kind: "event", id: "a2", label: "Follow-up with Marie", start: "2026-08-26T09:00:00Z" },
    { kind: "note", id: "a3", label: "Add to the note", noteId: "note-1", text: "Ana owns it." },
    { kind: "reminder", id: "", label: "No id" },
    { kind: "event", id: "a5", label: "No date" },
  ],
});

describe("proposal blocks", () => {
  beforeEach(() => {
    actionStateRows = [];
    actionExecuteFails = false;
  });

  it("keeps only actions it can actually carry out", () => {
    const block = parseChatBlock("subrosa:proposal", PROPOSAL_BODY);
    if (block?.kind !== "proposal") throw new Error("expected a proposal");
    // The id-less one and the dateless event cannot be executed, so they are
    // not offered.
    expect(block.actions.map((action) => action.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("carries the two kinds that start work, and says what they cost", () => {
    const body = JSON.stringify({
      v: 1,
      proposalId: "prop-2",
      actions: [
        { kind: "summarize", id: "s1", label: "Read the whole talk", noteId: "note-7" },
        {
          kind: "importLink",
          id: "s2",
          label: "Fetch the episode",
          url: "https://cdn.x.com/a.mp3",
        },
      ],
    });

    const block = parseChatBlock("subrosa:proposal", body);
    if (block?.kind !== "proposal") throw new Error("expected a proposal");

    expect(block.actions).toEqual([
      { kind: "summarize", id: "s1", label: "Read the whole talk", noteId: "note-7" },
      {
        kind: "importLink",
        id: "s2",
        label: "Fetch the episode",
        url: "https://cdn.x.com/a.mp3",
      },
    ]);

    render(<SimpleMarkdown text={fenced("subrosa:proposal", body)} />);
    // The hint names the cost before the tap, since both spend money, and the
    // link one names the host the bytes will come from.
    expect(screen.getByText("Reads the whole recording · takes a few minutes")).toBeInTheDocument();
    expect(screen.getByText("Fetches cdn.x.com · takes a few minutes")).toBeInTheDocument();
  });

  it("drops a link action whose url is not a web link", () => {
    const body = JSON.stringify({
      v: 1,
      proposalId: "prop-3",
      actions: [
        { kind: "importLink", id: "s1", label: "Nope", url: "file:///etc/passwd" },
        { kind: "summarize", id: "s2", label: "No note", noteId: "" },
      ],
    });

    expect(parseChatBlock("subrosa:proposal", body)).toBeNull();
  });

  it("refuses a proposal with no id, because 'done' would have nowhere to live", () => {
    const noId = JSON.stringify({
      v: 1,
      actions: [{ kind: "reminder", id: "a1", label: "x" }],
    });
    expect(parseChatBlock("subrosa:proposal", noId)).toBeNull();
  });

  it("offers a button, does the thing on a tap, and never on its own", async () => {
    render(<SimpleMarkdown text={fenced("subrosa:proposal", PROPOSAL_BODY)} />);
    const add = await screen.findAllByRole("button", { name: "Add" });
    expect(add).toHaveLength(3);
    // Mounting alone must never execute anything.
    expect(invokeMock).not.toHaveBeenCalledWith("action_execute", expect.anything());

    fireEvent.click(add[0]);
    await vi.waitFor(() => {
      expect(screen.getByText("Added to your reminders")).toBeInTheDocument();
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "action_execute",
      expect.objectContaining({
        request: expect.objectContaining({ proposalId: "prop-1" }),
      }),
    );
  });

  it("shows what was already done instead of offering to do it twice", async () => {
    // This is the whole point of the durable row: the message is immutable,
    // so a reopened conversation would otherwise re-offer a done action.
    actionStateRows = [{ actionId: "a1", status: "done", detail: "Added to your reminders" }];
    render(<SimpleMarkdown text={fenced("subrosa:proposal", PROPOSAL_BODY)} />);
    await vi.waitFor(() => {
      expect(screen.getByLabelText("Done")).toBeInTheDocument();
    });
    expect(screen.getAllByRole("button", { name: "Add" })).toHaveLength(2);
  });

  it("keeps the button when the action failed, and says why", async () => {
    actionExecuteFails = true;
    render(<SimpleMarkdown text={fenced("subrosa:proposal", PROPOSAL_BODY)} />);
    const add = await screen.findAllByRole("button", { name: "Add" });
    fireEvent.click(add[0]);
    await vi.waitFor(() => {
      expect(screen.getByText(/needs access to your reminders/)).toBeInTheDocument();
    });
    // Nothing happened, so the button is still there.
    expect(screen.getAllByRole("button", { name: "Add" })).toHaveLength(3);
  });

  it("copies as a readable list", () => {
    const copied = chatBlocksToClipboardText(`\`\`\`subrosa:proposal\n${PROPOSAL_BODY}\n\`\`\``);
    expect(copied).toContain("Follow-ups");
    expect(copied).toContain("- Send Ana the numbers");
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
