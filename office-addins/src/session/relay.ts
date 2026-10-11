/**
 * The sign-in window's relay (ADR-0102, addendum of 2026-10-10).
 *
 * The window runs on the office origin with Office.js, which it needs for
 * `messageParent` and the pane's messages. It holds no session: the account
 * origin's courier frame it embeds does (`website/src/office/courier-frame.ts`).
 * The relay passes the pane's requests to that frame and the frame's answers
 * back to the pane, and checks both ends:
 *
 * - from the pane, Office's `DialogParentMessageReceived`, from the pane's own
 *   origin, and only `request` messages;
 * - from the frame, `message` events whose origin is the account origin and
 *   whose source is the frame this window embeds, and only `ready`,
 *   `signed-out` and `response` messages.
 *
 * Everything is parsed and written again (`parseMessage`), never forwarded raw.
 */
import {
  type CourierMessage,
  type CourierRequest,
  parseMessage,
} from "../../../website/src/lib/office-courier";
import type { OfficeGlobal } from "../office";

export type RelayState =
  | { kind: "signed-out" }
  | { kind: "carrying"; account: { id: string; email: string } }
  | { kind: "unavailable" };

export interface RelayDeps {
  office: OfficeGlobal;
  /** The courier frame's window, once the frame exists. */
  courier(): MessageEventSource | null;
  /** Where the courier frame's messages arrive: this window. */
  target: Pick<Window, "addEventListener" | "removeEventListener">;
  accountOrigin: string;
  /** The pane's origin: the office origin, this window's own. */
  paneOrigin: string;
  onState(state: RelayState): void;
  /** How long the frame has to say who is signed in. */
  timeoutMs?: number;
  /** How often the window asks again until it does. */
  helloEveryMs?: number;
}

/** Starts relaying; `hello` asks the frame again (on its `load`), `stop` ends it. */
export function startRelay(deps: RelayDeps): { hello(): void; stop(): void } {
  const { office, accountOrigin } = deps;
  let live = true;
  let settled = false;
  let asking: ReturnType<typeof setInterval> | undefined;
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const toPane = (message: CourierMessage) => {
    try {
      office.context.ui.messageParent(JSON.stringify(message));
    } catch {
      // Opened outside an Office dialog: there is no pane to answer.
    }
  };
  const toCourier = (message: CourierRequest | { v: 1; type: "hello" }) => {
    const frame = deps.courier() as Window | null;
    frame?.postMessage(JSON.stringify(message), accountOrigin);
  };
  const hello = () => {
    if (live && !settled) toCourier({ v: 1, type: "hello" });
  };

  const fromPane = (arg: { message: string; origin?: string }) => {
    if (!live) return;
    if (arg.origin && arg.origin !== deps.paneOrigin) return;
    const message = parseMessage(arg.message);
    if (message?.type === "request") toCourier(message);
  };

  const fromCourier = (event: MessageEvent) => {
    if (!live) return;
    const frame = deps.courier();
    if (event.origin !== accountOrigin || !frame || event.source !== frame) return;
    const message = parseMessage(event.data);
    if (!message) return;
    if (message.type === "response") {
      if (settled) toPane(message);
      return;
    }
    if (settled || (message.type !== "ready" && message.type !== "signed-out")) return;
    settled = true;
    clearInterval(asking);
    clearTimeout(giveUp);
    if (message.type === "signed-out") {
      deps.onState({ kind: "signed-out" });
      toPane(message);
      return;
    }
    const account = message.account;
    office.context.ui.addHandlerAsync(
      office.EventType.DialogParentMessageReceived,
      fromPane,
      () => {
        if (!live) return;
        deps.onState({ kind: "carrying", account });
        toPane({ v: 1, type: "ready", account });
      },
    );
  };

  deps.target.addEventListener("message", fromCourier as EventListener);
  asking = setInterval(hello, deps.helloEveryMs ?? 1000);
  giveUp = setTimeout(() => {
    if (!live || settled) return;
    settled = true;
    clearInterval(asking);
    deps.onState({ kind: "unavailable" });
  }, deps.timeoutMs ?? 15_000);
  return {
    hello,
    stop() {
      live = false;
      clearInterval(asking);
      clearTimeout(giveUp);
      deps.target.removeEventListener("message", fromCourier as EventListener);
    },
  };
}
