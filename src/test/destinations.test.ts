import { beforeEach, describe, expect, it, vi } from "vitest";

/** The three sources, faked: a cold-launch URL, a warm one, a notification. */
const deepLink = vi.hoisted(() => ({
  current: [] as string[],
  handlers: [] as Array<(urls: string[]) => void>,
  unlisten: vi.fn(),
}));
const notification = vi.hoisted(() => ({
  handlers: [] as Array<(payload: { extra?: Record<string, unknown> }) => void>,
  unregister: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: async () => deepLink.current,
  onOpenUrl: async (handler: (urls: string[]) => void) => {
    deepLink.handlers.push(handler);
    return deepLink.unlisten;
  },
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  onAction: async (handler: (payload: { extra?: Record<string, unknown> }) => void) => {
    notification.handlers.push(handler);
    return { unregister: notification.unregister };
  },
}));

import {
  type Destination,
  destinationUrl,
  parseDestination,
  subscribeToDestinations,
} from "../lib/destinations";

describe("destination addresses", () => {
  it("parses every address the app posts", () => {
    expect(parseDestination("subrosa://note/note-abc_1")).toEqual({
      kind: "note",
      noteId: "note-abc_1",
    });
    expect(parseDestination("subrosa://chat/task-9")).toEqual({
      kind: "chat",
      sessionId: "task-9",
      query: undefined,
    });
    expect(parseDestination("subrosa://chat")).toEqual({
      kind: "chat",
      sessionId: undefined,
      query: undefined,
    });
    expect(parseDestination("subrosa://dictation")).toEqual({ kind: "dictation" });
    expect(parseDestination("subrosa://studio")).toEqual({ kind: "studio" });
    expect(parseDestination("subrosa://record")).toEqual({ kind: "record" });
  });

  it("carries a chat query and caps it", () => {
    expect(parseDestination("subrosa://chat?q=what%20did%20I%20say")).toMatchObject({
      kind: "chat",
      query: "what did I say",
    });
    const long = parseDestination(`subrosa://chat?q=${"x".repeat(500)}`);
    expect(long?.kind).toBe("chat");
    expect(long?.kind === "chat" && long.query?.length).toBe(200);
  });

  it("refuses everything it does not recognise, rather than guessing", () => {
    for (const bad of [
      "https://example.com/note/abc",
      "subrosa://unknown",
      "subrosa://note/",
      "subrosa://note/../../etc",
      "subrosa://note/with space",
      "subrosa://note/a/b",
      "subrosa://chat/../note/secret",
      "not a url",
      "",
    ]) {
      expect(parseDestination(bad), bad).toBeNull();
    }
    // A non-string can arrive from a notification payload.
    expect(parseDestination(undefined as unknown as string)).toBeNull();
  });

  it("is case-insensitive on the scheme and the host", () => {
    expect(parseDestination("SUBROSA://STUDIO")).toEqual({ kind: "studio" });
  });

  it("round-trips through destinationUrl", () => {
    const cases = [
      { kind: "note", noteId: "n1" },
      { kind: "chat", sessionId: "s1" },
      { kind: "dictation" },
      { kind: "studio" },
      { kind: "record" },
    ] as const;
    for (const destination of cases) {
      expect(parseDestination(destinationUrl(destination))).toMatchObject(destination);
    }
    // The Rust mirror (src-tauri/src/destinations.rs) emits exactly these.
    expect(destinationUrl({ kind: "note", noteId: "note-abc" })).toBe("subrosa://note/note-abc");
    expect(destinationUrl({ kind: "chat", sessionId: "task-1" })).toBe("subrosa://chat/task-1");
    expect(destinationUrl({ kind: "chat" })).toBe("subrosa://chat");
    expect(destinationUrl({ kind: "dictation" })).toBe("subrosa://dictation");
    expect(destinationUrl({ kind: "studio" })).toBe("subrosa://studio");
  });
});

describe("subscribeToDestinations", () => {
  beforeEach(() => {
    deepLink.current = [];
    deepLink.handlers.length = 0;
    deepLink.unlisten.mockClear();
    notification.handlers.length = 0;
    notification.unregister.mockClear();
    // The subscription is a no-op outside Tauri; pretend we are inside it.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  /** Lets the two dynamic imports and their awaits settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("routes the launch URL, a warm link, and a notification tap", async () => {
    deepLink.current = ["subrosa://studio"];
    const seen: Destination[] = [];
    subscribeToDestinations((destination) => seen.push(destination));
    await settle();

    expect(seen).toEqual([{ kind: "studio" }]);

    deepLink.handlers[0](["subrosa://note/n-1"]);
    notification.handlers[0]({ extra: { destination: "subrosa://chat/task-2" } });

    expect(seen).toEqual([
      { kind: "studio" },
      { kind: "note", noteId: "n-1" },
      { kind: "chat", sessionId: "task-2", query: undefined },
    ]);
  });

  it("ignores a notification with no destination, and unknown addresses", async () => {
    const seen: Destination[] = [];
    subscribeToDestinations((destination) => seen.push(destination));
    await settle();

    notification.handlers[0]({});
    notification.handlers[0]({ extra: {} });
    notification.handlers[0]({ extra: { destination: 42 } });
    deepLink.handlers[0](["https://example.com", "subrosa://nope"]);

    expect(seen).toEqual([]);
  });

  it("tears both listeners down", async () => {
    const stop = subscribeToDestinations(() => {});
    await settle();
    stop();
    expect(deepLink.unlisten).toHaveBeenCalledTimes(1);
    expect(notification.unregister).toHaveBeenCalledTimes(1);
  });

  it("does nothing outside Tauri (browser preview)", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = undefined;
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const seen: Destination[] = [];
    const stop = subscribeToDestinations((destination) => seen.push(destination));
    await settle();
    expect(deepLink.handlers).toHaveLength(0);
    expect(notification.handlers).toHaveLength(0);
    stop();
  });
});

describe("the import destination (ADR-0028)", () => {
  it("carries the link it was shared", () => {
    expect(parseDestination("subrosa://import?url=https%3A%2F%2Fcdn.x.com%2Fa.mp3")).toEqual({
      kind: "import",
      url: "https://cdn.x.com/a.mp3",
    });
  });

  it("round-trips through destinationUrl", () => {
    const destination = { kind: "import", url: "https://x.com/a b.mp3?t=1" } as const;
    expect(parseDestination(destinationUrl(destination))).toEqual(destination);
  });

  it("refuses anything that is not a web link", () => {
    // This address arrives from outside the app, so it is the one place a
    // pasted scheme could reach the fetcher.
    for (const target of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:audio/mp3;base64,AA",
      "",
    ]) {
      expect(parseDestination(`subrosa://import?url=${encodeURIComponent(target)}`)).toBeNull();
    }
  });

  it("refuses a missing url and an absurdly long one", () => {
    expect(parseDestination("subrosa://import")).toBeNull();
    const long = `https://x.com/${"a".repeat(4000)}`;
    expect(parseDestination(`subrosa://import?url=${encodeURIComponent(long)}`)).toBeNull();
  });
});
