/**
 * The extension's half of the protocol with the desktop app (ADR-0100).
 *
 * The other half is `src-tauri/src/browser_extension/protocol.rs`. Messages
 * go through the browser's native messaging port to a relay the browser
 * starts (the app's own binary), which hands them to the running app. Every
 * request carries an `id`; every reply to it carries the same one, so one
 * port can stream an answer while a save goes through. Pure module: the
 * port is passed in, so the tests drive it with a fake.
 */

export const HOST_NAME = "xyz.carpediem.subrosa";
export const PROTOCOL_VERSION = 1;

export const MAX_PAGE_CHARS = 60_000;
export const MAX_SELECTION_CHARS = 20_000;
export const MAX_QUESTION_CHARS = 4_000;

/** Replies that end a request. Everything else is a step of a stream. */
const TERMINAL = new Set(["hello", "paired", "done", "saved", "unpaired", "error"]);

export class ProtocolError extends Error {
  /** @param {string} code @param {string} [message] */
  constructor(code, message) {
    super(message || code);
    this.name = "ProtocolError";
    this.code = code;
  }
}

/**
 * What a port closing with this `runtime.lastError` message means. The
 * browser's wording is the only signal it gives, so it is matched loosely.
 * @param {string | undefined} message
 */
export function disconnectCode(message) {
  const text = String(message ?? "").toLowerCase();
  if (text.includes("not found")) return "host_not_found";
  if (text.includes("forbidden") || text.includes("not allowed")) return "host_forbidden";
  return "disconnected";
}

/**
 * A client over one native messaging port, opened on the first request and
 * reopened after it closes.
 * @param {() => any} connect returns a `runtime.Port`
 * @param {() => string | undefined} [lastError] the browser's last error text
 */
export function createClient(connect, lastError = () => undefined) {
  /** @type {any} */
  let port = null;
  let counter = 0;
  /** @type {Map<string, any>} */
  const pending = new Map();

  function failAll(error) {
    const handlers = [...pending.values()];
    pending.clear();
    for (const handler of handlers) handler.reject(error);
  }

  function onMessage(message) {
    if (!message || typeof message !== "object") return;
    // A message without an id is about the connection itself, such as the
    // relay finding the app closed.
    if (message.id == null) {
      if (message.type === "error") failAll(new ProtocolError(message.code, message.message));
      return;
    }
    const handler = pending.get(message.id);
    if (!handler) return;
    if (!TERMINAL.has(message.type)) {
      handler.onEvent?.(message);
      return;
    }
    pending.delete(message.id);
    if (message.type === "error") handler.reject(new ProtocolError(message.code, message.message));
    else handler.resolve(message);
  }

  function onDisconnect() {
    port = null;
    failAll(new ProtocolError(disconnectCode(lastError())));
  }

  function ensurePort() {
    if (port) return port;
    port = connect();
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    return port;
  }

  function nextId() {
    counter += 1;
    return `${Date.now().toString(36)}-${counter}`;
  }

  /**
   * Sends a request and resolves with its final reply. Stream steps
   * (`started`, `status`, `delta`, `retract`) go to `onEvent` on the way.
   * @param {string} type
   * @param {Record<string, unknown>} fields
   * @param {(message: any) => void} [onEvent]
   */
  function request(type, fields = {}, onEvent) {
    const id = nextId();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onEvent });
      try {
        ensurePort().postMessage({ v: PROTOCOL_VERSION, ...fields, type, id });
      } catch (error) {
        pending.delete(id);
        port = null;
        reject(new ProtocolError(disconnectCode(lastError() ?? String(error))));
      }
    });
  }

  /** Sends a request that has no reply (a cancel). */
  function send(type, fields = {}) {
    try {
      ensurePort().postMessage({ v: PROTOCOL_VERSION, ...fields, type, id: nextId() });
      return true;
    } catch {
      port = null;
      return false;
    }
  }

  function close() {
    const current = port;
    port = null;
    current?.disconnect();
    failAll(new ProtocolError("disconnected"));
  }

  return { request, send, close };
}

/** The text after one stream step. */
export function applyStreamStep(text, message) {
  if (message.type === "delta") return text + String(message.text ?? "");
  if (message.type === "retract") {
    const count = Math.max(0, Number(message.count) || 0);
    return text.slice(0, Math.max(0, text.length - count));
  }
  return text;
}

/** The page as the app accepts it: bounded fields, nothing else. */
export function clipPage(page) {
  return {
    url: String(page?.url ?? ""),
    title: String(page?.title ?? "")
      .trim()
      .slice(0, 300),
    text: String(page?.text ?? "")
      .trim()
      .slice(0, MAX_PAGE_CHARS),
    selection: String(page?.selection ?? "")
      .trim()
      .slice(0, MAX_SELECTION_CHARS),
  };
}

/** Only web pages are read; a browser page or a local file never is. */
export function isReadableUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Digits only, as the app compares them: "123 456" is "123456". */
export function normalizeCode(input) {
  return String(input ?? "").replace(/\D/g, "");
}

/**
 * Which browser this is, for the app's list of paired browsers.
 * @param {string} userAgent
 * @param {{ brave?: boolean, firefox?: boolean }} [hints]
 */
export function detectBrowser(userAgent, hints = {}) {
  if (hints.firefox || /firefox\//i.test(userAgent)) return "firefox";
  if (/edg\//i.test(userAgent)) return "edge";
  if (hints.brave) return "brave";
  return "chrome";
}

/**
 * The app's replies may end with card blocks (```subrosa:links``` and the
 * like) the app renders as cards. The extension shows prose, so they go.
 */
export function stripChatBlocks(text) {
  return String(text ?? "")
    .replace(/```subrosa:[a-z-]+[^\n]*\n[\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The `_locales` key that explains an error code to the person. */
export function errorMessageKey(code) {
  switch (code) {
    case "app_not_running":
      return "errorAppNotRunning";
    case "host_not_found":
    case "host_forbidden":
      return "errorHostNotFound";
    case "not_paired":
      return "errorNotPaired";
    case "pairing_not_started":
      return "errorPairingNotStarted";
    case "pairing_wrong_code":
      return "errorPairingWrong";
    case "pairing_expired":
      return "errorPairingExpired";
    case "pairing_exhausted":
      return "errorPairingExhausted";
    case "page_not_supported":
      return "errorNotAPage";
    case "no_access":
      return "errorNoAccess";
    case "unsupported_version":
      return "errorUpdateApp";
    case "browser_extension_chat_busy":
    case "agent_lite_running":
      return "errorBusy";
    case "empty_question":
      return "errorEmptyQuestion";
    default:
      return "errorGeneric";
  }
}

/** The `_locales` key for what the app says it is doing. */
export function stageMessageKey(stage) {
  switch (stage) {
    case "searching-web":
      return "stageSearchingWeb";
    case "reading-page":
      return "stageReadingPage";
    case "searching-notes":
    case "reading-note":
      return "stageSearchingNotes";
    case "searching-memory":
      return "stageSearchingMemory";
    default:
      return "stageThinking";
  }
}
