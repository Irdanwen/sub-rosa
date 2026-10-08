import { describe, expect, it } from "vitest";
import {
  HOST_NAME,
  PROTOCOL_VERSION,
  ProtocolError,
  applyStreamStep,
  clipPage,
  createClient,
  detectBrowser,
  disconnectCode,
  errorMessageKey,
  isReadableUrl,
  normalizeCode,
  stageMessageKey,
  stripChatBlocks,
} from "../../browser-extension/src/protocol.js";
import en from "../../browser-extension/_locales/en/messages.json";

/** A `runtime.Port` the test drives: what the extension posts, and replies. */
function fakePort() {
  const listeners = { message: [], disconnect: [] };
  const port = {
    posted: [],
    postMessage(message) {
      port.posted.push(message);
    },
    disconnect() {},
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    reply(message) {
      for (const fn of listeners.message) fn(message);
    },
    close() {
      for (const fn of listeners.disconnect) fn();
    },
  };
  return port;
}

describe("the native messaging client", () => {
  it("names the host the app registers and speaks version 1", () => {
    expect(HOST_NAME).toBe("xyz.carpediem.subrosa");
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("opens the port on the first request and matches replies by id", async () => {
    const port = fakePort();
    let opened = 0;
    const client = createClient(() => {
      opened += 1;
      return port;
    });
    const hello = client.request("hello", { token: "tok" });
    const pair = client.request("pair", { code: "123456" });
    expect(opened).toBe(1);
    const [first, second] = port.posted;
    expect(first).toMatchObject({ v: 1, type: "hello", token: "tok" });
    expect(second).toMatchObject({ v: 1, type: "pair", code: "123456" });
    expect(first.id).not.toBe(second.id);
    port.reply({ type: "paired", id: second.id, token: "t" });
    port.reply({ type: "hello", id: first.id, paired: true });
    await expect(hello).resolves.toMatchObject({ paired: true });
    await expect(pair).resolves.toMatchObject({ token: "t" });
  });

  it("streams an answer's steps before it resolves with the whole text", async () => {
    const port = fakePort();
    const client = createClient(() => port);
    const events = [];
    const answer = client.request("ask", { token: "t", question: "Why?" }, (event) =>
      events.push(event.type),
    );
    const { id } = port.posted[0];
    port.reply({ type: "started", id, conversationId: "c1" });
    port.reply({ type: "status", id, stage: "searching-web" });
    port.reply({ type: "delta", id, text: "Bec" });
    // Another request's reply is not this one's.
    port.reply({ type: "delta", id: "other", text: "x" });
    port.reply({ type: "done", id, conversationId: "c1", text: "Because." });
    await expect(answer).resolves.toMatchObject({ text: "Because.", conversationId: "c1" });
    expect(events).toEqual(["started", "status", "delta"]);
  });

  it("rejects with the app's error code", async () => {
    const port = fakePort();
    const client = createClient(() => port);
    const ask = client.request("ask", { token: "old", question: "Hi" });
    port.reply({ type: "error", id: port.posted[0].id, code: "not_paired", message: "No." });
    await expect(ask).rejects.toMatchObject({ name: "ProtocolError", code: "not_paired" });
  });

  it("fails every pending request when the relay finds the app closed", async () => {
    const port = fakePort();
    const client = createClient(() => port);
    const a = client.request("hello");
    const b = client.request("save_link", { token: "t", page: { url: "https://a.b" } });
    port.reply({ type: "error", code: "app_not_running", message: "Sub Rosa is not open." });
    await expect(a).rejects.toMatchObject({ code: "app_not_running" });
    await expect(b).rejects.toMatchObject({ code: "app_not_running" });
  });

  it("reads a closed port from the browser's last error and reconnects next time", async () => {
    const first = fakePort();
    const second = fakePort();
    const ports = [first, second];
    const client = createClient(
      () => ports.shift(),
      () => "Specified native messaging host not found.",
    );
    const pending = client.request("hello");
    first.close();
    await expect(pending).rejects.toMatchObject({ code: "host_not_found" });
    const again = client.request("hello");
    expect(second.posted).toHaveLength(1);
    second.reply({ type: "hello", id: second.posted[0].id, paired: false });
    await expect(again).resolves.toMatchObject({ paired: false });
  });

  it("sends a cancel without waiting for a reply", () => {
    const port = fakePort();
    const client = createClient(() => port);
    expect(client.send("cancel", { token: "t", conversationId: "c1" })).toBe(true);
    expect(port.posted[0]).toMatchObject({ v: 1, type: "cancel", conversationId: "c1" });
  });

  it("maps the browser's disconnect wording to a code", () => {
    expect(disconnectCode("Specified native messaging host not found.")).toBe("host_not_found");
    expect(disconnectCode("Access to the specified native messaging host is forbidden.")).toBe(
      "host_forbidden",
    );
    expect(disconnectCode("Native host has exited.")).toBe("disconnected");
    expect(disconnectCode(undefined)).toBe("disconnected");
    expect(new ProtocolError("x").message).toBe("x");
  });
});

describe("what the extension sends and shows", () => {
  it("applies deltas and takes back a retracted tail", () => {
    let text = "";
    text = applyStreamStep(text, { type: "delta", text: "Hello wor" });
    text = applyStreamStep(text, { type: "retract", count: 3 });
    text = applyStreamStep(text, { type: "delta", text: "world" });
    expect(text).toBe("Hello world");
    expect(applyStreamStep("ab", { type: "retract", count: 10 })).toBe("");
    expect(applyStreamStep("ab", { type: "status", stage: "x" })).toBe("ab");
  });

  it("bounds a page before it leaves the browser", () => {
    const page = clipPage({
      url: "https://example.com",
      title: `  ${"t".repeat(400)}  `,
      text: "x".repeat(70_000),
      selection: " picked ",
      cookies: "never sent",
    });
    expect(page.title).toHaveLength(300);
    expect(page.text).toHaveLength(60_000);
    expect(page.selection).toBe("picked");
    expect(Object.keys(page).sort()).toEqual(["selection", "text", "title", "url"]);
  });

  it("reads web pages only", () => {
    expect(isReadableUrl("https://example.com/a")).toBe(true);
    expect(isReadableUrl("http://localhost:3000")).toBe(true);
    expect(isReadableUrl("chrome://settings")).toBe(false);
    expect(isReadableUrl("file:///etc/passwd")).toBe(false);
    expect(isReadableUrl("about:blank")).toBe(false);
    expect(isReadableUrl(undefined)).toBe(false);
  });

  it("accepts a code typed with spaces or a dash", () => {
    expect(normalizeCode(" 123-456 ")).toBe("123456");
  });

  it("names the browser for the app's list", () => {
    const chrome =
      "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
    expect(detectBrowser(chrome)).toBe("chrome");
    expect(detectBrowser(`${chrome} Edg/130.0`)).toBe("edge");
    expect(detectBrowser(chrome, { brave: true })).toBe("brave");
    expect(detectBrowser("Mozilla/5.0 (Macintosh; rv:130.0) Gecko/20100101 Firefox/130.0")).toBe(
      "firefox",
    );
  });

  it("shows prose and leaves the app's cards out", () => {
    const reply =
      'Two sources agree.\n\n```subrosa:links\n{"v":1,"links":[]}\n```\n\n\nThat is all.';
    expect(stripChatBlocks(reply)).toBe("Two sources agree.\n\nThat is all.");
    expect(stripChatBlocks("```js\nlet a;\n```")).toBe("```js\nlet a;\n```");
  });

  it("explains every error and stage with a message the catalog has", () => {
    const codes = [
      "app_not_running",
      "host_not_found",
      "host_forbidden",
      "not_paired",
      "pairing_not_started",
      "pairing_wrong_code",
      "pairing_expired",
      "pairing_exhausted",
      "page_not_supported",
      "no_access",
      "unsupported_version",
      "browser_extension_chat_busy",
      "empty_question",
      "something_else",
    ];
    for (const code of codes) expect(en[errorMessageKey(code)]).toBeDefined();
    expect(errorMessageKey("pairing_wrong_code")).toBe("errorPairingWrong");
    for (const stage of ["thinking", "searching-web", "reading-page", "reading-note", "x"]) {
      expect(en[stageMessageKey(stage)]).toBeDefined();
    }
  });
});
