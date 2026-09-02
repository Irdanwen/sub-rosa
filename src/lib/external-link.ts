/**
 * The one gate a URL passes before it may leave the app.
 *
 * Neither webview honors `target="_blank"`, so an anchor that is not routed
 * through `openExternalUrl` does not open a browser — it navigates the app's
 * own webview away and takes the shell with it. That makes "which URLs may we
 * render as a link" and "which URLs may we open" the same question, and this
 * module is where it is answered once: chat markdown (both renderers), chat
 * blocks, agent artifacts, and the MCP sign-in link all read from here.
 *
 * The rules mirror `src-tauri/src/open_url.rs::validated`, which is the last
 * gate on the Rust side and rejects anything this accepts by mistake. Keeping
 * the two in step is the point: a URL the frontend renders as a link must be a
 * URL Rust will open, or the user gets a link that silently does nothing.
 */

/** Schemes that may be handed to the OS browser. `open_url.rs` accepts these
 * and nothing else, so widening this list alone changes nothing. */
export const ALLOWED_OPEN_SCHEMES = ["https:"] as const;

/** Mirrors `MAX_URL_LEN` in `open_url.rs`. */
export const MAX_EXTERNAL_URL_LEN = 2048;

/**
 * Whether `value` carries whitespace or a C0/C1 control, both of which
 * `open_url.rs` rejects outright.
 *
 * Checked against the raw string, before `URL` gets a chance to percent-encode
 * them into something that would pass. Written as a codepoint scan rather than
 * a regex: a control-character class in a literal is exactly what a linter is
 * meant to flag, and the intent reads better spelled out.
 */
function hasUnsafeChars(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (/\s/.test(character)) return true;
  }
  return false;
}

/**
 * Parses `value` if it is a URL the app may open, and returns `null` otherwise.
 *
 * The returned `URL` is normalized (punycoded host, percent-encoded path), so
 * callers should hand `.href` to both the anchor and `openExternalUrl` rather
 * than the caller's original string — the normalized form is what Rust sees.
 */
export function safeExternalUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_EXTERNAL_URL_LEN) return null;
  if (hasUnsafeChars(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!(ALLOWED_OPEN_SCHEMES as readonly string[]).includes(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  // `new URL` accepts credentials in the authority (`https://user:pass@host`),
  // which renders as a host the reader does not recognize. Nothing the app
  // links to needs them.
  if (parsed.username || parsed.password) return null;
  return parsed;
}

/** The normalized href when the app may open `value`, `null` otherwise. */
export function safeExternalHref(value: unknown): string | null {
  return safeExternalUrl(value)?.href ?? null;
}

/** Whether the app may open `value`. */
export function isSafeExternalUrl(value: unknown): boolean {
  return safeExternalUrl(value) !== null;
}
