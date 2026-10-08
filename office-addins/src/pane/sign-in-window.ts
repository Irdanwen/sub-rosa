/**
 * Opens the sign-in window (`/office/session.html`) with Office's dialog API
 * and, once it says who is signed in, routes the account service's calls
 * through it (`courier.ts`, ADR-0102). Closing the window, by the person or by
 * `close`, puts the page's own `fetch` back.
 */
import { type Account, setAccountScope, setApiTransport } from "../../../website/src/lib/api";
import { type OfficeDialog, type OfficeGlobal, supports } from "../office";
import { courierTransport, parseMessage } from "../session/courier";

export const SIGN_IN_PATH = "/office/session.html";

export interface SignInWindow {
  account: Account;
  close(): void;
}

export class SignInWindowError extends Error {
  constructor(public code: "unsupported" | "blocked" | "closed") {
    super(code);
  }
}

/**
 * Resolves when the window has a signed-in account; rejects if it cannot open
 * or is closed first. `onClosed` runs whenever the window goes away later.
 */
export function openSignInWindow(
  office: OfficeGlobal,
  options: { fresh?: boolean; onClosed?: () => void } = {},
  origin = location.origin,
): Promise<SignInWindow> {
  // Messages to the window (`messageChild`) need DialogApi 1.2.
  if (!supports(office, "DialogApi", "1.2"))
    return Promise.reject(new SignInWindowError("unsupported"));
  const url = `${origin}${SIGN_IN_PATH}${options.fresh ? "?fresh=1" : ""}`;
  return new Promise<SignInWindow>((resolve, reject) => {
    office.context.ui.displayDialogAsync(url, { height: 70, width: 35 }, (result) => {
      if (result.status !== "succeeded") {
        reject(new SignInWindowError("blocked"));
        return;
      }
      const dialog: OfficeDialog = result.value;
      const courier = courierTransport((message) =>
        dialog.messageChild(message, { targetOrigin: origin }),
      );
      let settled = false;
      let open = true;
      const shut = () => {
        if (!open) return;
        open = false;
        courier.closed();
        setApiTransport(null);
      };
      dialog.addEventHandler(office.EventType.DialogMessageReceived, (arg) => {
        // Only the account origin's own page speaks for the session.
        if (arg.origin && arg.origin !== origin) return;
        const message = parseMessage(arg.message);
        if (!message) return;
        if (message.type === "response") courier.receive(message);
        else if (message.type === "ready" && !settled) {
          settled = true;
          setApiTransport(courier.transport);
          setAccountScope(message.account.id);
          resolve({
            account: { ...message.account, created_at: "" },
            close: () => {
              shut();
              try {
                dialog.close();
              } catch {
                // Already closed by the person.
              }
            },
          });
        }
      });
      dialog.addEventHandler(office.EventType.DialogEventReceived, () => {
        shut();
        if (!settled) {
          settled = true;
          reject(new SignInWindowError("closed"));
        }
        options.onClosed?.();
      });
    });
  });
}
