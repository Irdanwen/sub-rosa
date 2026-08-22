/**
 * Destinations — one address vocabulary for everything that opens the app at
 * a particular place.
 *
 * The `subrosa://` scheme was declared in four files and handled in none: no
 * `on_open_url`, no route, not one URL in the repo. Notification taps were in
 * the same state — touching "your dictation is ready" just foregrounded
 * whatever screen you had left. Both are the same problem, so both get the
 * same answer: an address.
 *
 * Three entry points feed this module — a cold launch through the deep-link
 * plugin, a warm `onOpenUrl`, and a notification tap (the destination rides
 * in the notification's `extra.destination`, set on the Rust side) — and each
 * shell answers with its own navigation (`App.tsx` on desktop, `MobileApp` on
 * the phone). Adding a source later means calling `subscribeToDestinations`
 * nowhere new; adding a destination means one arm in `parseDestination`.
 *
 * Everything here treats the URL as untrusted: it can arrive from another app
 * on the system. Unknown or malformed addresses resolve to null and are
 * ignored — never guessed at.
 */

export const DESTINATION_SCHEME = "subrosa://";

/** The key a notification carries its destination under (mirrored in Rust). */
export const DESTINATION_EXTRA_KEY = "destination";

export type Destination =
  /** Open one note. */
  | { kind: "note"; noteId: string }
  /** Open the chat, optionally on one conversation. */
  | { kind: "chat"; sessionId?: string; query?: string }
  /** Open the dictation surface. */
  | { kind: "dictation" }
  /** Open Studio. */
  | { kind: "studio" }
  /** Start a recording. */
  | { kind: "record" };

/** App-generated ids (notes, sessions) are opaque tokens, never paths. */
const ID_RE = /^[\w-]{1,64}$/;
const MAX_QUERY = 200;

/**
 * Parses a `subrosa://…` address. Returns null for anything else, including
 * a known host with an unusable id — the caller then does nothing, which is
 * the correct response to an address from an untrusted source.
 */
export function parseDestination(raw: string): Destination | null {
  if (typeof raw !== "string" || !raw.toLowerCase().startsWith(DESTINATION_SCHEME)) return null;
  // `new URL` NORMALISES the path, so "note/../../etc" would arrive here as
  // "/etc" — a plausible-looking id that is not the one anyone wrote. Reject
  // traversal on the raw string first: an address we cannot read literally is
  // one we refuse, never one we resolve to our best guess.
  if (raw.includes("..")) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // In `subrosa://note/abc`, `note` is the host and `/abc` the path — and the
  // path is at most one segment, always.
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (!/^\/?$|^\/[^/]*$/.test(path)) return null;
  const segment = path.replace(/^\/+/, "");
  switch (host) {
    case "note":
      return ID_RE.test(segment) ? { kind: "note", noteId: segment } : null;
    case "chat": {
      const query = url.searchParams.get("q")?.trim();
      return {
        kind: "chat",
        sessionId: ID_RE.test(segment) ? segment : undefined,
        query: query ? query.slice(0, MAX_QUERY) : undefined,
      };
    }
    case "dictation":
      return { kind: "dictation" };
    case "studio":
      return { kind: "studio" };
    case "record":
      return { kind: "record" };
    default:
      return null;
  }
}

/** Builds an address. Used by Rust-side notifications through their own
 * mirror of this vocabulary, and by any in-app link. */
export function destinationUrl(destination: Destination): string {
  switch (destination.kind) {
    case "note":
      return `${DESTINATION_SCHEME}note/${destination.noteId}`;
    case "chat": {
      const path = destination.sessionId ? `chat/${destination.sessionId}` : "chat";
      const query = destination.query ? `?q=${encodeURIComponent(destination.query)}` : "";
      return `${DESTINATION_SCHEME}${path}${query}`;
    }
    default:
      return `${DESTINATION_SCHEME}${destination.kind}`;
  }
}

type Unsubscribe = () => void;

function inTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Wires every source of destinations to one handler. Call once per shell.
 *
 * Sources, in the order they can fire:
 * 1. the URL the app was launched with (cold start, read once);
 * 2. `onOpenUrl` for a link that arrives while the app runs;
 * 3. a notification tap, whose payload carries the address in `extra`.
 *
 * Every subscription is best-effort: a missing plugin (browser preview) or a
 * rejected permission must never keep the shell from mounting.
 */
export function subscribeToDestinations(handle: (destination: Destination) => void): Unsubscribe {
  if (!inTauri()) return () => {};
  const teardown: Unsubscribe[] = [];
  let disposed = false;

  const track = (stop: Unsubscribe) => {
    if (disposed) stop();
    else teardown.push(stop);
  };

  const dispatch = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const destination = parseDestination(raw);
    if (destination) handle(destination);
  };

  void import("@tauri-apps/plugin-deep-link")
    .then(async ({ getCurrent, onOpenUrl }) => {
      // Cold launch: the URL that started the app, if any.
      const current = await getCurrent().catch(() => null);
      for (const url of current ?? []) dispatch(url);
      track(await onOpenUrl((urls) => urls.forEach(dispatch)));
    })
    .catch(() => {});

  void import("@tauri-apps/plugin-notification")
    .then(async ({ onAction }) => {
      // onAction hands back a PluginListener (an object with `unregister`),
      // not a bare function like the deep-link plugin does.
      const listener = await onAction((notification) => {
        const extra = notification.extra as Record<string, unknown> | undefined;
        dispatch(extra?.[DESTINATION_EXTRA_KEY]);
      });
      track(() => void listener.unregister());
    })
    .catch(() => {});

  return () => {
    disposed = true;
    for (const stop of teardown.splice(0)) {
      try {
        stop();
      } catch {
        // Tearing down a listener that never attached is not an error.
      }
    }
  };
}
