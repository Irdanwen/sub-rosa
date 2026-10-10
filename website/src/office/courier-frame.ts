/**
 * The courier frame (ADR-0102, addendum of 2026-10-10): the account origin's
 * `/office/courier.html`, embedded by the Office sign-in window. It runs no
 * Office.js and shows nothing. It answers its parent only when the parent is
 * the office origin, and carries exactly the calls `office-courier.ts`
 * allows, with this origin's cookie and CSRF token.
 */
import { type CourierMessage, carry, csrfFromCookie, parseMessage } from "../lib/office-courier";

/** The window's parts the frame uses, so a test can stand in for them. */
export interface FrameMessenger {
  postMessage(message: string, targetOrigin: string): void;
}
export interface CourierFrameDeps {
  /** Where messages arrive: the frame's own window. */
  self: Pick<Window, "addEventListener" | "removeEventListener">;
  /** The window that embeds the frame, or null when it is not framed. */
  parent: FrameMessenger | null;
  /** The only origin the frame answers. */
  officeOrigin: string;
  fetch: typeof fetch;
  cookie(): string;
}

/** Who is signed in on this origin, as the window is told. */
async function whoIsSignedIn(fetcher: typeof fetch): Promise<CourierMessage> {
  try {
    const response = await fetcher("/api/v1/me", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) {
      const body = (await response.json()) as { data?: { id?: unknown; email?: unknown } };
      const { id, email } = body.data ?? {};
      if (typeof id === "string" && typeof email === "string")
        return { v: 1, type: "ready", account: { id, email } };
    }
  } catch {
    // Unreachable or not JSON: the window offers to sign in.
  }
  return { v: 1, type: "signed-out" };
}

/** Starts answering the window; returns what stops it. */
export function startCourierFrame(deps: CourierFrameDeps): () => void {
  const { parent, officeOrigin } = deps;
  // Opened on its own (not framed), it has nobody to carry for.
  if (!parent) return () => undefined;
  const post = (message: CourierMessage) =>
    parent.postMessage(JSON.stringify(message), officeOrigin);
  let state: Promise<CourierMessage> | null = null;
  const listener = (event: MessageEvent) => {
    // The office origin's window that embeds this frame, and nobody else:
    // not another frame of that window, not a page of another origin.
    if (event.origin !== officeOrigin || event.source !== parent) return;
    const message = parseMessage(event.data);
    if (message?.type === "hello") {
      state ??= whoIsSignedIn(deps.fetch);
      void state.then(post);
    } else if (message?.type === "request") {
      void carry(
        { fetch: deps.fetch, csrf: () => csrfFromCookie(deps.cookie()), reply: post },
        message,
      );
    }
  };
  deps.self.addEventListener("message", listener as EventListener);
  return () => deps.self.removeEventListener("message", listener as EventListener);
}
